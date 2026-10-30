#include "Processor.h"
#include "Editor.h"
#include "WebEditor.h"
#include "TrackResolver.h"
#if JUCE_MAC || JUCE_IOS
#include "AppleHttp.h"
#endif
#include <cmath>
#include <cstring>
#if JUCE_ANDROID
#include "AndroidCodec.h"
#endif
#include <map>

namespace {
juce::var waveformObject(std::initializer_list<std::pair<juce::Identifier,juce::var>> fields){auto* value=new juce::DynamicObject;for(const auto& field:fields)value->setProperty(field.first,field.second);return juce::var(value);}
juce::var fxStateValue(const beatmaker::dsp::FxState& state){
    auto* value=new juce::DynamicObject;value->setProperty("schema",1);value->setProperty("enabled",state.enabled);value->setProperty("padActive",state.padActive);value->setProperty("multi",state.multi);value->setProperty("held",state.held);value->setProperty("x",state.x);value->setProperty("y",state.y);
    juce::Array<juce::var> effects;for(const auto type:state.effects)effects.add(juce::String(beatmaker::dsp::effectNames[(int)type].data()));value->setProperty("effects",effects);return juce::var(value);
}
// POSIX record locks are process-owned, so they cannot exclude another loader
// thread or another processor instance in the same host process.
std::shared_ptr<std::timed_mutex> mediaMutex(const juce::String& path){
    static std::mutex guard;static std::map<juce::String,std::weak_ptr<std::timed_mutex>> locks;
    std::lock_guard<std::mutex> lock(guard);
    for(auto it=locks.begin();it!=locks.end();)if(it->second.expired())it=locks.erase(it);else ++it;
    auto& weak=locks[path];auto result=weak.lock();if(!result){result=std::make_shared<std::timed_mutex>();weak=result;}return result;
}
juce::AudioProcessorValueTreeState::ParameterLayout parameterLayout() {
    juce::AudioProcessorValueTreeState::ParameterLayout layout;
    layout.add(std::make_unique<juce::AudioParameterFloat>(juce::ParameterID{"gain", 1}, "Output", 0.0f, 1.0f, 0.8f));
    layout.add(std::make_unique<juce::AudioParameterFloat>(juce::ParameterID{"speed", 1}, "Varispeed", 0.25f, 2.0f, 1.0f));
    return layout;
}
constexpr int rolandNotes[] = {48,49,50,51,44,45,46,47,40,41,42,43,36,37,38,39};
juce::File audioCacheFolder(){const auto overridePath=juce::SystemStats::getEnvironmentVariable("BEATMAKER_AUDIO_CACHE_DIR",{});auto folder=overridePath.isNotEmpty()?juce::File(overridePath):juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("BeatmakerCuesPrototype/Media");
   #if JUCE_IOS
    folder.createDirectory();appleAllowBackgroundFileAccess(folder);
    static std::once_flag protectExisting;std::call_once(protectExisting,[folder]{for(const auto& file:folder.findChildFiles(juce::File::findFiles,false,"*.m4a"))appleAllowBackgroundFileAccess(file);});
   #endif
    return folder;}
bool validCachedMp4(const juce::File& file){
    if(file.getSize()<12||file.getSize()>64*1024*1024)return false;
    char bytes[8];auto input=file.createInputStream();return input&&input->read(bytes,8)==8&&std::memcmp(bytes+4,"ftyp",4)==0;
}
void cacheDuration(const juce::File& file,double duration){
    if(!file.isAChildOf(audioCacheFolder())||!file.getFileName().startsWith("song-"))return;
    auto* info=new juce::DynamicObject;info->setProperty("schema",1);info->setProperty("size",file.getSize());info->setProperty("modified",file.getLastModificationTime().toMilliseconds());info->setProperty("duration",duration);
    juce::TemporaryFile temporary(file.getSiblingFile(file.getFileName()+".info.json"));if(temporary.getFile().replaceWithText(juce::JSON::toString(juce::var(info))))temporary.overwriteTargetFileWithTemporary();
}
double cachedDuration(const juce::File& file){
    const auto info=juce::JSON::parse(file.getSiblingFile(file.getFileName()+".info.json").loadFileAsString());const double duration=(double)info["duration"];
    return info.isObject()&&(int)info["schema"]==1&&(juce::int64)info["size"]==file.getSize()&&(juce::int64)info["modified"]==file.getLastModificationTime().toMilliseconds()&&std::isfinite(duration)&&duration>0?duration:0;
}

std::unique_ptr<juce::AudioFormatReader> mediaReader(juce::AudioFormatManager& formats,const juce::File& input,juce::String& error,const std::function<bool()>& cancelled={}){
   #if JUCE_IOS
    appleAllowBackgroundFileAccess(input);
   #endif
    std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(input));
    if(reader)return reader;
   #if JUCE_ANDROID
    return createAndroidAudioReader(input,error,cancelled);
   #endif
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

CueProcessor::CueProcessor(AudioTransport transport)
    : AudioProcessor(BusesProperties().withOutput("Stereo", juce::AudioChannelSet::stereo(), true)),
      parameters(*this, nullptr, "Parameters", parameterLayout()),audioTransport(std::move(transport)) {
    for (auto& bank : cues) for (auto& cue : bank) cue.store(-1);
    gainValue=parameters.getRawParameterValue("gain");speedValue=parameters.getRawParameterValue("speed");
    sessionId=wrapperType==wrapperType_Standalone||wrapperType==wrapperType_Undefined?"standalone":juce::Uuid().toString();
    setLatencySamples(0);
    queueThread=std::thread([this]{runQueue();});
    if(wrapperType==wrapperType_Standalone)standaloneNowPlaying=createStandaloneNowPlaying(*this);
    if(wrapperType==wrapperType_Standalone)restorePadSamples(juce::JSON::parse(padSampleManifest().loadFileAsString()));
}

CueProcessor::~CueProcessor() {
    standaloneNowPlaying.reset();
    stopQueue.store(true);++queueGeneration;
    ++loadGeneration;
    waveformWorkers.removeAllJobs(true,-1);
    if(queueThread.joinable())queueThread.join();
    loaders.removeAllJobs(true, -1);
    padSampleLoaders.removeAllJobs(true,-1);
    networkWorkers.removeAllJobs(true,-1);
}

bool CueProcessor::isBusesLayoutSupported(const BusesLayout& layout) const {
    const auto output = layout.getMainOutputChannelSet();
    return layout.getMainInputChannelSet().isDisabled()
        && (output == juce::AudioChannelSet::mono() || output == juce::AudioChannelSet::stereo());
}

void CueProcessor::prepareToPlay(double rate, int maximumBlock) {
    hostRate = rate > 0 ? rate : 44100;
    fxControlRate.store(hostRate);nativeFxGraph.prepare(hostRate);
    int latency=0;
    {std::lock_guard<std::mutex> lock(metadataMutex);nativeFxGraph.configure(requestedFxGraph);fxGraphUpdates.publish(requestedFxGraph);latency=beatmaker::dsp::FxGraph::latency(requestedFxGraph,hostRate);fxTailSeconds.store(beatmaker::dsp::FxGraph::tail(requestedFxGraph,hostRate));}
    setLatencySamples(latency);
    fadeLength = juce::jmax(2, (int) std::round(hostRate * 0.003));
    fadeRemaining = 0;
    lastVoice.fill(0);fadeOrigin.fill(0);
    cueFade.resize((size_t)fadeLength);
    for(int i=0;i<fadeLength;++i)cueFade[(size_t)i]=0.5f-0.5f*std::cos(juce::MathConstants<float>::pi*i/(float)(fadeLength-1));
    outputGain.reset(hostRate, 0.01);
    outputGain.setCurrentAndTargetValue(gainValue->load());
    smoothedSpeed.reset(hostRate,0.02);smoothedSpeed.setCurrentAndTargetValue(speedValue->load());
    smoothedTuning.reset(hostRate,0.02);smoothedTuning.setCurrentAndTargetValue(semitones.load());
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
        padSampler.stopAll();
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
    if (bank < 0 || bank >= 10 || pad < 0 || pad >= padCount()) return;
    if(padSampler.trigger(bank*16+pad,velocity)){activePad.store(bank*16+pad);padEvent(bank,pad,true,true,velocity);return;}
    if(current==nullptr)return;
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
    const double target = juce::jlimit(0.0, (double) current->frames() - 1, seconds * current->rate);
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
        case Action::pad: hit(command.bank, command.pad, command.overwrite, 1.0f);padEvent(command.bank,command.pad,false,false,1.0f);break;
        case Action::markNext:
            if (current == nullptr) break;
            for (int bank = selectedBank.load(); bank < 10; ++bank) {
                for (int pad = 0; pad < padCount(); ++pad) {
                    if (!hasPadSample(bank,pad)&&cues[(size_t) bank][(size_t) pad].load() < 0) {
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
            if (current && !playing.load()) jump(position >= current->frames() - 1 ? 0 : position / current->rate, 1.0f);
            break;
        case Action::cue: if(hasPadSample(command.bank,command.pad))hit(command.bank,command.pad,false,1.0f);else{jump(command.value,1.0f);if(current)padEvent(command.bank,command.pad,false,true,1.0f);}break;
        case Action::pause: requestedPlay.store(false);playing.store(false);cacheWaiting=false;cacheBuffering.store(false); fadeRemaining = 0; break;
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
    if (!current || at < 0 || at >= current->frames()) return 0;
    const int index = (int) at, next = juce::jmin(index + 1, current->frames() - 1);
    const float fraction = (float) (at - index);
    const float first=current->value(index,channel);
    return first+fraction*(current->value(next,channel)-first);
}
float CueProcessor::processEffect(float sample,int channel) const {
    return beatmaker::dsp::process(currentEffectKernel,sample,channel,currentEffectBits,currentEffectAmount);
}
void CueProcessor::outputFrame(juce::AudioBuffer<float>& buffer,int frame,beatmaker::dsp::Stereo voice,float gain){
    const auto samples=padSampler.frame(hostRate);for(int c=0;c<2;++c)voice[(size_t)c]+=samples[(size_t)c];
    for(int c=0;c<2;++c)voice[(size_t)c]=processEffect(voice[(size_t)c],c);
    const auto result=nativeFxGraph.process(voice);
    if(buffer.getNumChannels()==1)buffer.setSample(0,frame,gain*(nativeFxGraph.enabled()?0.5f*(result[0]+result[1]):result[0]));
    else for(int c=0;c<2;++c)buffer.setSample(c,frame,gain*result[(size_t)c]);
}
void CueProcessor::setFxGraph(const juce::var& value){
    const auto schema=value["schema"];
    if(!value.isObject()||(value.hasProperty("schema")&&((!schema.isInt()&&!schema.isInt64()&&!schema.isDouble())||(double)schema!=1)))throw std::runtime_error("Invalid native FX graph state");
    int latency=0;
    {std::lock_guard<std::mutex> lock(metadataMutex);auto next=requestedFxGraph;
        const auto boolean=[&](const char* key,bool& target){if(value.hasProperty(key)){if(!value[key].isBool())throw std::runtime_error("Native FX flags must be boolean");target=(bool)value[key];}};
        boolean("enabled",next.enabled);boolean("padActive",next.padActive);boolean("multi",next.multi);boolean("held",next.held);
        const auto position=[&](const char* key,double& target){if(value.hasProperty(key)){const auto v=value[key];if(!v.isDouble()&&!v.isInt()&&!v.isInt64())throw std::runtime_error("Native FX position must be numeric");const double amount=v;if(!std::isfinite(amount)||amount<0||amount>1)throw std::runtime_error("Native FX position must be between zero and one");target=amount;}};
        position("x",next.x);position("y",next.y);
        if(value.hasProperty("effects")){const auto effects=value["effects"];if(!effects.isArray()||effects.size()!=4)throw std::runtime_error("Native FX graph needs exactly four corners");for(int i=0;i<4;++i){if(!effects[i].isString())throw std::runtime_error("Native FX names must be strings");const int kind=beatmaker::dsp::effectIndex(effects[i].toString().toStdString());if(kind<0)throw std::runtime_error("This FX graph effect is not implemented natively yet");next.effects[(size_t)i]=(beatmaker::dsp::Effect)kind;}}
        requestedFxGraph=next;fxGraphUpdates.publish(next);fxTailSeconds.store(beatmaker::dsp::FxGraph::tail(next,fxControlRate.load()));latency=beatmaker::dsp::FxGraph::latency(next,fxControlRate.load());
    }
    if(getLatencySamples()!=latency)setLatencySamples(latency);
}
juce::var CueProcessor::fxGraphState() const {std::lock_guard<std::mutex> lock(metadataMutex);return fxStateValue(requestedFxGraph);}
void CueProcessor::setEffectKernel(const juce::var& value){
    const auto type=value["type"].toString();const auto input=value["amount"];
    if(value.hasProperty("amount")&&!input.isInt()&&!input.isInt64()&&!input.isDouble())throw std::runtime_error("Effect amount must be numeric");
    const double amount=value.hasProperty("amount")?(double)input:(type=="none"?0:1);
    if(!std::isfinite(amount)||amount<0||amount>1)throw std::runtime_error("Effect amount must be between zero and one");
    const juce::StringArray types{"none","bitDecimator","bitCrash","twelveBit","centerCancel"};
    const int kind=types.indexOf(type);if(kind<0)throw std::runtime_error("This effect kernel is not implemented natively yet");
    const float gain=(float)amount;juce::uint32 gainBits=0;std::memcpy(&gainBits,&gain,sizeof(gain));
    requestedEffectKernel.store(((juce::uint64)gainBits<<16)|((juce::uint64)beatmaker::dsp::decimatorBits(amount)<<8)|(juce::uint64)kind);
}
juce::var CueProcessor::effectKernelState() const {
    const auto state=requestedEffectKernel.load();const int kind=(int)(state&255),bits=(int)((state>>8)&255);
    const auto gainBits=(juce::uint32)(state>>16);float gain=0;std::memcpy(&gain,&gainBits,sizeof(gain));
    auto* result=new juce::DynamicObject;const juce::StringArray types{"none","bitDecimator","bitCrash","twelveBit","centerCancel"};
    result->setProperty("type",types[juce::jlimit(0,4,kind)]);
    result->setProperty("amount",kind==1||kind==2?(12-bits)/8.0:(double)gain);return juce::var(result);
}

bool CueProcessor::prepareAudio(double from,double to){
    bool available=true;
    if(current->paged){
        // All reads from the previous render segment have finished. Releasing
        // here also lets an offline bounce reuse slots within a large host block.
        current->paged->releasePages();
        available=current->paged->prepareRange(from,to);
        if(!available&&isNonRealtime()){
            // Hosts may bounce faster than wall-clock time. Only an explicitly
            // non-realtime render may wait; decoding still stays on the worker.
            const auto deadline=juce::Time::getMillisecondCounterHiRes()+10000;
            while(!available&&!current->paged->failed()&&current==published.load()&&!stopQueue.load()&&juce::Time::getMillisecondCounterHiRes()<deadline){
                current->paged->releasePages();juce::Thread::sleep(1);available=current->paged->prepareRange(from,to);
            }
        }
    }
    if(available){
        if(cacheWaiting){cacheWaiting=false;cacheBuffering.store(false);fadeOrigin=lastVoice;fadeRemaining=fadeLength;stretchSeek=true;}
        return true;
    }
    if(!cacheWaiting){cacheWaiting=true;cacheBuffering.store(true);++cacheMisses;bufferingOrigin=lastVoice;bufferingFadeRemaining=fadeLength;stretchSeek=true;}
    return false;
}
void CueProcessor::renderBuffering(juce::AudioBuffer<float>& buffer,int start,int count){
    // Never wait for IO in the audio callback. Preserve the target position and
    // join the previous waveform to silence while the worker prepares a cold cue.
    for(int i=0;i<count;++i){
        const float fade=bufferingFadeRemaining>0?1.0f-cueFade[(size_t)(fadeLength-bufferingFadeRemaining)]:0;
        const float gain=outputGain.getNextValue()*(muted.load()?0.0f:1.0f);
        for(int c=0;c<2;++c)lastVoice[(size_t)c]=bufferingOrigin[(size_t)c]*fade;
        outputFrame(buffer,start+i,lastVoice,gain);
        if(bufferingFadeRemaining>0)--bufferingFadeRemaining;
    }
}
void CueProcessor::render(juce::AudioBuffer<float>& buffer, int start, int count) {
    if(count<=0)return;
    if(!current||!playing.load()){
        for(int i=0;i<count;++i)outputFrame(buffer,start+i,{},outputGain.getNextValue()*(muted.load()?0.0f:1.0f));
        return;
    }
    if(count>8192){for(int offset=0;offset<count;offset+=8192)render(buffer,start+offset,juce::jmin(8192,count-offset));return;}
    const float targetSpeed=speedValue->load(),targetTuning=semitones.load();
    smoothedSpeed.setTargetValue(targetSpeed);smoothedTuning.setTargetValue(targetTuning);
    const float speed=smoothedSpeed.getCurrentValue();
    const bool useStretch=preservePitch.load()&&(std::abs(speed-1.0f)>0.0001f||std::abs(targetSpeed-1.0f)>0.0001f||std::abs(smoothedTuning.getCurrentValue())>0.001f||std::abs(targetTuning)>0.001f);
    const double ratio=current->rate/hostRate;
    const double history=useStretch?stretch.inputLatency()*ratio:0;
    const double ahead=(count*juce::jmax(speed,targetSpeed)+(useStretch?stretch.outputSeekLength(juce::jmax(speed,targetSpeed)):0)+8)*ratio+2;
    const double readAhead=useStretch&&!stretchSeek?juce::jmax(position+ahead,stretchReadPosition+count*juce::jmax(speed,targetSpeed)*ratio+2):position+ahead;
    if(!prepareAudio(position-history,readAhead)){renderBuffering(buffer,start,count);return;}
    if(useStretch) {
        if(!stretchWasActive){stretchSeek=true;fadeOrigin=lastVoice;fadeRemaining=fadeLength;}
        stretchWasActive=true;
        const double sourceStep=current->rate/hostRate;
        if(stretchSeek) {
            const int preload=stretch.outputSeekLength(speed);
            // outputSeek aligns output to the beginning of its input and has
            // already consumed the preload. Continue after it, never replay it.
            const double begin=position;
            for(int c=0;c<2;++c)for(int i=0;i<preload;++i)stretchInput.setSample(c,i,read(begin+i*sourceStep,c));
            stretch.outputSeek(stretchInput.getArrayOfReadPointers(),preload);
            stretchReadPosition=begin+preload*sourceStep;
            stretchSeek=false;stretchFraction=0;
        }
        int offset=0;
        while(offset<count&&playing.load()) {
            int frames=juce::jmin(stretchBlock,count-offset);
            if(smoothedSpeed.isSmoothing()||smoothedTuning.isSmoothing())frames=juce::jmin(frames,128);
            if(loopEnabled.load()) {
                const auto remaining=(loopOut.load()*current->rate-position)/(sourceStep*speed);
                if(remaining<=0){const auto target=loopIn.load();jump(target,velocityGain);loopEnabled.store(true);render(buffer,start+offset,count-offset);return;}
                frames=juce::jmin(frames,juce::jmax(1,(int)std::ceil(remaining)));
            }
            const float beginSpeed=smoothedSpeed.getCurrentValue();
            const double segmentSpeed=(beginSpeed+smoothedSpeed.skip(frames))*0.5;
            const float beginTuning=smoothedTuning.getCurrentValue();
            stretch.setTransposeSemitones((beginTuning+smoothedTuning.skip(frames))*0.5f);
            const double exact=frames*segmentSpeed+stretchFraction;
            const int inputFrames=(int)exact;stretchFraction=exact-inputFrames;
            for(int c=0;c<2;++c)for(int i=0;i<inputFrames;++i)stretchInput.setSample(c,i,read(stretchReadPosition+i*sourceStep,c));
            stretch.process(stretchInput.getArrayOfReadPointers(),inputFrames,stretchOutput.getArrayOfWritePointers(),frames);
            for(int i=0;i<frames;++i) {
                const float incoming=cueFadeIn();
                const float outgoing=1.0f-incoming;
                const float gain=outputGain.getNextValue()*(muted.load()?0.0f:1.0f);
                for(int c=0;c<2;++c){
                    const float voice=stretchOutput.getSample(c,i)*incoming*velocityGain+fadeOrigin[(size_t)c]*outgoing;
                    lastVoice[(size_t)c]=voice;
                }
                outputFrame(buffer,start+offset+i,lastVoice,gain);
                if(fadeRemaining>0)--fadeRemaining;
            }
            position+=inputFrames*sourceStep;stretchReadPosition+=inputFrames*sourceStep;offset+=frames;
            if(position>=current->frames()){playing.store(false);needAdvance.store(true);}
        }
        if(offset<count)render(buffer,start+offset,count-offset);
        return;
    }
    if(stretchWasActive){fadeOrigin=lastVoice;fadeRemaining=fadeLength;}
    stretchWasActive=false;
    smoothedTuning.setCurrentAndTargetValue(targetTuning);
    const double sourceStep=current->rate/hostRate;
    const double end = current->frames();
    for (int frame = start; frame < start + count; ++frame) {
        const double step=sourceStep*smoothedSpeed.getNextValue();
        if (loopEnabled.load() && position / current->rate >= loopOut.load()) {
            const double target = loopIn.load();
            jump(target, velocityGain);
            loopEnabled.store(true);
            if(!prepareAudio(position,position+(start+count-frame)*step+2)){renderBuffering(buffer,frame,start+count-frame);return;}
        }
        if (position >= end) { playing.store(false);needAdvance.store(true);render(buffer,frame,start+count-frame);return; }
        const float incoming = cueFadeIn();
        const float outgoing = 1.0f-incoming;
        const float gain = outputGain.getNextValue() * (muted.load() ? 0.0f : 1.0f);
        const float endFade = (float) juce::jlimit(0.0, 1.0, (end - position) / (step * fadeLength));
        for (int channel = 0; channel < 2; ++channel) {
            const float voice=read(position, channel)*incoming*velocityGain*endFade+fadeOrigin[(size_t)channel]*outgoing;
            lastVoice[(size_t)channel]=voice;
        }
        outputFrame(buffer,frame,lastVoice,gain);
        position += step;
        if (fadeRemaining > 0) --fadeRemaining;
    }
}

void CueProcessor::processBlock(juce::AudioBuffer<float>& output, juce::MidiBuffer& midi) {
    juce::ScopedNoDenormals noDenormals;
    if(!playing.load()){smoothedSpeed.setCurrentAndTargetValue(speedValue->load());smoothedTuning.setCurrentAndTargetValue(semitones.load());}
    beatmaker::dsp::FxState update;if(fxGraphUpdates.consume(update))nativeFxGraph.configure(update);
    const auto effect=requestedEffectKernel.load();currentEffectKernel=(beatmaker::dsp::Kernel)(effect&255);currentEffectBits=(int)((effect>>8)&255);
    const auto effectGain=(juce::uint32)(effect>>16);std::memcpy(&currentEffectAmount,&effectGain,sizeof(currentEffectAmount));
    output.clear();
    Sample* next;
    do { next = published.load(); audioHazard.store(next); } while (next != published.load());
    if (next != current) {
        current = next;
        position = current ? juce::jlimit(0.0, (double) current->frames() - 1, restorePosition.load() * current->rate) : 0;
        playing.store(false); fadeRemaining = 0;
        lastVoice.fill(0);fadeOrigin.fill(0);
        stretchSeek=true;
        cacheWaiting=false;cacheBuffering.store(false);cacheMisses.store(0);bufferingFadeRemaining=0;
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
    if(current&&current->paged)current->paged->releasePages();
    if(loadFirstRenderMs.load()==0&&current&&current==published.load()&&measuredLoadGeneration.load()==loadGeneration.load()&&loadPublishedMs.load()>0)loadFirstRenderMs.store(juce::Time::getMillisecondCounterHiRes());
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
    durationSeconds.store(pointer->frames()/pointer->rate);
    if(measuredLoadGeneration.load()==generation)loadPublishedMs.store(juce::Time::getMillisecondCounterHiRes());
    nativeAdvancing.store(false);
    const auto* inUse = audioHazard.load();
    retained.erase(std::remove_if(retained.begin(), retained.end(), [pointer, inUse](const auto& item) {
        return item.get() != pointer && item.get() != inUse;
    }), retained.end());
}

void CueProcessor::failLoad(const juce::String& error,int generation){
    std::lock_guard<std::mutex> lock(metadataMutex);if(generation!=loadGeneration.load())return;
    status=error;requestedPlay.store(false);playing.store(false);ready.store(false);published.store(nullptr);durationSeconds.store(0);nativeAdvancing.store(false);nativeErrorRevision.fetch_add(1);
}
void CueProcessor::loadFile(const juce::File& input, bool preserveCues,int ticket) {
    int generation;
    { std::lock_guard<std::mutex> lock(metadataMutex);if(ticket>0&&ticket!=loadGeneration.load())return;generation=ticket>0?ticket:++loadGeneration;status = "Loading " + input.getFileName() + "…";
      if(ticket==0){measuredLoadGeneration.store(generation);loadStartedMs.store(juce::Time::getMillisecondCounterHiRes());loadDecoderMs.store(0);loadPcmReadMs.store(0);loadDownloadMs.store(0);loadPublishedMs.store(0);loadFirstRenderMs.store(0);}}
    loaders.addJob([this, input, preserveCues, generation] {decodeFile(input,preserveCues,generation);});
}
void CueProcessor::decodeFile(const juce::File& input,bool preserveCues,int generation){
        if(generation!=loadGeneration.load())return;
        juce::File file = input;
       #if JUCE_IOS
        // Keep an extension-owned copy; document picker access is not a durable DAW session path.
        const auto directory = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("BeatmakerCues/Media");
        directory.createDirectory();
        const auto local = directory.getChildFile(juce::Uuid().toString() + "." + input.getFileExtension().substring(1));
        const auto cache=audioCacheFolder();
        if (!input.isAChildOf(directory)&&!input.isAChildOf(cache)&&!input.isAChildOf(libraryStore.mediaDirectory())&&input.copyFileTo(local)) file = local;
       #endif
        juce::AudioFormatManager formats;
        formats.registerBasicFormats();
        juce::String error;
        const auto decoderStarted=juce::Time::getMillisecondCounterHiRes();
        auto reader=mediaReader(formats,file,error,[this,generation]{return generation!=loadGeneration.load();});
        if(generation==loadGeneration.load())loadDecoderMs.store(juce::Time::getMillisecondCounterHiRes()-decoderStarted);
        const bool invalidEncoded=!reader&&!error.containsIgnoreCase("Install FFmpeg")&&!error.containsIgnoreCase("cancelled")&&!error.containsIgnoreCase("timed out");
        if (!reader) error = error.isNotEmpty()?error:"Cannot open audio. Try WAV, AIFF, FLAC or MP3.";
        else if (reader->numChannels<1 || reader->lengthInSamples < 2 || !std::isfinite(reader->sampleRate) || reader->sampleRate <= 0
                 || reader->lengthInSamples > PagedAudio::maxFrames) error = "Audio has invalid metadata or exceeds the supported frame range.";
        else {
            auto sample = std::make_unique<Sample>();
            sample->rate = reader->sampleRate;
            sample->path = file.getFullPathName();
            if(reader->lengthInSamples>PagedAudio::residentFrameLimit||reader->getFormatName()=="Android MediaCodec"){
                const auto pcmStarted=juce::Time::getMillisecondCounterHiRes();
                const int start=(int)juce::jlimit(0.0,(double)reader->lengthInSamples-1,restorePosition.load()*reader->sampleRate);
                try{sample->paged=std::make_unique<PagedAudio>(std::move(reader),start);}
                catch(const std::exception& failure){failLoad("Audio cache preparation failed: "+juce::String(failure.what()),generation);return;}
                if(generation!=loadGeneration.load())return;
                loadPcmReadMs.store(juce::Time::getMillisecondCounterHiRes()-pcmStarted);
                cacheDuration(file,sample->frames()/sample->rate);
                publish(std::move(sample),generation,preserveCues);return;
            }
            sample->audio.setSize(juce::jmin(2, (int) reader->numChannels), (int) reader->lengthInSamples);
            const auto pcmStarted=juce::Time::getMillisecondCounterHiRes();bool decoded=true;
            for(int offset=0;offset<sample->audio.getNumSamples()&&decoded;offset+=65536){
                if(generation!=loadGeneration.load())return;
                const auto count=juce::jmin(65536,sample->audio.getNumSamples()-offset);
                decoded=reader->read(&sample->audio,offset,count,offset,true,true);
            }
            if (decoded) {
                if(generation==loadGeneration.load())loadPcmReadMs.store(juce::Time::getMillisecondCounterHiRes()-pcmStarted);
                cacheDuration(file,sample->audio.getNumSamples()/sample->rate);
                publish(std::move(sample), generation, preserveCues);
                return;
            }
            error = "Audio decoding failed.";
        }
        const auto cacheFolder=audioCacheFolder();
        if((invalidEncoded||error=="Audio decoding failed.")&&file.isAChildOf(cacheFolder)&&file.getFileName().startsWith("song-")&&generation==loadGeneration.load()){
            const auto retained=file.getSiblingFile(file.getFileName()+".invalid-"+juce::Uuid().toString());
            if(file.moveFileTo(retained)){file.getSiblingFile(file.getFileName()+".info.json").deleteFile();error+=" Cached copy retained; select the song again to download a fresh copy.";}
        }
        failLoad(error,generation);
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
        const auto folder = audioCacheFolder();
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
juce::var CueProcessor::loadDiagnostics() const {
    std::lock_guard<std::mutex> lock(metadataMutex);
    auto* result=new juce::DynamicObject;const auto start=loadStartedMs.load(),first=loadFirstRenderMs.load(),publishedAt=loadPublishedMs.load();
    result->setProperty("fxGraphLatencySamples",getLatencySamples());
    const auto* sample=published.load();
    result->setProperty("sampleStorage",sample?(sample->paged?"paged":"resident"):"none");
    result->setProperty("pcmCacheBytes",sample?(juce::int64)(sample->paged?sample->paged->pcmBytes():(size_t)sample->frames()*sample->channels()*sizeof(float)):0);
    result->setProperty("buffering",cacheBuffering.load());result->setProperty("cacheMisses",cacheMisses.load());
    if(sample&&sample->paged){result->setProperty("cachedPages",sample->paged->loadedPages());result->setProperty("decoderPageReads",sample->paged->decoderReads());}
    result->setProperty("generation",measuredLoadGeneration.load());result->setProperty("downloadMs",loadDownloadMs.load());result->setProperty("decoderInitMs",loadDecoderMs.load());result->setProperty("pcmReadMs",loadPcmReadMs.load());
    result->setProperty("requestToPublishMs",publishedAt>0?publishedAt-start:-1);result->setProperty("requestToFirstRenderMs",first>0?first-start:-1);result->setProperty("note","First-render timing measures buffer processing, excluding earlier UI URL resolution, FX look-ahead (reported separately) and physical device output latency");return juce::var(result);
}
double CueProcessor::getDuration() const {return durationSeconds.load();}

void CueProcessor::getStateInformation(juce::MemoryBlock& destination) {
    juce::XmlElement state("BeatmakerCuesPrototype");
    state.createNewChildElement("EffectKernel")->addTextElement(juce::JSON::toString(effectKernelState()));
    state.createNewChildElement("NativeFxGraph")->addTextElement(juce::JSON::toString(fxGraphState()));
    state.createNewChildElement("PadSamples")->addTextElement(juce::JSON::toString(padSamples()));
    state.setAttribute("version", 1);
    state.setAttribute("sessionId",getSessionId());
    state.setAttribute("editorWidth",editorWidth.load());state.setAttribute("editorHeight",editorHeight.load());
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
    restorePadSamples(state->getChildByName("PadSamples")?juce::JSON::parse(state->getChildByName("PadSamples")->getAllSubText()):juce::var(juce::Array<juce::var>{}));
    if(const auto* graph=state->getChildByName("NativeFxGraph")){
        try{setFxGraph(juce::JSON::parse(graph->getAllSubText()));}catch(const std::exception&){setFxGraph(fxStateValue({}));}
    }else setFxGraph(fxStateValue({}));
    if(const auto* effect=state->getChildByName("EffectKernel")){
        try{setEffectKernel(juce::JSON::parse(effect->getAllSubText()));}catch(const std::exception&){requestedEffectKernel.store(0);}
    }else requestedEffectKernel.store(0);
    if(state->getIntAttribute("editorWidth")>0&&state->getIntAttribute("editorHeight")>0){
       #if JUCE_IOS || JUCE_ANDROID
        editorWidth.store(juce::jlimit(240,4096,state->getIntAttribute("editorWidth")));editorHeight.store(juce::jlimit(240,4096,state->getIntAttribute("editorHeight")));
       #else
        editorWidth.store(juce::jlimit(320,4096,state->getIntAttribute("editorWidth")));editorHeight.store(juce::jlimit(480,4096,state->getIntAttribute("editorHeight")));
       #endif
    }
    {std::lock_guard<std::mutex> lock(metadataMutex);const auto saved=state->getStringAttribute("sessionId");if(saved.isNotEmpty()&&saved.length()<80&&saved.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"))sessionId=saved;}
    if(const auto* legacy=state->getChildByName("LegacyUI")){std::lock_guard<std::mutex> lock(metadataMutex);legacyState=legacy->getAllSubText();}
    playing.store(false);requestedPlay.store(false);needAdvance.store(false);nativeEnded.store(false);
    {std::lock_guard<std::mutex> lock(metadataMutex);++queueGeneration;manualQueueRequest.store(0);manualQueueIntent.store(-1);}
    if(const auto* savedQueue=state->getChildByName("NativeQueue"))setNativeQueue(juce::JSON::parse(savedQueue->getAllSubText()));
    else {std::lock_guard<std::mutex> lock(metadataMutex);nativeQueue=juce::var();nativeIndex.store(0);}
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

juce::var CueProcessor::waveformSnapshot(){
    juce::String path;{std::lock_guard<std::mutex> lock(metadataMutex);path=samplePath;}
    if(!ready.load()||!juce::File(path).existsAsFile())return waveformObject({{"peaks",juce::var(juce::Array<juce::var>{})},{"progress",0.0}});
    const int generation=loadGeneration.load();bool start=false;
    {std::lock_guard<std::mutex> lock(waveformMutex);
        if(path!=waveformPath){waveformPath=path;waveformPeaks.assign(1024,0);waveformReadFrames=0;waveformTotalFrames=0;waveformLoading=false;}
        if(!waveformLoading&&(waveformTotalFrames==0||waveformReadFrames<waveformTotalFrames)&&!backgroundPlayback.load()){waveformLoading=true;start=true;}
    }
    if(start)waveformWorkers.addJob([this,path,generation]{
        const auto cancelled=[this,generation]{return stopQueue.load()||generation!=loadGeneration.load()||backgroundPlayback.load()||openEditors.load()==0;};
        juce::AudioFormatManager formats;formats.registerBasicFormats();juce::String error;
        auto reader=mediaReader(formats,juce::File(path),error,cancelled);
        if(reader){
            const auto key=path+juce::String(juce::File(path).getSize())+juce::String(juce::File(path).getLastModificationTime().toMilliseconds());
            const auto cache=libraryStore.mediaDirectory().getChildFile("Waveforms").getChildFile(juce::String::toHexString(key.hashCode64())+".json");
            auto saved=juce::JSON::parse(cache.loadFileAsString());
            {std::lock_guard<std::mutex> lock(waveformMutex);if(path!=waveformPath)return;
                waveformTotalFrames=reader->lengthInSamples;
                if(const auto* peaks=saved["peaks"].getArray())if(peaks->size()==1024&&(juce::int64)saved["frames"]==reader->lengthInSamples){for(int i=0;i<1024;++i)waveformPeaks[(size_t)i]=(float)(double)(*peaks)[i];waveformReadFrames=waveformTotalFrames;}
            }
            juce::AudioBuffer<float> chunk(juce::jmin(2,(int)reader->numChannels),65536);
            juce::int64 offset;{std::lock_guard<std::mutex> lock(waveformMutex);offset=waveformReadFrames;}
            while(offset<reader->lengthInSamples&&!cancelled()){
                const int count=(int)juce::jmin((juce::int64)65536,reader->lengthInSamples-offset);
                if(!reader->read(&chunk,0,count,offset,true,true))break;
                {std::lock_guard<std::mutex> lock(waveformMutex);if(path!=waveformPath)break;
                    for(int i=0;i<count;++i){const auto bin=(size_t)juce::jmin((juce::int64)1023,(offset+i)*1024/reader->lengthInSamples);for(int c=0;c<chunk.getNumChannels();++c)waveformPeaks[bin]=juce::jmax(waveformPeaks[bin],std::abs(chunk.getSample(c,i)));}
                    waveformReadFrames=offset+count;
                }
                offset+=count;
            }
            if(!cancelled()&&offset>=reader->lengthInSamples){
                juce::Array<juce::var> peaks;{std::lock_guard<std::mutex> lock(waveformMutex);if(path==waveformPath)for(const float peak:waveformPeaks)peaks.add(peak);}
                cache.getParentDirectory().createDirectory();juce::TemporaryFile temporary(cache);
                if(temporary.getFile().replaceWithText(juce::JSON::toString(waveformObject({{"frames",reader->lengthInSamples},{"peaks",juce::var(peaks)}}))))temporary.overwriteTargetFileWithTemporary();
            }
        }
        std::lock_guard<std::mutex> lock(waveformMutex);if(path==waveformPath)waveformLoading=false;
    });
    std::lock_guard<std::mutex> lock(waveformMutex);juce::Array<juce::var> peaks;for(const float value:waveformPeaks)peaks.add(value);
    return waveformObject({{"peaks",juce::var(peaks)},{"progress",waveformTotalFrames>0?(double)waveformReadFrames/waveformTotalFrames:0.0},{"duration",getDuration()}});
}

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
        juce::var nativeTracks;{std::lock_guard<std::mutex> lock(metadataMutex);nativeTracks=nativeQueue["tracks"];}
        if(nativeTracks.isArray()){
            const auto saved=player["queue"];bool same=saved.isArray()&&saved.size()==nativeTracks.size();
            if(same)for(int i=0;i<saved.size();++i)if(saved[i]["id"].toString()!=nativeTracks[i]["id"].toString()){same=false;break;}
            if(!same){juce::Array<juce::var> retainedTracks;for(const auto& track:*nativeTracks.getArray()){
                auto* item=new juce::DynamicObject;for(const auto* key:{"id","title","artist","album","duration"})item->setProperty(key,track[key]);
                auto art=track["artwork"].toString();if(art.isEmpty())art=track["art"].toString();if(art.isEmpty())art=track["thumb"].toString();item->setProperty("art",art);item->setProperty("thumb",art);item->setProperty("kind",track["kind"].isString()?track["kind"]:juce::var("song"));retainedTracks.add(juce::var(item));
            }fields->setProperty("queue",retainedTracks);}
        }
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

void CueProcessor::loadRemote(const juce::String& link, double startAt, juce::String trackId,bool prefetch,bool preservePlayIntent) {
    if(prefetch&&(link.startsWith("beatmaker-cache://")||link.startsWith("beatmaker-local://")))return;
    int generation;
    {std::lock_guard<std::mutex> lock(metadataMutex);
        const auto tracks=nativeQueue["tracks"];const int index=nativeIndex.load();
        if(!prefetch&&trackId.isNotEmpty()&&tracks.isArray()&&index>=0&&index<tracks.size()&&tracks[index]["id"].toString()!=trackId)return;
        generation=prefetch?loadGeneration.load():++loadGeneration;
        if(!prefetch){if(!preservePlayIntent)requestedPlay.store(false);playing.store(false);ready.store(false);published.store(nullptr);restorePosition.store(startAt);nativeEnded.store(false);status="Loading song…";
            measuredLoadGeneration.store(generation);loadStartedMs.store(juce::Time::getMillisecondCounterHiRes());loadDecoderMs.store(0);loadPcmReadMs.store(0);loadDownloadMs.store(0);loadPublishedMs.store(0);loadFirstRenderMs.store(0);}
    }
    if(link.startsWith("beatmaker-local://")){
        const auto id=link.fromFirstOccurrenceOf("beatmaker-local://",false,false);
        loaders.addJob([this,id,generation]{
            if(generation!=loadGeneration.load())return;
            try{
                const auto entry=libraryStore.media(id);const juce::File file(entry["path"].toString());
                if(!file.existsAsFile()){failLoad("Local audio is missing; re-import the file. The library entry has been kept.",generation);return;}
                loadFile(file,true,generation);
            }catch(const std::exception& error){failLoad("Cannot read local audio: "+juce::String(error.what()),generation);}
        });return;
    }
    if(link.startsWith("beatmaker-cache://")){
        const auto id=link.fromFirstOccurrenceOf("beatmaker-cache://",false,false);
        if(id.length()==11&&id.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")){
            const auto file=audioCacheFolder().getChildFile("song-"+id+".m4a");
            if(file.existsAsFile()){loadFile(file,true,generation);return;}
        }
        failLoad("Cached song is unavailable; select the song again",generation);return;
    }
    const juce::URL source(link);
    if (source.getScheme() != "https" || !(source.getDomain().endsWith(".googlevideo.com") || source.getDomain() == "googlevideo.com")) {
        if(!prefetch)failLoad("Unsupported audio URL",generation);return;
    }
    loaders.addJob([this, source, link, generation, trackId,prefetch] {
        const auto folder = audioCacheFolder();
        folder.createDirectory();
        const auto stableId=trackId.length()==11&&trackId.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")?trackId:juce::String::toHexString(source.toString(true).hashCode64());
        const auto file = folder.getChildFile("song-"+stableId + ".m4a");
        juce::String error;
        const auto downloadStarted=juce::Time::getMillisecondCounterHiRes();
        const auto cancelDownload=[this,generation,prefetch,stableId]{
            if(stopQueue.load())return true;
            if(!prefetch)return generation!=loadGeneration.load();
            // Becoming the current song must reuse, not cancel/restart, its prefetch.
            std::lock_guard<std::mutex> lock(metadataMutex);const auto tracks=nativeQueue["tracks"];const int currentIndex=nativeIndex.load();
            if(!tracks.isArray()||currentIndex<0||currentIndex>=tracks.size())return true;
            int next=currentIndex+1;if(next>=tracks.size())next=nativeQueue["repeat"].toString()=="all"?0:-1;
            return tracks[currentIndex]["id"].toString()!=stableId&&(next<0||tracks[next]["id"].toString()!=stableId);
        };
        {
        const auto mutex=mediaMutex(file.getFullPathName());
        std::unique_lock<std::timed_mutex> localLock(*mutex,std::defer_lock);
        while(!localLock.try_lock_for(std::chrono::milliseconds(50))){if(cancelDownload())return;}
        juce::InterProcessLock downloadLock("beatmaker-media-"+juce::String::toHexString(file.getFullPathName().hashCode64()));
        while(!downloadLock.enter(50)){if(cancelDownload())return;}
        struct Unlock{juce::InterProcessLock& lock;~Unlock(){lock.exit();}}unlock{downloadLock};
        if(cancelDownload())return;
        if(file.existsAsFile()&&!validCachedMp4(file)){file.deleteFile();file.getSiblingFile(file.getFileName()+".info.json").deleteFile();}
        if (!file.existsAsFile()) {
            const auto part = file.getSiblingFile(file.getFileName() + "-"+juce::Uuid().toString()+".partial");
            auto output = part.createOutputStream();
            juce::int64 offset=0, total=-1;
            if (!output) error = "Cannot create audio cache";
            while (output && !cancelDownload() && (total < 0 || offset < total) && offset < 64 * 1024 * 1024) {
                bool success=false;
                 for (int attempt=0; attempt<3 && !success && !cancelDownload(); ++attempt) {
                    int code=0; juce::StringPairArray headers;
                    const auto end = total < 0 ? offset+1048575 : juce::jmin(offset+1048575,total-1);
                    const auto requestHeaders="Range: bytes="+juce::String(offset)+"-"+juce::String(end)+"\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\r\nAccept-Encoding: identity\r\n";
                    std::unique_ptr<juce::InputStream> stream;
                    if(audioTransport){
                        const auto response=audioTransport(link,requestHeaders,cancelDownload);
                        code=response.status;headers=response.headers;
                        stream=std::make_unique<juce::MemoryInputStream>(response.data,true);
                    }else{
                   #if JUCE_MAC || JUCE_IOS
                    const auto response=appleHttp(link,"GET",requestHeaders,{},15,cancelDownload);
                    code=response.status;headers=response.headers;
                     stream=std::make_unique<juce::MemoryInputStream>(response.data,true);
                   #else
                     stream = source.createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
                        .withConnectionTimeoutMs(15000).withStatusCode(&code).withResponseHeaders(&headers)
                        .withExtraHeaders(requestHeaders));
                   #endif
                    }
                    if (!stream || code != 206) { juce::Logger::outputDebugString("Plugin audio range HTTP "+juce::String(code)); continue; }
                    juce::String range;
                    for (int i=0;i<headers.size();++i) if (headers.getAllKeys()[i].equalsIgnoreCase("content-range")) range=headers.getAllValues()[i];
                    const auto parts=juce::StringArray::fromTokens(range.fromFirstOccurrenceOf(" ",false,false), "-/", "");
                    if(parts.size()!=3){juce::Logger::outputDebugString("Plugin range header: "+range);continue;}
                    const auto from=parts[0].getLargeIntValue(), last=parts[1].getLargeIntValue(), length=parts[2].getLargeIntValue();
                    if(from!=offset||last<from||last>end||length<=last||length>64*1024*1024||(total>=0&&total!=length))continue;
                    juce::MemoryBlock block;
                    stream->readIntoMemoryBlock(block,static_cast<int>(last-from+1)); // Validated ranges are bounded to at most 64 MB.
                    if((juce::int64)block.getSize()!=last-from+1){juce::Logger::outputDebugString("Plugin range bytes "+juce::String((juce::int64)block.getSize())+" expected "+juce::String(last-from+1));continue;}
                    if(!output->write(block.getData(),block.getSize()))break;
                    total=length;offset=last+1;success=true;
                }
                if(!success){error="Audio download failed; try the song again.";break;}
            }
            output.reset();
             if(error.isEmpty()&&offset==total&&!cancelDownload()){if(!part.moveFileTo(file)){part.deleteFile();error="Cannot publish the completed audio cache";}}
            else {part.deleteFile();if(error.isEmpty())error="Audio download cancelled or too large";}
        }
        }
        if(generation!=loadGeneration.load())return;
        if(prefetch)return;
        loadDownloadMs.store(juce::Time::getMillisecondCounterHiRes()-downloadStarted);
        if(error.isEmpty()){decodeFile(file,true,generation);return;}
        failLoad(error,generation);
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
    const auto file=audioCacheFolder().getChildFile("song-"+id+".m4a");
    if(!file.existsAsFile())return {};
    // A cache lookup must not initialise a decoder (or run FFmpeg) on the shared storage worker.
    if(!validCachedMp4(file)){file.deleteFile();file.getSiblingFile(file.getFileName()+".info.json").deleteFile();return {};}
    auto* result=new juce::DynamicObject;result->setProperty("url","beatmaker-cache://"+id);result->setProperty("mime","audio/mp4");
    result->setProperty("duration",cachedDuration(file));result->setProperty("title",id);return juce::var(result);
}

juce::File CueProcessor::padSampleManifest() const {
    return LibraryStore::defaultDirectory().getChildFile("PadSamples").getChildFile(getSessionId()+".json");
}
void CueProcessor::persistPadSamples(){
    std::lock_guard<std::mutex> lock(padSamplePersistenceMutex);
    padSampleTail.store(padSampler.tailSeconds());
    const auto file=padSampleManifest();if(!file.getParentDirectory().createDirectory())throw std::runtime_error("Cannot create pad sample storage");
    juce::TemporaryFile temporary(file);if(!temporary.getFile().replaceWithText(juce::JSON::toString(padSamples()))||!temporary.overwriteTargetFileWithTemporary())throw std::runtime_error("Cannot save pad sample assignments");
   #if JUCE_IOS
    appleAllowBackgroundFileAccess(file);appleAllowBackgroundFileAccess(file.getParentDirectory());
   #endif
}
juce::var CueProcessor::importPadSample(int bank,int pad,const juce::File& input){
    if(bank<0||bank>=10||pad<0||pad>=16)throw std::runtime_error("Invalid sample pad");
    const int slot=bank*16+pad,ticket=padSampler.reserve(slot);
    const auto directory=libraryStore.mediaDirectory().getChildFile("PadSamples");
    if(!directory.createDirectory())throw std::runtime_error("Cannot create sample media storage");
    const auto destination=directory.getChildFile(juce::Uuid().toString()+input.getFileExtension());
    if(!input.copyFileTo(destination))throw std::runtime_error("Cannot retain an app-local copy of this sample");
   #if JUCE_IOS
    appleAllowBackgroundFileAccess(directory);appleAllowBackgroundFileAccess(destination);
   #endif
    try{
        juce::AudioFormatManager formats;formats.registerBasicFormats();juce::String error;
        auto reader=mediaReader(formats,destination,error);
        if(!reader)throw std::runtime_error(error.isNotEmpty()?error.toStdString():"Cannot decode this sample");
        padSampler.load(slot,std::move(reader),destination.getFullPathName(),input.getFileNameWithoutExtension(),ticket);
    }catch(...){destination.deleteFile();throw;}
    persistPadSamples();return padSamples();
}
juce::var CueProcessor::removePadSample(int bank,int pad){
    if(bank<0||bank>=10||pad<0||pad>=16)throw std::runtime_error("Invalid sample pad");
    padSampler.clear(bank*16+pad);persistPadSamples();return padSamples();
}
void CueProcessor::restorePadSamples(const juce::var& saved){
    for(int slot=0;slot<PadSampler::slots;++slot)padSampler.clear(slot);
    struct Restore {int slot,ticket;juce::String path,name;};std::vector<Restore> restore;
    if(const auto* pads=saved.getArray())for(const auto& value:*pads){
        const auto bank=value["bank"].toString();const int pad=(int)value["pad"]-1;
        if(bank.length()!=1||bank[0]<'A'||bank[0]>'J'||pad<0||pad>=16||!juce::File::isAbsolutePath(value["path"].toString()))continue;
        const int slot=((int)bank[0]-'A')*16+pad;const auto path=value["path"].toString(),name=value["name"].toString();
        restore.push_back({slot,padSampler.pending(slot,path,name),path,name});
    }
    padSampleTail.store(0);
    if(restore.empty())return;
    padSampleLoaders.addJob([this,restore=std::move(restore)]{
        for(const auto& item:restore){if(stopQueue.load())return;
            try{juce::AudioFormatManager formats;formats.registerBasicFormats();juce::String error;
                auto reader=mediaReader(formats,juce::File(item.path),error,[this]{return stopQueue.load();});
                if(!reader)throw std::runtime_error(error.isNotEmpty()?error.toStdString():"Sample file is missing or unreadable; replace or remove it");
                padSampler.load(item.slot,std::move(reader),item.path,item.name,item.ticket);
            }catch(const std::exception& error){padSampler.failed(item.slot,item.ticket,error.what());}
        }
        padSampleTail.store(padSampler.tailSeconds());
    });
}

juce::var CueProcessor::importLocalFile(const juce::File& input){
    juce::AudioFormatManager formats;formats.registerBasicFormats();juce::String error;auto reader=mediaReader(formats,input,error);
    if(!reader||reader->sampleRate<=0||reader->lengthInSamples<2)throw std::runtime_error("Cannot decode this audio file");
    if(reader->lengthInSamples>PagedAudio::maxFrames)throw std::runtime_error("Audio exceeds the supported frame range");
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
    if(changed){++queueGeneration;manualQueueRequest.store(0);manualQueueIntent.store(-1);needAdvance.store(false);nativeEnded.store(false);}
}

bool CueProcessor::submitRemoteCommand(Command command){if(!submit(command))return false;remoteTransportRevision.fetch_add(1);return true;}
bool CueProcessor::performRemoteAction(RemoteAction action,double seconds){
    if(action==RemoteAction::toggle)action=requestedPlay.load()&&!nativeEnded.load()?RemoteAction::pause:RemoteAction::play;
    if(action==RemoteAction::play||action==RemoteAction::pause){
        {std::lock_guard<std::mutex> lock(metadataMutex);if(!ready.load()&&!nativeAdvancing.load()&&nativeQueue["tracks"].size()==0)return false;}
        if(!submitRemoteCommand({action==RemoteAction::play?Action::play:Action::pause}))return false;
        requestedPlay.store(action==RemoteAction::play);playIntentRevision.fetch_add(1);if(action==RemoteAction::play)nativeEnded.store(false);return true;
    }
    if(action==RemoteAction::seek){
        if(!std::isfinite(seconds)||!ready.load())return false;
        return submitRemoteCommand({Action::seek,0,0,juce::jlimit(0.0,getDuration(),seconds)});
    }
    if(action!=RemoteAction::next&&action!=RemoteAction::previous)return false;
    if(action==RemoteAction::previous&&manualQueueIntent.load()<0&&ready.load()&&!nativeAdvancing.load()&&playhead.load()>3)return submitRemoteCommand({Action::seek,0,0,0});
    std::lock_guard<std::mutex> lock(metadataMutex);const auto tracks=nativeQueue["tracks"];const int current=nativeIndex.load();
    if(!tracks.isArray()||tracks.size()==0){return action==RemoteAction::previous&&ready.load()?submitRemoteCommand({Action::seek,0,0,0}):false;}
    const int intent=manualQueueIntent.load();int target=(intent>=0?intent:current)+(action==RemoteAction::next?1:-1);
    if(target<0)target=nativeQueue["repeat"].toString()=="all"?tracks.size()-1:0;
    if(target>=tracks.size()){if(nativeQueue["repeat"].toString()!="all")return false;target=0;}
    if(target==current&&ready.load()){
        if(intent>=0){++queueGeneration;++loadGeneration;manualQueueRequest.store(0);manualQueueIntent.store(-1);needAdvance.store(false);}
        return submitRemoteCommand({Action::seek,0,0,0});
    }
    const auto generation=(juce::uint32)++queueGeneration;++loadGeneration;manualQueueIntent.store(target);manualQueueRequest.store(((juce::uint64)generation<<32)|(juce::uint32)(target+1));needAdvance.store(false);nativeEnded.store(false);remoteTransportRevision.fetch_add(1);return true;
}

juce::var CueProcessor::nativeSnapshot() const {
    const std::lock_guard<std::mutex> lock(metadataMutex);
    const int index=nativeIndex.load();const auto tracks=nativeQueue["tracks"];
    auto* result=new juce::DynamicObject;
    result->setProperty("position",nativeAdvancing.load()?0:playhead.load());result->setProperty("duration",getDuration());
    result->setProperty("ready",ready.load()&&!nativeAdvancing.load());result->setProperty("playing",requestedPlay.load()&&(playing.load()||nativeAdvancing.load()));
    const auto* sample=published.load();
    result->setProperty("buffered",ready.load()?(sample&&sample->paged?sample->paged->bufferedTo(playhead.load()):getDuration()):0);
    result->setProperty("buffering",cacheBuffering.load());
    result->setProperty("rate",(double)speedValue->load());
    result->setProperty("canNext",tracks.isArray()&&tracks.size()>1&&(index+1<tracks.size()||nativeQueue["repeat"].toString()=="all"));
    result->setProperty("canPrevious",ready.load()||(tracks.isArray()&&tracks.size()>0));
    if(tracks.isArray()&&index>=0&&index<tracks.size()){
        result->setProperty("queueIndex",index);result->setProperty("trackId",tracks[index]["id"]);
        result->setProperty("url",tracks[index]["id"].toString().startsWith("loc")?"beatmaker-local://"+tracks[index]["id"].toString():"beatmaker-cache://"+tracks[index]["id"].toString());
        result->setProperty("loop",tracks[index]["loop"]);
        for(const auto* key:{"title","artist","album"})result->setProperty(key,tracks[index][key]);
        if(!ready.load()||nativeAdvancing.load()||getDuration()<=0)result->setProperty("duration",tracks[index]["duration"]);
        auto artwork=tracks[index]["artwork"].toString();if(artwork.isEmpty())artwork=tracks[index]["art"].toString();if(artwork.isEmpty())artwork=tracks[index]["thumb"].toString();result->setProperty("artwork",artwork);
    }else if(ready.load()&&!tracks.isArray()){
        result->setProperty("trackId",samplePath);result->setProperty("title",samplePath=="demo:"?"Beatmaker Cues demo":juce::File(samplePath).getFileNameWithoutExtension());result->setProperty("artist","Beatmaker Cues");
    }
    return juce::var(result);
}

void CueProcessor::runQueue(){
    juce::String warmed;
    juce::var queue;
    int observedGeneration=-1;
    int savedCues=-1,savedTrack=-1;double savedPosition=-1;
    juce::uint32 lastSaved=0;
    while(!stopQueue.load()){
        juce::Thread::sleep(20);
        bool cacheFailed=false;int cacheGeneration=0;
        {std::lock_guard<std::mutex> lock(metadataMutex);
            const auto* latest=published.load();const auto* inUse=audioHazard.load();
            retained.erase(std::remove_if(retained.begin(),retained.end(),[latest,inUse](const auto& sample){return sample.get()!=latest&&sample.get()!=inUse;}),retained.end());
            if(auto* sample=published.load())if(sample->paged){
                cacheFailed=sample->paged->failed();cacheGeneration=loadGeneration.load();
                for(int b=0;b<10;++b)for(int p=0;p<16;++p)sample->paged->setCue(b*16+p,cues[(size_t)b][(size_t)p].load());
                sample->paged->setLoop(loopIn.load(),loopOut.load(),loopEnabled.load());
            }
        }
        if(cacheFailed){failLoad("Audio page decoding failed; select the song again.",cacheGeneration);continue;}
        if((openEditors.load()==0||backgroundPlayback.load())&&getWebState().length()>2&&juce::Time::getMillisecondCounter()-lastSaved>=1000&&
           (cueRevision.load()!=savedCues||nativeTrackRevision.load()!=savedTrack||std::abs(playhead.load()-savedPosition)>0.5)){
            try{const auto snapshot=sessionUiState();setWebState(snapshot);libraryStore.writePreferences(snapshot,getSessionId());savedCues=cueRevision.load();savedTrack=nativeTrackRevision.load();savedPosition=playhead.load();lastSaved=juce::Time::getMillisecondCounter();}
            catch(const std::exception& error){juce::Logger::outputDebugString("Automatic session save: "+juce::String(error.what()));lastSaved=juce::Time::getMillisecondCounter();}
        }
        const auto request=manualQueueRequest.exchange(0);
        int manual=request?(int)(juce::uint32)request-1:-1;
        const bool automatic=needAdvance.exchange(false);
        const int generation=queueGeneration.load();
        if(request&&(juce::uint32)(request>>32)!=(juce::uint32)generation)manual=-1;
        const bool advancing=manual>=0||automatic;
        if(!advancing&&!ready.load())continue;
        if(!advancing&&generation==observedGeneration&&warmed.isNotEmpty())continue;
        if(advancing||generation!=observedGeneration){
            const std::lock_guard<std::mutex> lock(metadataMutex);queue=nativeQueue.clone();
            if(generation!=observedGeneration)warmed.clear();observedGeneration=generation;
        }
        const auto tracks=queue["tracks"];if(!tracks.isArray()||tracks.size()==0)continue;
        const int index=nativeIndex.load();
        int next=manual>=0?manual:index+1;
        if(advancing&&manual<0&&queue["repeat"].toString()=="one")next=index;
        if(next>=tracks.size())next=queue["repeat"].toString()=="all"?0:-1;
        if(advancing){
            if(!requestedPlay.load()&&manual<0)continue;
            if(next<0){nativeEnded.store(true);continue;}
            if(next==index&&manual<0){restartAtZero.store(true);continue;}
        }else if(next<0||next==index)continue;
        const auto id=tracks[next]["id"].toString();
        if(!advancing&&(warmed==id||!requestedPlay.load()))continue;
        const auto cancelled=[this,generation]{return stopQueue.load()||generation!=queueGeneration.load();};
        if(advancing){
            setWebState(sessionUiState());
            {std::lock_guard<std::mutex> lock(metadataMutex);if(generation!=queueGeneration.load())continue;nativeAdvancing.store(true);ready.store(false);published.store(nullptr);nativeIndex.store(next);nativeTrackRevision.fetch_add(1);}
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
            loadRemote(track["url"].toString(),0,id,false,true);if(manual>=0&&generation==queueGeneration.load())manualQueueIntent.store(-1);warmed.clear();
        }catch(const std::exception& error){
            if(cancelled())continue;
            if(advancing){nativeAdvancing.store(false);requestedPlay.store(false);if(manual>=0)manualQueueIntent.store(-1);nativeErrorRevision.fetch_add(1);std::lock_guard<std::mutex> lock(metadataMutex);status=juce::String("Cannot advance playlist: ")+error.what();}
            else warmed=id;
        }
    }
}
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new CueProcessor(); }
