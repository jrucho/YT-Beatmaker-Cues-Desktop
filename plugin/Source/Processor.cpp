#include "Processor.h"
#include "Editor.h"
#include "WebEditor.h"
#include "TrackResolver.h"
#if JUCE_MAC || JUCE_IOS
#include "AppleHttp.h"
#endif
#include <cmath>

namespace {
juce::AudioProcessorValueTreeState::ParameterLayout parameterLayout() {
    juce::AudioProcessorValueTreeState::ParameterLayout layout;
    layout.add(std::make_unique<juce::AudioParameterFloat>(juce::ParameterID{"gain", 1}, "Output", 0.0f, 1.0f, 0.8f));
    layout.add(std::make_unique<juce::AudioParameterFloat>(juce::ParameterID{"speed", 1}, "Varispeed", 0.25f, 2.0f, 1.0f));
    return layout;
}
constexpr int rolandNotes[] = {48,49,50,51,44,45,46,47,40,41,42,43,36,37,38,39};

std::unique_ptr<juce::AudioFormatReader> mediaReader(juce::AudioFormatManager& formats,const juce::File& input,juce::String& error,const std::function<bool()>& cancelled={}){
    std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(input));
    if(reader)return reader;
   #if JUCE_LINUX || JUCE_WINDOWS
    const auto directory=LibraryStore::defaultDirectory().getChildFile("Decoded");directory.createDirectory();
    const auto decoded=directory.getChildFile(juce::String::toHexString((input.getFullPathName()+juce::String(input.getSize())+juce::String(input.getLastModificationTime().toMilliseconds())).hashCode64())+".wav");
    if(decoded.existsAsFile())return std::unique_ptr<juce::AudioFormatReader>(formats.createReaderFor(decoded));
    const auto temporary=decoded.getSiblingFile(decoded.getFileName()+"-"+juce::Uuid().toString()+".partial");
    juce::ChildProcess process;
    if(!process.start(juce::StringArray{"ffmpeg","-nostdin","-v","error","-y","-i",input.getFullPathName(),"-vn","-ac","2","-ar","48000","-f","wav",temporary.getFullPathName()})){
        error="Cannot decode this format. Install FFmpeg for AAC/M4A support.";return {};
    }
    const auto deadline=juce::Time::getMillisecondCounter()+60000;
    while(!process.waitForProcessToFinish(50))if((cancelled&&cancelled())||juce::Time::getMillisecondCounter()>deadline){process.kill();temporary.deleteFile();error="Audio decoding cancelled or timed out";return {};}
    if(process.getExitCode()!=0||!temporary.moveFileTo(decoded)){temporary.deleteFile();error="Cannot decode audio with FFmpeg";return {};}
    reader.reset(formats.createReaderFor(decoded));
   #endif
    return reader;
}
}

CueProcessor::CueProcessor()
    : AudioProcessor(BusesProperties().withOutput("Stereo", juce::AudioChannelSet::stereo(), true)),
      parameters(*this, nullptr, "Parameters", parameterLayout()) {
    for (auto& bank : cues) for (auto& cue : bank) cue.store(-1);
    gainValue=parameters.getRawParameterValue("gain");speedValue=parameters.getRawParameterValue("speed");
    sessionId=wrapperType==wrapperType_Standalone||wrapperType==wrapperType_Undefined?"standalone":juce::Uuid().toString();
    setLatencySamples(0);
    queueThread=std::thread([this]{runQueue();});
}

CueProcessor::~CueProcessor() {
    stopQueue.store(true);++queueGeneration;
    ++loadGeneration;
    if(queueThread.joinable())queueThread.join();
    loaders.removeAllJobs(true, -1);
    networkWorkers.removeAllJobs(true,-1);
}

bool CueProcessor::isBusesLayoutSupported(const BusesLayout& layout) const {
    const auto output = layout.getMainOutputChannelSet();
    return layout.getMainInputChannelSet().isDisabled()
        && (output == juce::AudioChannelSet::mono() || output == juce::AudioChannelSet::stereo());
}

void CueProcessor::prepareToPlay(double rate, int maximumBlock) {
    hostRate = rate > 0 ? rate : 44100;
    fadeLength = juce::jmax(2, (int) std::round(hostRate * 0.003));
    fadeRemaining = 0;
    lastVoice.fill(0);fadeOrigin.fill(0);
    cueFade.resize((size_t)fadeLength);
    for(int i=0;i<fadeLength;++i)cueFade[(size_t)i]=0.5f-0.5f*std::cos(juce::MathConstants<float>::pi*i/(float)(fadeLength-1));
    outputGain.reset(hostRate, 0.01);
    outputGain.setCurrentAndTargetValue(gainValue->load());
    stretch.configure(2,juce::jmax(256,(int)(hostRate*0.04)),juce::jmax(64,(int)(hostRate*0.01)),false);
    stretchBlock=juce::jmax(512,maximumBlock);
    stretchInput.setSize(2,juce::jmax(stretchBlock*4+16,stretch.outputSeekLength(4.0f)+16));
    stretchOutput.setSize(2,stretchBlock);
    stretchSeek=true;stretchWasActive=false;stretchFraction=0;
}

bool CueProcessor::submit(Command command) {
    int start1, size1, start2, size2;
    commands.prepareToWrite(1, start1, size1, start2, size2);
    if (size1 == 0) { ++droppedCommands; return false; }
    commandData[(size_t) start1] = command;
    commands.finishedWrite(1);
    return true;
}

CueProcessor::Target CueProcessor::mapNote(int mode, int channel, int note, int bank) {
    if (channel < 1 || channel > 16 || note < 0 || note > 127) return {};
    if (mode == 2) return note >= 36 && note <= 47 ? Target{juce::jlimit(0, 9, bank), note - 36} : Target{};
    if (mode == 0) {
        if (channel > 10) return {};
        for (int i = 0; i < 16; ++i) if (rolandNotes[i] == note) return {channel - 1, i};
    }
    if (mode == 1 && channel <= 2 && note >= 12 && note <= 91) {
        const int group = (note - 12) / 16;
        const int offset = (note - 12) % 16;
        for (int i = 0; i < 16; ++i)
            if (rolandNotes[i] - 36 == offset) return {(channel - 1) * 5 + group, i};
    }
    return {};
}

void CueProcessor::handleMidi(const juce::MidiMessage& message) {
    if (message.isAllSoundOff() || message.isAllNotesOff()) {
        for(auto& state:padStates)state.fetch_and(~1u,std::memory_order_relaxed);
        playing.store(false);requestedPlay.store(false); fadeRemaining = 0; return;
    }
    const int mode = preset.load();
    Target target;
    if (message.isNoteOn() || message.isNoteOff())
        target = mapNote(mode, message.getChannel(), message.getNoteNumber(), selectedBank.load());
    else if (message.isController() && mode != 1 && message.getControllerNumber() >= 20
             && message.getControllerNumber() < 20 + padCount())
        target = {mode == 2 ? selectedBank.load() : message.getChannel() - 1, message.getControllerNumber() - 20};
    if (target.bank < 0 || target.bank >= 10 || target.pad < 0) return;
    if (message.isNoteOff() || (message.isController() && message.getControllerValue() == 0)) {
        padEvent(target.bank,target.pad,false,false,0);
        if (activePad.load() == target.bank * 16 + target.pad) activePad.store(-1);
        return; // Cues are one-shot; release does not truncate the track.
    }
    selectedBank.store(target.bank);
    padEvent(target.bank,target.pad,true,false,message.isNoteOn()?message.getFloatVelocity():1.0f);
    hit(target.bank, target.pad, overwrite.load(), message.isNoteOn() ? message.getFloatVelocity() : 1.0f);
}

void CueProcessor::hit(int bank, int pad, bool replace, float velocity) {
    if (current == nullptr || bank < 0 || bank >= 10 || pad < 0 || pad >= padCount()) return;
    auto& cue = cues[(size_t) bank][(size_t) pad];
    activePad.store(bank * 16 + pad);
    padEvent(bank,pad,true,true,velocity);
    if (replace || cue.load() < 0) {cue.store(position / current->rate);++cueRevision;}
    else jump(cue.load(), velocity);
}

void CueProcessor::padEvent(int bank,int pad,bool down,bool triggered,float velocity){
    if(bank<0||bank>=10||pad<0||pad>=16)return;
    const auto index=(size_t)(bank*16+pad);
    if(down)padStates[index].fetch_or(1u,std::memory_order_relaxed);else padStates[index].fetch_and(~1u,std::memory_order_relaxed);
    if(triggered)padStates[index].fetch_add(2u,std::memory_order_relaxed);
    padVelocities[index].store(juce::jlimit(0,127,(int)(velocity*127)),std::memory_order_relaxed);
}

void CueProcessor::jump(double seconds, float velocity) {
    if (current == nullptr || !std::isfinite(seconds)) return;
    const double target = juce::jlimit(0.0, (double) current->audio.getNumSamples() - 1, seconds * current->rate);
    for(int c=0;c<2;++c)fadeOrigin[(size_t)c]=playing.load()?lastVoice[(size_t)c]:0.0f;
    position = target;
    velocityGain = velocity;
    fadeRemaining = fadeLength;
    stretchSeek=true;
    if (loopEnabled.load() && (seconds < loopIn.load() || seconds >= loopOut.load())) loopEnabled.store(false);
    playing.store(true);
    requestedPlay.store(true);
}

void CueProcessor::execute(const Command& command) {
    switch (command.action) {
        case Action::pad: hit(command.bank, command.pad, command.overwrite, 1.0f); break;
        case Action::markNext:
            if (current == nullptr) break;
            for (int bank = selectedBank.load(); bank < 10; ++bank) {
                for (int pad = 0; pad < padCount(); ++pad) {
                    if (cues[(size_t) bank][(size_t) pad].load() < 0) {
                        selectedBank.store(bank);
                        cues[(size_t) bank][(size_t) pad].store(position / current->rate);
                        padEvent(bank,pad,false,true,1.0f);
                        ++cueRevision;
                        return;
                    }
                }
            }
            break;
        case Action::play:
            if (current && !playing.load()) jump(position >= current->audio.getNumSamples() - 1 ? 0 : position / current->rate, 1.0f);
            break;
        case Action::cue: jump(command.value,1.0f);if(current)padEvent(command.bank,command.pad,false,true,1.0f);break;
        case Action::pause: requestedPlay.store(false);playing.store(false); fadeRemaining = 0; break;
        case Action::seek:
            if (current) {
                const bool wasPlaying = playing.load();
                const bool wanted=requestedPlay.load();
                jump(command.value, 1.0f);
                playing.store(wasPlaying);
                requestedPlay.store(wanted);
            }
            break;
        case Action::clearBank:
            if (command.bank >= 0 && command.bank < 10)
                for (auto& cue : cues[(size_t) command.bank]) cue.store(-1);
            break;
        case Action::setIn: loopIn.store(current ? position / current->rate : -1); break;
        case Action::setOut: loopOut.store(current ? position / current->rate : -1); break;
        case Action::toggleLoop:
            loopEnabled.store(!loopEnabled.load() && loopIn.load() >= 0 && loopOut.load() > loopIn.load());
            break;
    }
}

float CueProcessor::read(double at, int channel) const {
    if (!current || at < 0 || at >= current->audio.getNumSamples()) return 0;
    const int index = (int) at, next = juce::jmin(index + 1, current->audio.getNumSamples() - 1);
    const float fraction = (float) (at - index);
    const float* source = current->audio.getReadPointer(juce::jmin(channel, current->audio.getNumChannels() - 1));
    return source[index] + fraction * (source[next] - source[index]);
}

void CueProcessor::render(juce::AudioBuffer<float>& buffer, int start, int count) {
    if (!current || !playing.load()) return;
    const float speed=speedValue->load();
    const bool useStretch=preservePitch.load()&&(std::abs(speed-1.0f)>0.0001f||std::abs(semitones.load())>0.001f);
    if(useStretch) {
        if(!stretchWasActive){stretchSeek=true;fadeOrigin=lastVoice;fadeRemaining=fadeLength;}
        stretchWasActive=true;
        stretch.setTransposeSemitones(semitones.load());
        const double sourceStep=current->rate/hostRate;
        if(stretchSeek) {
            const int preload=stretch.outputSeekLength(speed);
            const double begin=position-stretch.inputLatency()*sourceStep;
            for(int c=0;c<2;++c)for(int i=0;i<preload;++i)stretchInput.setSample(c,i,read(begin+i*sourceStep,c));
            stretch.outputSeek(stretchInput.getArrayOfReadPointers(),preload);
            stretchSeek=false;stretchFraction=0;
        }
        int offset=0;
        while(offset<count&&playing.load()) {
            int frames=juce::jmin(stretchBlock,count-offset);
            if(loopEnabled.load()) {
                const auto remaining=(loopOut.load()*current->rate-position)/(sourceStep*speed);
                if(remaining<=0){const auto target=loopIn.load();jump(target,velocityGain);loopEnabled.store(true);render(buffer,start+offset,count-offset);return;}
                frames=juce::jmin(frames,juce::jmax(1,(int)std::ceil(remaining)));
            }
            const double exact=frames*speed+stretchFraction;
            const int inputFrames=(int)exact;stretchFraction=exact-inputFrames;
            for(int c=0;c<2;++c)for(int i=0;i<inputFrames;++i)stretchInput.setSample(c,i,read(position+i*sourceStep,c));
            stretch.process(stretchInput.getArrayOfReadPointers(),inputFrames,stretchOutput.getArrayOfWritePointers(),frames);
            for(int i=0;i<frames;++i) {
                const float incoming=cueFadeIn();
                const float outgoing=1.0f-incoming;
                const float gain=outputGain.getNextValue()*(muted.load()?0.0f:1.0f);
                for(int c=0;c<buffer.getNumChannels();++c){
                    const float voice=stretchOutput.getSample(c,i)*incoming*velocityGain+fadeOrigin[(size_t)c]*outgoing;
                    lastVoice[(size_t)c]=voice;
                    buffer.setSample(c,start+offset+i,gain*voice);
                }
                if(fadeRemaining>0)--fadeRemaining;
            }
            position+=inputFrames*sourceStep;offset+=frames;
            if(position>=current->audio.getNumSamples()){playing.store(false);needAdvance.store(true);}
        }
        return;
    }
    if(stretchWasActive){fadeOrigin=lastVoice;fadeRemaining=fadeLength;}
    stretchWasActive=false;
    const double step = current->rate / hostRate * speedValue->load();
    const double end = current->audio.getNumSamples();
    for (int frame = start; frame < start + count; ++frame) {
        if (loopEnabled.load() && position / current->rate >= loopOut.load()) {
            const double target = loopIn.load();
            jump(target, velocityGain);
            loopEnabled.store(true);
        }
        if (position >= end) { playing.store(false);needAdvance.store(true); break; }
        const float incoming = cueFadeIn();
        const float outgoing = 1.0f-incoming;
        const float gain = outputGain.getNextValue() * (muted.load() ? 0.0f : 1.0f);
        const float endFade = (float) juce::jlimit(0.0, 1.0, (end - position) / (step * fadeLength));
        for (int channel = 0; channel < buffer.getNumChannels(); ++channel) {
            const float voice=read(position, channel)*incoming*velocityGain*endFade+fadeOrigin[(size_t)channel]*outgoing;
            lastVoice[(size_t)channel]=voice;
            buffer.setSample(channel,frame,gain*voice);
        }
        position += step;
        if (fadeRemaining > 0) --fadeRemaining;
    }
}

void CueProcessor::processBlock(juce::AudioBuffer<float>& output, juce::MidiBuffer& midi) {
    juce::ScopedNoDenormals noDenormals;
    output.clear();
    Sample* next;
    do { next = published.load(); audioHazard.store(next); } while (next != published.load());
    if (next != current) {
        current = next;
        position = current ? juce::jlimit(0.0, (double) current->audio.getNumSamples() - 1, restorePosition.load() * current->rate) : 0;
        playing.store(false); fadeRemaining = 0;
        lastVoice.fill(0);fadeOrigin.fill(0);
        stretchSeek=true;
        ready.store(current != nullptr);
        if (current && requestedPlay.load()) jump(position / current->rate, 1.0f);
    }
    outputGain.setTargetValue(gainValue->load());
    if(restartAtZero.exchange(false))jump(0,1.0f);
    int first, count1, second, count2;
    commands.prepareToRead(commands.getNumReady(), first, count1, second, count2);
    for (int i = 0; i < count1; ++i) execute(commandData[(size_t) (first + i)]);
    for (int i = 0; i < count2; ++i) execute(commandData[(size_t) (second + i)]);
    commands.finishedRead(count1 + count2);
    int rendered = 0;
    for (const auto metadata : midi) {
        const int offset = juce::jlimit(rendered, output.getNumSamples(), metadata.samplePosition);
        render(output, rendered, offset - rendered);
        if(metadata.numBytes<=3)handleMidi(metadata.getMessage()); // Ignore unsupported SysEx without allocating a copied message.
        rendered = offset;
    }
    render(output, rendered, output.getNumSamples() - rendered);
    playhead.store(current ? position / current->rate : 0);
    midi.clear();
}

void CueProcessor::publish(std::unique_ptr<Sample> sample, int generation, bool preserveCues) {
    std::lock_guard<std::mutex> lock(metadataMutex);
    if (generation != loadGeneration.load()) return;
    if (!preserveCues) {
        for (auto& bank : cues) for (auto& cue : bank) cue.store(-1);
        restorePosition.store(0); loopIn.store(-1); loopOut.store(-1); loopEnabled.store(false);
    }
    samplePath = sample->path;
    status = samplePath == "demo:" ? "Demo loaded · 60 seconds" : juce::File(samplePath).getFileName();
    auto* pointer = sample.get();
    retained.push_back(std::move(sample));
    published.store(pointer);
    durationSeconds.store(pointer->audio.getNumSamples()/pointer->rate);
    nativeAdvancing.store(false);
    const auto* inUse = audioHazard.load();
    retained.erase(std::remove_if(retained.begin(), retained.end(), [pointer, inUse](const auto& item) {
        return item.get() != pointer && item.get() != inUse;
    }), retained.end());
}

void CueProcessor::loadFile(const juce::File& input, bool preserveCues) {
    const int generation = ++loadGeneration;
    { std::lock_guard<std::mutex> lock(metadataMutex); status = "Loading " + input.getFileName() + "…"; }
    loaders.addJob([this, input, preserveCues, generation] {
        juce::File file = input;
       #if JUCE_IOS
        // Keep an extension-owned copy; document picker access is not a durable DAW session path.
        const auto directory = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("BeatmakerCues/Media");
        directory.createDirectory();
        const auto local = directory.getChildFile(juce::Uuid().toString() + "." + input.getFileExtension().substring(1));
        const auto cache=juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("BeatmakerCuesPrototype/Media");
        if (!input.isAChildOf(directory)&&!input.isAChildOf(cache)&&input.copyFileTo(local)) file = local;
       #endif
        juce::AudioFormatManager formats;
        formats.registerBasicFormats();
        juce::String error;
        auto reader=mediaReader(formats,file,error,[this,generation]{return generation!=loadGeneration.load();});
        if (!reader) error = error.isNotEmpty()?error:"Cannot open audio. Try WAV, AIFF, FLAC or MP3.";
        else if (reader->numChannels<1 || reader->lengthInSamples < 2 || reader->sampleRate <= 0
                 || reader->lengthInSamples > 24 * 1024 * 1024) error = "Audio must fit in 192 MB decoded stereo memory.";
        else {
            auto sample = std::make_unique<Sample>();
            sample->rate = reader->sampleRate;
            sample->path = file.getFullPathName();
            sample->audio.setSize(juce::jmin(2, (int) reader->numChannels), (int) reader->lengthInSamples);
            if (reader->read(&sample->audio, 0, sample->audio.getNumSamples(), 0, true, true)) {
                publish(std::move(sample), generation, preserveCues);
                return;
            }
            error = "Audio decoding failed.";
        }
        const auto cacheFolder=juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("BeatmakerCuesPrototype/Media");
        if(error=="Audio decoding failed."&&file.isAChildOf(cacheFolder)&&file.getFileName().startsWith("song-")&&generation==loadGeneration.load())file.deleteFile();
        std::lock_guard<std::mutex> lock(metadataMutex);
        if (generation == loadGeneration.load()) status = error;
    });
}

void CueProcessor::loadDemo(bool preserveCues) {
    const int generation = ++loadGeneration;
    loaders.addJob([this, generation, preserveCues] {
        auto sample = std::make_unique<Sample>();
        sample->rate = 48000;
        sample->path = "demo:";
        sample->audio.setSize(2, 60 * 48000);
        for (int i = 0; i < sample->audio.getNumSamples(); ++i) {
            const double t = i / sample->rate;
            const float hit = (float) (std::exp(-std::fmod(t, 0.5) * 18) * std::sin(juce::MathConstants<double>::twoPi * 70 * t));
            const float tone = (float) (0.12 * std::sin(juce::MathConstants<double>::twoPi * 220 * t));
            sample->audio.setSample(0, i, hit * 0.55f + tone);
            sample->audio.setSample(1, i, hit * 0.55f - tone);
        }
        publish(std::move(sample), generation, preserveCues);
    });
}

void CueProcessor::loadFromApp(const juce::String& videoId, int port) {
    if (videoId.length() != 11 || !videoId.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")) {
        std::lock_guard<std::mutex> lock(metadataMutex); status = "Enter an 11-character YouTube video ID or a watch URL."; return;
    }
    const int generation = ++loadGeneration;
    { std::lock_guard<std::mutex> lock(metadataMutex); status = "Importing from the running desktop app…"; }
    loaders.addJob([this, videoId, port, generation] {
        int statusCode = 0;
        const juce::URL url("http://127.0.0.1:" + juce::String(juce::jlimit(1024, 65535, port)) + "/api/stream/" + videoId + "/audio");
        auto stream = url.createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
            .withConnectionTimeoutMs(10000).withStatusCode(&statusCode).withNumRedirectsToFollow(0));
        juce::String error = "Start Beatmaker Cues Desktop and check its local port (normally 4280).";
        const auto folder = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("BeatmakerCuesPrototype/Media");
        folder.createDirectory();
        const auto file = folder.getChildFile(videoId + "-" + juce::Uuid().toString() + ".m4a");
        if (stream && statusCode == 200) {
            auto output = file.createOutputStream();
            if (output) {
                std::array<char, 32768> block;
                juce::int64 total = 0;
                while (!stream->isExhausted() && generation == loadGeneration.load()) {
                    const int bytes = stream->read(block.data(), (int) block.size());
                    if (bytes <= 0) break;
                    total += bytes;
                    if (total > 64 * 1024 * 1024 || !output->write(block.data(), (size_t) bytes)) break;
                }
                output->flush(); output.reset();
                const auto expected = stream->getTotalLength();
                if (generation == loadGeneration.load() && total > 0 && total <= 64 * 1024 * 1024
                    && stream->isExhausted() && (expected <= 0 || total == expected)) {
                    loadFile(file);
                    return;
                }
                error = "Import interrupted or exceeds the 64 MB encoded-audio limit.";
            }
        }
        file.deleteFile();
        std::lock_guard<std::mutex> lock(metadataMutex);
        if (generation == loadGeneration.load()) status = error;
    });
}

void CueProcessor::installSampleForTest(std::unique_ptr<Sample> sample) { publish(std::move(sample), ++loadGeneration, false); }
juce::String CueProcessor::getStatus() const { std::lock_guard<std::mutex> lock(metadataMutex); return status; }
double CueProcessor::getDuration() const {return durationSeconds.load();}

void CueProcessor::getStateInformation(juce::MemoryBlock& destination) {
    juce::XmlElement state("BeatmakerCuesPrototype");
    state.setAttribute("version", 1);
    state.setAttribute("sessionId",getSessionId());
    const auto legacy=getLegacyState();if(legacy.isNotEmpty())state.createNewChildElement("LegacyUI")->addTextElement(legacy);
    {std::lock_guard<std::mutex> lock(metadataMutex);if(nativeQueue.isObject()){
        auto queue=nativeQueue.clone();queue.getDynamicObject()->setProperty("index",nativeIndex.load());
        state.createNewChildElement("NativeQueue")->addTextElement(juce::JSON::toString(queue));
    }}
    auto ui=juce::JSON::parse(sessionUiState());
    if(auto* storage=ui.getDynamicObject()) {
        auto savedPlayer=juce::JSON::parse(storage->getProperty("musike:player").toString());
        if(auto* player=savedPlayer.getDynamicObject()){player->setProperty("position",playhead.load());if(nativeSnapshot().hasProperty("trackId"))player->setProperty("index",nativeIndex.load());storage->setProperty("musike:player",juce::JSON::toString(savedPlayer));}
    }
    state.createNewChildElement("MobileUI")->addTextElement(juce::JSON::toString(ui));
    { std::lock_guard<std::mutex> lock(metadataMutex); state.setAttribute("file",ready.load()&&!nativeAdvancing.load()?samplePath:juce::String{}); }
    state.setAttribute("bank", selectedBank.load()); state.setAttribute("preset", preset.load());
    state.setAttribute("position", playhead.load()); state.setAttribute("overwrite", overwrite.load());
    state.setAttribute("in", loopIn.load()); state.setAttribute("out", loopOut.load());
    state.setAttribute("loop", loopEnabled.load());
    state.setAttribute("muted",muted.load());
    state.setAttribute("preservePitch",preservePitch.load());state.setAttribute("semitones",semitones.load());
    state.addChildElement(parameters.copyState().createXml().release());
    for (int bank = 0; bank < 10; ++bank) for (int pad = 0; pad < 16; ++pad) {
        if (getCue(bank, pad) < 0) continue;
        auto* cue = state.createNewChildElement("Cue");
        cue->setAttribute("bank", bank); cue->setAttribute("pad", pad); cue->setAttribute("time", getCue(bank, pad));
    }
    copyXmlToBinary(state, destination);
}

void CueProcessor::setStateInformation(const void* data, int size) {
    if (size <= 0 || size > 32 * 1024 * 1024) return;
    auto state = getXmlFromBinary(data, size);
    if (!state || !state->hasTagName("BeatmakerCuesPrototype") || state->getIntAttribute("version") != 1) return;
    hostRestored.store(true);
    {std::lock_guard<std::mutex> lock(metadataMutex);const auto saved=state->getStringAttribute("sessionId");if(saved.isNotEmpty()&&saved.length()<80&&saved.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"))sessionId=saved;}
    if(const auto* legacy=state->getChildByName("LegacyUI")){std::lock_guard<std::mutex> lock(metadataMutex);legacyState=legacy->getAllSubText();}
    playing.store(false);requestedPlay.store(false);needAdvance.store(false);nativeEnded.store(false);
    if(const auto* savedQueue=state->getChildByName("NativeQueue"))setNativeQueue(juce::JSON::parse(savedQueue->getAllSubText()));
    if (const auto* savedUi = state->getChildByName("MobileUI")) setWebState(savedUi->getAllSubText());
    selectedBank.store(juce::jlimit(0, 9, state->getIntAttribute("bank")));
    preset.store(juce::jlimit(0, 2, state->getIntAttribute("preset")));
    overwrite.store(state->getBoolAttribute("overwrite"));
    const auto savedPlayer=juce::JSON::parse(juce::JSON::parse(getWebState())["musike:player"].toString());
    muted.store(state->getBoolAttribute("muted",(bool)savedPlayer["muted"]));
    preservePitch.store(state->getBoolAttribute("preservePitch",true));semitones.store((float)juce::jlimit(-12.0,12.0,state->getDoubleAttribute("semitones")));
    const auto finite = [](double value, double fallback) { return std::isfinite(value) ? value : fallback; };
    restorePosition.store(juce::jmax(0.0, finite(state->getDoubleAttribute("position"), 0)));
    loopIn.store(finite(state->getDoubleAttribute("in", -1), -1));
    loopOut.store(finite(state->getDoubleAttribute("out", -1), -1));
    loopEnabled.store(state->getBoolAttribute("loop") && loopIn.load() >= 0 && loopOut.load() > loopIn.load());
    if (auto* saved = state->getChildByName("Parameters")) parameters.replaceState(juce::ValueTree::fromXml(*saved));
    for (auto& bank : cues) for (auto& cue : bank) cue.store(-1);
    for (auto* cue : state->getChildIterator()) {
        if (!cue->hasTagName("Cue")) continue;
        const int bank = cue->getIntAttribute("bank", -1), pad = cue->getIntAttribute("pad", -1);
        const double time = cue->getDoubleAttribute("time", -1);
        if (bank >= 0 && bank < 10 && pad >= 0 && pad < 16 && time >= 0 && std::isfinite(time)) cues[(size_t) bank][(size_t) pad].store(time);
    }
    const auto path = state->getStringAttribute("file");
    setWebState(sessionUiState());
    if (path == "demo:") loadDemo(true);
    else if (path.isNotEmpty()) loadFile(juce::File(path), true);
    restoreRevision.fetch_add(1);
}

juce::AudioProcessorEditor* CueProcessor::createEditor() { return new MobileWebEditor(*this); }

void CueProcessor::setWebState(const juce::String& state) {
    if (state.getNumBytesAsUTF8() > 16 * 1024 * 1024) return;
    auto parsed=juce::JSON::parse(state);
    {std::lock_guard<std::mutex> lock(metadataMutex);if(parsed.hasProperty("plugin-file:library.json"))legacyState=state;}
    if(auto* fields=parsed.getDynamicObject()){
        fields->removeProperty("plugin-file:library.json");fields->removeProperty("plugin-file:library.tmp.json");
    }
    std::lock_guard<std::mutex> lock(metadataMutex); webState = juce::JSON::toString(parsed);
}
juce::String CueProcessor::getWebState() const { std::lock_guard<std::mutex> lock(metadataMutex); return webState; }
juce::String CueProcessor::sessionUiState() const {
    const auto original=getWebState();auto state=juce::JSON::parse(original);if(!state.isObject())state=juce::var(new juce::DynamicObject);
    const auto native=getWebCues();auto id=native["trackId"].toString();
    if(original.length()<=2&&id.isEmpty()&&!hostRestored.load())return juce::JSON::toString(state);
    if(id.isEmpty()){
        const auto player=juce::JSON::parse(state["musike:player"].toString());const auto tracks=player["queue"];const int index=(int)player["index"];
        if(tracks.isArray()&&index>=0&&index<tracks.size())id=tracks[index]["id"].toString();
    }
    if(id.isNotEmpty()){
        auto all=juce::JSON::parse(state["musike:cues:v1"].toString());if(!all.isObject())all=juce::var(new juce::DynamicObject);
        all.getDynamicObject()->setProperty(juce::Identifier(id),native["cues"]);
        state.getDynamicObject()->setProperty("musike:cues:v1",juce::JSON::toString(all));
    }
    auto player=juce::JSON::parse(state["musike:player"].toString());
    if(hostRestored.load()&&!player.isObject())player=juce::var(new juce::DynamicObject);
    if(auto* fields=player.getDynamicObject()){
        fields->setProperty("position",nativeAdvancing.load()?0:playhead.load());
        if(nativeSnapshot().hasProperty("trackId"))fields->setProperty("index",nativeIndex.load());
        if(hostRestored.load()){
            fields->setProperty("volume",gainValue->load());fields->setProperty("speed",(speedValue->load()-1.0f)*100.0f);
            fields->setProperty("speedMode",preservePitch.load()?"speed":"pitch");fields->setProperty("tuning",semitones.load());fields->setProperty("muted",muted.load());
        }
        state.getDynamicObject()->setProperty("musike:player",juce::JSON::toString(player));
    }
    state.getDynamicObject()->setProperty("musike:cue-bank",juce::String::charToString((juce::juce_wchar)('A'+selectedBank.load())));
    return juce::JSON::toString(state);
}
void CueProcessor::setWebTrack(const juce::String& id) { std::lock_guard<std::mutex> lock(metadataMutex); webTrack = id; }
void CueProcessor::syncWebCues(const juce::var& data) {
    const auto bank = data["bank"].toString();
    if (bank.length() == 1) selectedBank.store(juce::jlimit(0, 9, (int) bank[0] - 'A'));
    const auto mapping = data["preset"].toString();
    preset.store(mapping == "legacy12" ? 2 : mapping == "sp404mkii-b" ? 1 : 0);
    setWebTrack(data["trackId"].toString());
    const auto saved = data["cues"];
    for (int b = 0; b < 10; ++b) for (int p = 0; p < 16; ++p) {
        const auto value = saved[juce::Identifier(juce::String::charToString((juce::juce_wchar) ('A' + b)))][juce::Identifier(juce::String(p + 1))];
        const auto time = value.isVoid() ? -1.0 : (double) value;
        cues[(size_t) b][(size_t) p].store(std::isfinite(time) ? time : -1);
    }
}
juce::var CueProcessor::getWebCues() const {
    auto result = std::make_unique<juce::DynamicObject>();
    { std::lock_guard<std::mutex> lock(metadataMutex);
        const auto tracks=nativeQueue["tracks"];const int index=nativeIndex.load();
        result->setProperty("trackId",tracks.isArray()&&index>=0&&index<tracks.size()?tracks[index]["id"].toString():webTrack);
    }
    result->setProperty("bank", juce::String::charToString((juce::juce_wchar) ('A' + selectedBank.load())));
    auto banks = std::make_unique<juce::DynamicObject>();
    for (int b = 0; b < 10; ++b) {
        auto pads = std::make_unique<juce::DynamicObject>();
        for (int p = 0; p < 16; ++p) if (getCue(b,p) >= 0) pads->setProperty(juce::Identifier(juce::String(p+1)), getCue(b,p));
        banks->setProperty(juce::Identifier(juce::String::charToString((juce::juce_wchar) ('A'+b))), juce::var(pads.release()));
    }
    result->setProperty("cues", juce::var(banks.release()));
    return juce::var(result.release());
}

void CueProcessor::loadRemote(const juce::String& link, double startAt, juce::String trackId,bool prefetch) {
    if(prefetch&&(link.startsWith("beatmaker-cache://")||link.startsWith("beatmaker-local://")))return;
    if(link.startsWith("beatmaker-local://")){
        const auto id=link.fromFirstOccurrenceOf("beatmaker-local://",false,false);
        requestedPlay.store(false);playing.store(false);ready.store(false);published.store(nullptr);
        loaders.addJob([this,id,startAt]{
            try{
                const auto entry=libraryStore.media(id);const juce::File file(entry["path"].toString());
                if(!file.existsAsFile()){std::lock_guard<std::mutex> lock(metadataMutex);status="Local audio is missing; re-import the file. The library entry has been kept.";return;}
                restorePosition.store(startAt);loadFile(file,true);
            }catch(const std::exception& error){std::lock_guard<std::mutex> lock(metadataMutex);status="Cannot read local audio: "+juce::String(error.what());}
        });return;
    }
    if(link.startsWith("beatmaker-cache://")){
        const auto id=link.fromFirstOccurrenceOf("beatmaker-cache://",false,false);
        if(id.length()==11&&id.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")){
            const auto file=juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("BeatmakerCuesPrototype/Media/song-"+id+".m4a");
            if(file.existsAsFile()){restorePosition.store(startAt);requestedPlay.store(false);playing.store(false);ready.store(false);published.store(nullptr);loadFile(file,true);return;}
        }
        std::lock_guard<std::mutex> lock(metadataMutex);status="Cached song is unavailable; select the song again";return;
    }
    const juce::URL source(link);
    if (source.getScheme() != "https" || !(source.getDomain().endsWith(".googlevideo.com") || source.getDomain() == "googlevideo.com")) {
        std::lock_guard<std::mutex> lock(metadataMutex); status = "Unsupported audio URL"; return;
    }
    const int generation = prefetch?loadGeneration.load():++loadGeneration;
    if(!prefetch){requestedPlay.store(false); playing.store(false); ready.store(false); published.store(nullptr);restorePosition.store(startAt);nativeEnded.store(false);
        std::lock_guard<std::mutex> lock(metadataMutex); status = "Downloading song…";}
    loaders.addJob([this, source, link, generation, startAt, trackId,prefetch] {
        const auto folder = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("BeatmakerCuesPrototype/Media");
        folder.createDirectory();
        const auto stableId=trackId.length()==11&&trackId.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")?trackId:juce::String::toHexString(source.toString(true).hashCode64());
        const auto file = folder.getChildFile("song-"+stableId + ".m4a");
        juce::String error;
        if (!file.existsAsFile()) {
            const auto part = file.getSiblingFile(file.getFileName() + "-"+juce::Uuid().toString()+".partial");
            auto output = part.createOutputStream();
            juce::int64 offset=0, total=-1;
            if (!output) error = "Cannot create audio cache";
            while (output && generation == loadGeneration.load() && (total < 0 || offset < total) && offset < 64 * 1024 * 1024) {
                bool success=false;
                for (int attempt=0; attempt<3 && !success; ++attempt) {
                    int code=0; juce::StringPairArray headers;
                    const auto end = total < 0 ? offset+1048575 : juce::jmin(offset+1048575,total-1);
                    const auto requestHeaders="Range: bytes="+juce::String(offset)+"-"+juce::String(end)+"\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\r\nAccept-Encoding: identity\r\n";
                   #if JUCE_MAC || JUCE_IOS
                    const auto response=appleHttp(link,"GET",requestHeaders,{},15,[this,generation]{return generation!=loadGeneration.load();});
                    code=response.status;headers=response.headers;
                    auto stream=std::make_unique<juce::MemoryInputStream>(response.data,true);
                   #else
                    auto stream = source.createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
                        .withConnectionTimeoutMs(15000).withStatusCode(&code).withResponseHeaders(&headers)
                        .withExtraHeaders(requestHeaders));
                   #endif
                    if (!stream || code != 206) { juce::Logger::outputDebugString("Plugin audio range HTTP "+juce::String(code)); continue; }
                    juce::String range;
                    for (int i=0;i<headers.size();++i) if (headers.getAllKeys()[i].equalsIgnoreCase("content-range")) range=headers.getAllValues()[i];
                    const auto parts=juce::StringArray::fromTokens(range.fromFirstOccurrenceOf(" ",false,false), "-/", "");
                    if(parts.size()!=3){juce::Logger::outputDebugString("Plugin range header: "+range);continue;}
                    const auto from=parts[0].getLargeIntValue(), last=parts[1].getLargeIntValue(), length=parts[2].getLargeIntValue();
                    if(from!=offset||last<from||last>end||length<=last||length>64*1024*1024||(total>=0&&total!=length))continue;
                    juce::MemoryBlock block;
                    stream->readIntoMemoryBlock(block,(ssize_t)(last-from+1));
                    if((juce::int64)block.getSize()!=last-from+1){juce::Logger::outputDebugString("Plugin range bytes "+juce::String((juce::int64)block.getSize())+" expected "+juce::String(last-from+1));continue;}
                    if(!output->write(block.getData(),block.getSize()))break;
                    total=length;offset=last+1;success=true;
                }
                if(!success){error="Audio download failed; try the song again.";break;}
            }
            output.reset();
            if(error.isEmpty()&&offset==total&&generation==loadGeneration.load())part.moveFileTo(file);
            else {part.deleteFile();if(error.isEmpty())error="Audio download cancelled or too large";}
        }
        if(generation!=loadGeneration.load())return;
        if(prefetch)return;
        if(error.isEmpty()) {
            juce::AudioFormatManager formats;formats.registerBasicFormats();
            auto reader=mediaReader(formats,file,error,[this,generation]{return generation!=loadGeneration.load();});
            if(reader&&reader->sampleRate>0&&reader->lengthInSamples>1&&reader->lengthInSamples<=24*1024*1024) {
                auto sample=std::make_unique<Sample>();sample->rate=reader->sampleRate;sample->path=file.getFullPathName();
                sample->audio.setSize(juce::jmin(2,(int)reader->numChannels),(int)reader->lengthInSamples);
                if(reader->read(&sample->audio,0,sample->audio.getNumSamples(),0,true,true)) {
                    restorePosition.store(startAt);publish(std::move(sample),generation,true);return;
                }
            }
            error="Cannot decode song audio";
        }
        std::lock_guard<std::mutex> lock(metadataMutex);status=error;
    });
}

juce::var CueProcessor::cachedTrack(const juce::String& id){
    if(id.startsWith("loc")){
        const auto entry=libraryStore.media(id);
        if(entry.isObject()){
            auto result=entry.clone();result.getDynamicObject()->setProperty("url","beatmaker-local://"+id);result.getDynamicObject()->setProperty("mime","audio/wav");return result;
        }
    }
    if(id.length()!=11||!id.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"))return {};
    const auto file=juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("BeatmakerCuesPrototype/Media/song-"+id+".m4a");
    if(!file.existsAsFile())return {};
    juce::AudioFormatManager formats;formats.registerBasicFormats();
    juce::String error;auto reader=mediaReader(formats,file,error);
    if(!reader||reader->sampleRate<=0||reader->lengthInSamples<2)return {};
    auto* result=new juce::DynamicObject;result->setProperty("url","beatmaker-cache://"+id);result->setProperty("mime","audio/mp4");
    result->setProperty("duration",reader->lengthInSamples/reader->sampleRate);result->setProperty("title",id);return juce::var(result);
}

juce::var CueProcessor::importLocalFile(const juce::File& input){
    juce::AudioFormatManager formats;formats.registerBasicFormats();juce::String error;auto reader=mediaReader(formats,input,error);
    if(!reader||reader->sampleRate<=0||reader->lengthInSamples<2)throw std::runtime_error("Cannot decode this audio file");
    if(reader->lengthInSamples>24*1024*1024)throw std::runtime_error("Decoded audio exceeds the supported memory budget");
    const auto id="loc"+juce::Uuid().toString().removeCharacters("-").substring(0,8);
    const auto directory=libraryStore.mediaDirectory();if(!directory.createDirectory())throw std::runtime_error("Cannot create media storage");
    const auto destination=directory.getChildFile(id+input.getFileExtension());
    if(!input.copyFileTo(destination))throw std::runtime_error("Cannot retain an app-local copy of this file");
    auto* metadata=new juce::DynamicObject;
    metadata->setProperty("id",id);metadata->setProperty("title",input.getFileNameWithoutExtension());metadata->setProperty("artist","Local audio");
    metadata->setProperty("duration",reader->lengthInSamples/reader->sampleRate);metadata->setProperty("path",destination.getFullPathName());
    metadata->setProperty("kind","song");metadata->setProperty("thumb","");metadata->setProperty("art","");
    juce::var result(metadata);libraryStore.registerMedia(id,result);return result;
}

void CueProcessor::setNativeQueue(const juce::var& value){
    if(!value.isObject()||!value["tracks"].isArray())return;
    const auto tracks=value["tracks"];const int index=juce::jlimit(0,juce::jmax(0,tracks.size()-1),(int)value["index"]);
    const std::lock_guard<std::mutex> lock(metadataMutex);
    bool changed=nativeIndex.load()!=index||nativeQueue["repeat"].toString()!=value["repeat"].toString()||nativeQueue["tracks"].size()!=tracks.size();
    if(!changed)for(int i=0;i<tracks.size();++i)if(nativeQueue["tracks"][i]["id"].toString()!=tracks[i]["id"].toString()){changed=true;break;}
    nativeQueue=value.clone();nativeIndex.store(index);
    if(changed){++queueGeneration;needAdvance.store(false);nativeEnded.store(false);}
}

juce::var CueProcessor::nativeSnapshot() const {
    const std::lock_guard<std::mutex> lock(metadataMutex);
    const int index=nativeIndex.load();const auto tracks=nativeQueue["tracks"];
    auto* result=new juce::DynamicObject;
    result->setProperty("position",nativeAdvancing.load()?0:playhead.load());result->setProperty("duration",getDuration());
    result->setProperty("ready",ready.load()&&!nativeAdvancing.load());result->setProperty("playing",requestedPlay.load()&&(playing.load()||nativeAdvancing.load()));
    result->setProperty("buffered",ready.load()?getDuration():0);
    if(tracks.isArray()&&index>=0&&index<tracks.size()){
        result->setProperty("queueIndex",index);result->setProperty("trackId",tracks[index]["id"]);
        result->setProperty("url",tracks[index]["id"].toString().startsWith("loc")?"beatmaker-local://"+tracks[index]["id"].toString():"beatmaker-cache://"+tracks[index]["id"].toString());
        result->setProperty("loop",tracks[index]["loop"]);
    }
    return juce::var(result);
}

void CueProcessor::runQueue(){
    juce::String warmed;
    juce::var queue;
    int observedGeneration=-1;
    int savedCues=-1;double savedPosition=-1;
    juce::uint32 lastSaved=0;
    while(!stopQueue.load()){
        juce::Thread::sleep(20);
        if(openEditors.load()==0&&getWebState().length()>2&&juce::Time::getMillisecondCounter()-lastSaved>=1000&&
           (cueRevision.load()!=savedCues||std::abs(playhead.load()-savedPosition)>0.5)){
            try{const auto snapshot=sessionUiState();setWebState(snapshot);libraryStore.writePreferences(snapshot,getSessionId());savedCues=cueRevision.load();savedPosition=playhead.load();lastSaved=juce::Time::getMillisecondCounter();}
            catch(const std::exception& error){juce::Logger::outputDebugString("Automatic session save: "+juce::String(error.what()));lastSaved=juce::Time::getMillisecondCounter();}
        }
        const bool advancing=needAdvance.exchange(false);
        if(!advancing&&!ready.load())continue;
        const int generation=queueGeneration.load();
        if(!advancing&&generation==observedGeneration&&warmed.isNotEmpty())continue;
        if(advancing||generation!=observedGeneration){
            const std::lock_guard<std::mutex> lock(metadataMutex);queue=nativeQueue.clone();
            if(generation!=observedGeneration)warmed.clear();observedGeneration=generation;
        }
        const auto tracks=queue["tracks"];if(!tracks.isArray()||tracks.size()==0)continue;
        const int index=nativeIndex.load();
        int next=index+1;
        if(advancing&&queue["repeat"].toString()=="one")next=index;
        if(next>=tracks.size())next=queue["repeat"].toString()=="all"?0:-1;
        if(advancing){
            if(!requestedPlay.load())continue;
            if(next<0){nativeEnded.store(true);continue;}
            if(next==index){restartAtZero.store(true);continue;}
        }else if(next<0||next==index)continue;
        const auto id=tracks[next]["id"].toString();
        if(!advancing&&(warmed==id||!requestedPlay.load()))continue;
        const auto cancelled=[this,generation]{return stopQueue.load()||generation!=queueGeneration.load();};
        if(advancing){
            setWebState(sessionUiState());nativeAdvancing.store(true);ready.store(false);published.store(nullptr);
            nativeIndex.store(next);nativeTrackRevision.fetch_add(1);
            const auto state=juce::JSON::parse(getWebState());const auto all=juce::JSON::parse(state["musike:cues:v1"].toString());const auto bankMap=all[juce::Identifier(id)];
            for(int b=0;b<10;++b)for(int p=0;p<16;++p){const auto value=bankMap[juce::Identifier(juce::String::charToString((juce::juce_wchar)('A'+b)))][juce::Identifier(juce::String(p+1))];cues[(size_t)b][(size_t)p].store(value.isVoid()?-1:(double)value);}
        }
        try{
            auto track=cachedTrack(id);
            if(track.isVoid())track=resolveYouTubeTrack(id,cancelled);
            if(cancelled())continue;
            if(!advancing){warmed=id;loadRemote(track["url"].toString(),0,id,true);continue;}
            const auto loop=tracks[next]["loop"];
            loopIn.store((double)loop["from"]);loopOut.store((double)loop["to"]);loopEnabled.store((bool)loop["on"]&&loopOut.load()>loopIn.load());
            {std::lock_guard<std::mutex> lock(metadataMutex);webTrack=id;}
            loadRemote(track["url"].toString(),0,id);requestedPlay.store(true);warmed.clear();
        }catch(const std::exception& error){
            if(cancelled())continue;
            if(advancing){nativeAdvancing.store(false);requestedPlay.store(false);nativeErrorRevision.fetch_add(1);std::lock_guard<std::mutex> lock(metadataMutex);status=juce::String("Cannot advance playlist: ")+error.what();}
            else warmed=id;
        }
    }
}
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new CueProcessor(); }
