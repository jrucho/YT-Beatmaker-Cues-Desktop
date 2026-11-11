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
    // Multiple DAW instances can promote the same prefetched song at once.
    // Serialize fallback decoding too: Windows cannot replace a WAV that the
    // first instance has already opened for reading.
    const auto mutex=mediaMutex(decoded.getFullPathName());std::unique_lock<std::timed_mutex> localLock(*mutex,std::defer_lock);
    const auto lockDeadline=juce::Time::getMillisecondCounterHiRes()+60000;
    const auto abort=[&]{return (cancelled&&cancelled())||juce::Time::getMillisecondCounterHiRes()>lockDeadline;};
    while(!localLock.try_lock_for(std::chrono::milliseconds(50)))if(abort()){error="Audio decoding cancelled or timed out";return {};}
    LibraryFileLock decodeLock(decoded.getFullPathName().toStdString()+".lock");
    while(!decodeLock.enter(50))if(abort()){error="Audio decoder cache is busy or unavailable";return {};}
    struct Unlock{LibraryFileLock& lock;~Unlock(){lock.exit();}}unlock{decodeLock};
    if(abort()){error="Audio decoding cancelled or timed out";return {};}
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
juce::var cleanTrackPlayback(const juce::var& value){
    const auto number=[](const juce::var& input,double low,double high){const double v=(input.isInt()||input.isInt64()||input.isDouble())?(double)input:0;return std::isfinite(v)?juce::jlimit(low,high,std::round(v)):0.0;};
    auto* result=new juce::DynamicObject;
    result->setProperty("speed",number(value["speed"],-75,100));
    result->setProperty("speedMode",value["speedMode"].toString()=="pitch"?"pitch":"speed");
    result->setProperty("tuning",number(value["tuning"],-12,12));return juce::var(result);
}
}

CueProcessor::CueProcessor(AudioTransport transport)
    : AudioProcessor(BusesProperties()
      #if BEATMAKER_PERFORMANCE_FEATURES && !BEATMAKER_DESKTOP_BETA
       .withInput("Recorder input",juce::AudioChannelSet::stereo(),false)
      #endif
       .withOutput("Stereo", juce::AudioChannelSet::stereo(), true)),
      parameters(*this, nullptr, "Parameters", parameterLayout()),audioTransport(std::move(transport)) {
    for (auto& bank : cues) for (auto& cue : bank) cue.store(-1);
    songPlaybackEnabled.store(BEATMAKER_PERFORMANCE_FEATURES&&!BEATMAKER_DESKTOP_BETA);
    gainValue=parameters.getRawParameterValue("gain");speedValue=parameters.getRawParameterValue("speed");
    sessionId=wrapperType==wrapperType_Standalone||wrapperType==wrapperType_Undefined?"standalone":juce::Uuid().toString();
    if(wrapperType!=wrapperType_Standalone&&wrapperType!=wrapperType_Undefined)preset.store(3);
    if(wrapperType==wrapperType_Standalone){const auto saved=juce::JSON::parse(libraryStore.readPreferences(sessionId));midiVelocityEnabled.store(saved["musike:midi:velocity"].toString()!="off");
        if(saved["musike:transitions"].isString())try{setTransitions(juce::JSON::parse(saved["musike:transitions"].toString()));}catch(...) {}
        if(saved["musike:mixer"].isString())try{setMixer(juce::JSON::parse(saved["musike:mixer"].toString()));}catch(...) {}
       #if BEATMAKER_PERFORMANCE_FEATURES && !BEATMAKER_DESKTOP_BETA
        songPlaybackEnabled.store(true);trackPlaybackSettings=juce::JSON::parse(saved["musike:track-playback"].toString());
       #endif
    }
    if(wrapperType==wrapperType_Standalone){const auto saved=juce::JSON::parse(looperManifest().loadFileAsString());if(saved["songs"].isObject())looperSongs=saved["songs"].clone();}
    prepareLooperSong({});
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
    try{saveLoopers();}catch(...) {}
    loaders.removeAllJobs(true, -1);
    padSampleLoaders.removeAllJobs(true,-1);
    networkWorkers.removeAllJobs(true,-1);
}

bool CueProcessor::isBusesLayoutSupported(const BusesLayout& layout) const {
    const auto output = layout.getMainOutputChannelSet();
    const auto input=layout.getMainInputChannelSet();
    return (input.isDisabled()||input==juce::AudioChannelSet::mono()||input==juce::AudioChannelSet::stereo())
        && (output == juce::AudioChannelSet::mono() || output == juce::AudioChannelSet::stereo());
}

void CueProcessor::prepareToPlay(double rate, int maximumBlock) {
    hostRate = rate > 0 ? rate : 44100;
    playbackRate.store(hostRate);
    if(hostedInput()){hostBusChannels.store(juce::jmin(2,getTotalNumInputChannels()));inputChannels.store(hostInputEnabled.load()?hostBusChannels.load():0);inputRate.store(hostRate);monitorInput.store(hostMonitorRequested.load()&&inputChannels.load()>0);hostMonitorCopy.setSize(2,juce::jmax(8192,maximumBlock));}
    performanceCompressor.prepare(hostRate);performanceCompressor.configure(-30,0,20,.01f,.2f);previousCompressor=compressorEnabled.load();
    for(auto* smooth:{&smoothSongLevel,&smoothSampleLevel,&smoothCompressorLevel})smooth->reset(hostRate,.02);
    smoothSongLevel.setCurrentAndTargetValue(songLevel.load());smoothSampleLevel.setCurrentAndTargetValue(sampleLevel.load());smoothCompressorLevel.setCurrentAndTargetValue(compressorLevel.load());
    fxControlRate.store(hostRate);nativeFxGraph.prepare(hostRate);
    int latency=0;
    {std::lock_guard<std::mutex> lock(metadataMutex);nativeFxGraph.configure(requestedFxGraph);fxGraphUpdates.publish(requestedFxGraph);latency=beatmaker::dsp::FxGraph::latency(requestedFxGraph,hostRate);fxTailSeconds.store(beatmaker::dsp::FxGraph::tail(requestedFxGraph,hostRate));}
    setLatencySamples(latency+(compressorEnabled.load()?(int)performanceCompressor.latency():0));
    fadeLength = juce::jmax(2, (int) std::round(hostRate * 0.003));
    fadeRemaining = 0;
    lastVoice.fill(0);fadeOrigin.fill(0);
    cueFade.resize((size_t)fadeLength);
    for(int i=0;i<fadeLength;++i)cueFade[(size_t)i]=0.5f-0.5f*std::cos(juce::MathConstants<float>::pi*i/(float)(fadeLength-1));
    outputGain.reset(hostRate, 0.01);
    outputGain.setCurrentAndTargetValue(gainValue->load());
    songFade.reset(hostRate,transitionSeconds.load());songFade.setCurrentAndTargetValue(1);fadeObserved=0;fadeRequested.store(0);
    smoothedSpeed.reset(hostRate,0.02);smoothedSpeed.setCurrentAndTargetValue(speedValue->load());
    smoothedTuning.reset(hostRate,0.02);smoothedTuning.setCurrentAndTargetValue(semitones.load());
    stretch.configure(2,juce::jmax(256,(int)(hostRate*0.04)),juce::jmax(64,(int)(hostRate*0.01)),false);
    stretchBlock=juce::jmax(512,maximumBlock);
    stretchInput.setSize(2,juce::jmax(stretchBlock*4+16,stretch.outputSeekLength(4.0f)+16));
    stretchOutput.setSize(2,stretchBlock);
    stretchSeek=true;stretchWasActive=false;stretchFraction=0;
}

bool CueProcessor::submit(Command command) {
    // JUCE UI messages and the WebView's synchronous Java bridge are separate
    // producers. Serialize only their tiny writes, never the audio consumer.
    std::lock_guard<std::mutex> writer(commandWriter);
    int start1, size1, start2, size2;
    commands.prepareToWrite(1, start1, size1, start2, size2);
    if (size1 == 0) { ++droppedCommands; return false; }
    if(command.nativePerformance){command.nativeTicket=nativePadInputAccepted.fetch_add(1)+1;if(command.nativeStartedMs<=0)command.nativeStartedMs=juce::Time::getMillisecondCounterHiRes();}
   #if JUCE_ANDROID
    if((command.action==Action::cue||command.action==Action::pad)&&command.bank>=0&&command.bank<10&&command.pad>=0&&command.pad<16){
        const auto touch=androidTouchStartedMs[(size_t)(command.bank*16+command.pad)].exchange(0);
        if(touch>0&&juce::Time::getMillisecondCounterHiRes()-touch<60000){command.androidPerformance=true;command.androidStartedMs=touch;}
    }
    if(command.androidPerformance){command.androidTicket=androidFastAccepted.fetch_add(1)+1;if(command.androidStartedMs<=0)command.androidStartedMs=juce::Time::getMillisecondCounterHiRes();}
   #endif
    commandData[(size_t) start1] = command;
    commands.finishedWrite(1);
    return true;
}

void CueProcessor::releaseResources(){if(hostedInput()){monitorInput.store(false);inputChannels.store(0);hostBusChannels.store(0);inputPeak.store(0);recorder.interrupt();}} // Standalone input lifetime belongs to its device callback.
juce::var CueProcessor::hostAudioState() const{return waveformObject({{"inputEnabled",hostInputEnabled.load()},{"input","host"},{"output","host"},{"monitor",hostMonitorRequested.load()},{"monitorLevel",monitorLevel.load()}});}
void CueProcessor::restoreHostAudio(const juce::var& value){
    hostInputEnabled.store(!value["inputEnabled"].isBool()||(bool)value["inputEnabled"]);hostMonitorRequested.store(value["monitor"].isBool()&&(bool)value["monitor"]);
    const double level=value["monitorLevel"].isVoid()?.5:(double)value["monitorLevel"];monitorLevel.store((float)(std::isfinite(level)?juce::jlimit(0.0,1.0,level):.5));inputChannels.store(hostInputEnabled.load()?hostBusChannels.load():0);monitorInput.store(hostMonitorRequested.load()&&inputChannels.load()>0);
}
juce::var CueProcessor::audioRoutes(){
    if(standaloneNowPlaying)return standaloneNowPlaying->audioRoutes();if(!hostedInput())return waveformObject({{"supported",false}});
    auto result=hostAudioState();auto* out=result.getDynamicObject();const bool active=hostInputEnabled.load()&&hostBusChannels.load()>0;
    out->setProperty("supported",true);out->setProperty("hostManaged",true);out->setProperty("platform","hosted");out->setProperty("inputActive",active);out->setProperty("sampleRate",playbackRate.load());out->setProperty("permission","host-managed");out->setProperty("inputs",juce::Array<juce::var>{});out->setProperty("outputs",juce::Array<juce::var>{});out->setProperty("actualInput",active?"DAW Recorder input / sidechain":"Not connected");out->setProperty("actualOutput","DAW output");out->setProperty("inputAccepted",!hostInputEnabled.load()||active);out->setProperty("outputAccepted",true);out->setProperty("monitorRequested",hostMonitorRequested.load());out->setProperty("monitor",monitorInput.load());out->setProperty("monitorSuspended",hostMonitorRequested.load()&&!monitorInput.load());out->setProperty("message",hostBusChannels.load()>0?"":"Enable and route the Recorder input / sidechain bus in your DAW");return result;
}
void CueProcessor::configureAudio(const juce::var& request,std::function<void(juce::var)> complete){
    if(standaloneNowPlaying){standaloneNowPlaying->configureAudio(request,std::move(complete));return;}
    const auto fail=[&](const char* message){complete(waveformObject({{"__error",message}}));};if(!hostedInput()){fail("Audio routing is unavailable in this wrapper");return;}
    for(const auto* key:{"input","output","driver"})if(request.hasProperty(key)&&request[key].toString()!="host"&&request[key].toString()!="automatic"){fail("Audio devices and routing are controlled by your DAW");return;}
    auto next=hostAudioState();for(const auto* key:{"inputEnabled","monitor","monitorLevel"})if(request.hasProperty(key))next.getDynamicObject()->setProperty(key,request[key]);if((bool)next["monitor"])next.getDynamicObject()->setProperty("inputEnabled",true);
    const double level=next["monitorLevel"];if(!std::isfinite(level)||level<0||level>1){fail("Invalid monitor level");return;}
    if(recorder.hasTake()&&(bool)next["inputEnabled"]!=hostInputEnabled.load()){fail("Finish the recording before changing audio input");return;}
    if(hostBusChannels.load()<1&&((request.hasProperty("inputEnabled")&&(bool)next["inputEnabled"])||(request.hasProperty("monitor")&&(bool)next["monitor"]))){fail("Enable and route the Recorder input / sidechain bus in your DAW first");return;}
    restoreHostAudio(next);complete(audioRoutes());
}
bool CueProcessor::submitNativePadInput(Command command,double startedMs){command.nativePerformance=true;command.nativeStartedMs=startedMs;return submit(command);}
 #if JUCE_ANDROID
bool CueProcessor::submitAndroidPerformance(Command command){
    command.androidPerformance=true;
    if(command.action!=Action::pad&&command.androidGeneration<0)command.androidGeneration=loadGeneration.load();
    return submit(command);
}
 #endif

CueProcessor::Target CueProcessor::mapNote(int mode, int channel, int note, int bank) {
    if (channel < 1 || channel > 16 || note < 0 || note > 127) return {};
    if (mode == 2 || mode == 3) return note >= 36 && note <= (mode==2?47:51) ? Target{juce::jlimit(0, 9, bank), note - 36} : Target{};
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
        padLooper.halt();
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
        target = {mode == 2 || mode == 3 ? selectedBank.load() : message.getChannel() - 1, message.getControllerNumber() - 20};
    if (target.bank < 0 || target.bank >= 10 || target.pad < 0) return;
    if (message.isNoteOff() || (message.isController() && message.getControllerValue() == 0)) {
        if(hasPadLooper(target.bank,target.pad))padLooper.control(PadLooper::release,target.bank,target.pad);
        padEvent(target.bank,target.pad,false,false,0);
        if (activePad.load() == target.bank * 16 + target.pad) activePad.store(-1);
        return; // Cues are one-shot; release does not truncate the track.
    }
    if(recordingMidiGuards.load()>0)return; // Keep releases/panic flowing; suppress only new pad actions.
    selectedBank.store(target.bank);
    const float velocity=midiVelocityEnabled.load()&&message.isNoteOn()?message.getFloatVelocity():1.0f;
    padEvent(target.bank,target.pad,true,false,velocity);
    const bool fine=fineMidiEditors.load()>0;
    if(!fine||hasPadSample(target.bank,target.pad)||hasPadLooper(target.bank,target.pad)||cues[(size_t)target.bank][(size_t)target.pad].load()>=0)
        hit(target.bank,target.pad,!fine&&overwrite.load(),velocity);
    else padEvent(target.bank,target.pad,false,true,velocity,false);
    midiPadHits[(size_t)(target.bank*16+target.pad)].fetch_add(1,std::memory_order_relaxed);lastMidiPad.store(target.bank*16+target.pad,std::memory_order_relaxed);
}

void CueProcessor::hit(int bank, int pad, bool replace, float velocity) {
    if (bank < 0 || bank >= 10 || pad < 0 || pad >= (replayingLoop?16:padCount())) return;
    if(hasPadLooper(bank,pad)){if(!replayingLoop){padLooper.control(PadLooper::press,bank,pad);padEvent(bank,pad,false,true,velocity,false);}return;}
    if(padSampler.trigger(bank*16+pad,velocity)){if(!replayingLoop)padLooper.capture(bank,pad,velocity);activePad.store(bank*16+pad);padEvent(bank,pad,false,true,velocity,false);return;}
    if(current==nullptr)return;
    auto& cue = cues[(size_t) bank][(size_t) pad];
    activePad.store(bank * 16 + pad);
    padEvent(bank,pad,false,true,velocity,false);
    if (replace || cue.load() < 0) {if(!replayingLoop){cue.store(position / current->rate);++cueRevision;}}
    else {if(!replayingLoop){cancelSongChange();padLooper.capture(bank,pad,velocity);}jump(cue.load(), velocity);}
}

void CueProcessor::padEvent(int bank,int pad,bool down,bool triggered,float velocity,bool updateHeld){
    if(bank<0||bank>=10||pad<0||pad>=16)return;
    const auto index=(size_t)(bank*16+pad);
    if(updateHeld&&!replayingLoop){if(down)padStates[index].fetch_or(1u,std::memory_order_relaxed);else padStates[index].fetch_and(~1u,std::memory_order_relaxed);}
    if(triggered){padStates[index].fetch_add(2u,std::memory_order_relaxed);lastTriggeredPad.store((int)index,std::memory_order_relaxed);}
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
    if(command.sourceGeneration>=0&&command.sourceGeneration!=loadGeneration.load())return;
    if(command.nativeTicket){nativeRenderingTicket=command.nativeTicket;nativeRenderingStarted=command.nativeStartedMs;nativeRenderingNeedsAudio=(command.action==Action::cue||command.action==Action::pad)&&!hasPadSample(command.bank,command.pad);}
   #if JUCE_ANDROID
    if(command.androidGeneration>=0&&command.androidGeneration!=loadGeneration.load())return;
    if(command.androidTicket){
        androidRenderingTicket=command.androidTicket;androidRenderingStarted=command.androidStartedMs;
        androidRenderingNeedsAudio=(command.action==Action::cue||command.action==Action::pad)&&!hasPadSample(command.bank,command.pad);
    }
   #endif
    switch (command.action) {
        case Action::pad: hit(command.bank, command.pad, command.overwrite, 1.0f);break;
        case Action::auditionSample: if(command.bank>=0&&command.bank<10&&command.pad>=0&&command.pad<16&&std::isfinite(command.value)&&command.value>=0)padSampler.audition(command.bank*16+command.pad,command.value);break;
        case Action::auditionSource: padSampler.audition(PadSampler::previewSlot,0);break;
        case Action::looperControl: padLooper.control((PadLooper::Control)(int)command.value,command.bank,command.pad);break;
        case Action::markNext:
            if (current == nullptr) break;
            for (int bank = selectedBank.load(); bank < 10; ++bank) {
                for (int pad = 0; pad < padCount(); ++pad) {
                    if (!hasPadSample(bank,pad)&&!hasPadLooper(bank,pad)&&cues[(size_t) bank][(size_t) pad].load() < 0) {
                        selectedBank.store(bank);
                        cues[(size_t) bank][(size_t) pad].store(position / current->rate);
                        padEvent(bank,pad,false,true,1.0f,false);
                        ++cueRevision;
                        return;
                    }
                }
            }
            break;
        case Action::play:
            if (current && !playing.load()) jump(position >= current->frames() - 1 ? 0 : position / current->rate, 1.0f);
            break;
        case Action::cue: if(hasPadSample(command.bank,command.pad)||hasPadLooper(command.bank,command.pad))hit(command.bank,command.pad,false,1.0f);else{cancelSongChange();if(current&&command.pad>=0&&command.pad<16&&!replayingLoop)padLooper.capture(command.bank,command.pad,1);jump(command.value,1.0f);if(current)padEvent(command.bank,command.pad,false,true,1.0f,false);}break;
        case Action::pause: cancelSongChange();requestedPlay.store(false);playing.store(false);cacheWaiting=false;cacheBuffering.store(false); fadeRemaining = 0; break;
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
    const auto samples=padSampler.frame(hostRate);const float song=smoothSongLevel.getNextValue()*songFade.getNextValue(),sample=smoothSampleLevel.getNextValue();for(int c=0;c<2;++c)voice[(size_t)c]=voice[(size_t)c]*song+samples[(size_t)c]*sample;
    for(int c=0;c<2;++c)voice[(size_t)c]=processEffect(voice[(size_t)c],c);
    auto result=nativeFxGraph.process(voice);const float post=smoothCompressorLevel.getNextValue();if(previousCompressor){result=performanceCompressor.process(result);for(auto& value:result)value*=post;}
    if(buffer.getNumChannels()==1)buffer.setSample(0,frame,gain*(nativeFxGraph.enabled()?0.5f*(result[0]+result[1]):result[0]));
    else for(int c=0;c<2;++c)buffer.setSample(c,frame,gain*result[(size_t)c]);
}
juce::File CueProcessor::looperManifest() const {return LibraryStore::defaultDirectory().getChildFile("PadLoopers/"+getSessionId()+".json");}
void CueProcessor::captureLooperSong(){
    if(looperGeneration>0&&padLooper.currentGeneration()==looperGeneration){const auto snapshot=padLooper.snapshot(true);looperSongs.getDynamicObject()->setProperty(juce::Identifier(looperSong),snapshot);}
}
void CueProcessor::prepareLooperSong(const juce::String& id){
    const auto song=id.isEmpty()?juce::String("@empty"):id;std::lock_guard<std::mutex> lock(looperMutex);if(looperGeneration>0&&song==looperSong)return;
    captureLooperSong();looperSong=song;auto restore=PadLooper::restore(looperSongs[juce::Identifier(song)],++looperGeneration);padLooper.publish(std::move(restore));looperDirty.store(true);
}
juce::var CueProcessor::looperState(bool events) const {
    std::lock_guard<std::mutex> lock(looperMutex);auto result=padLooper.snapshot(events);
    if((int)result["generation"]!=looperGeneration){const auto saved=looperSongs[juce::Identifier(looperSong)];result=waveformObject({{"pads",saved["pads"].isArray()?saved["pads"]:juce::var(juce::Array<juce::var>{})},{"revision",padLooper.revision()},{"generation",looperGeneration}});}
    result.getDynamicObject()->setProperty("song",looperSong);return result;
}
juce::var CueProcessor::looperData(){std::lock_guard<std::mutex> lock(looperMutex);captureLooperSong();return waveformObject({{"song",looperSong},{"songs",looperSongs.clone()}});}
void CueProcessor::saveLoopers(){
    std::lock_guard<std::mutex> writer(looperFileMutex);const int revision=padLooper.revision();const auto data=looperData();const auto file=looperManifest();if(!file.getParentDirectory().createDirectory())throw std::runtime_error("Cannot create looper storage");
    juce::TemporaryFile temporary(file);if(!temporary.getFile().replaceWithText(juce::JSON::toString(data))||!temporary.overwriteTargetFileWithTemporary())throw std::runtime_error("Cannot save MIDI pad loopers");lastLooperSaved.store(revision);looperDirty.store(false);
}
juce::var CueProcessor::looperAction(const juce::var& request){
    const auto command=request["cmd"].toString();if(command=="restore"){
        const auto data=request["data"];std::lock_guard<std::mutex> lock(looperMutex);const auto song=data["song"].toString().isNotEmpty()?data["song"].toString():looperSong;auto restore=PadLooper::restore(data,looperGeneration+1);looperSongs.getDynamicObject()->setProperty(juce::Identifier(song),data.clone());if(song==looperSong){++looperGeneration;padLooper.publish(std::move(restore));}looperDirty.store(true);return true;
    }
    const auto bank=request["bank"].toString();const int pad=(int)request["pad"]-1;const juce::StringArray names{"assign","remove","press","release","stop","clear","undo"};const int action=names.indexOf(command);
    if(action<0||bank.length()!=1||bank[0]<'A'||bank[0]>'J'||pad<0||pad>=16)throw std::runtime_error("Invalid looper action");
    Command queued{Action::looperControl,(int)bank[0]-'A',pad,(double)action};queued.sourceGeneration=audioGeneration();if(!submit(queued))throw std::runtime_error("Looper command queue is full");return true;
}
void CueProcessor::remapLoopers(const juce::var& mappings,const juce::String& scope){
    if(!mappings.isArray())throw std::runtime_error("Invalid looper pad mapping");
    std::lock_guard<std::mutex> lock(looperMutex);captureLooperSong();auto songs=looperSongs.clone();
    for(auto& song:songs.getDynamicObject()->getProperties()){
        if(scope!="all"&&song.name.toString()!=(scope.isEmpty()?juce::String("@empty"):scope))continue;auto pads=song.value["pads"];if(!pads.isArray())continue;
        for(auto& clip:*pads.getArray())for(const auto& mapping:*mappings.getArray()){
            const auto bank=mapping["bank"].toString();const auto order=mapping["pads"];if(!order.isArray())throw std::runtime_error("Invalid looper pad mapping");const int pad=(int)clip["pad"];
            if(clip["bank"].toString()==bank&&pad>=1&&pad<=order.size()){int destination=-1;for(int i=0;i<order.size();++i)if((int)order[i]==pad)destination=i+1;if(destination<1)throw std::runtime_error("Invalid looper pad permutation");clip.getDynamicObject()->setProperty("pad",destination);}
            if(scope=="all"&&clip["events"].isArray())for(auto& value:*clip["events"].getArray()){
                auto word=(uint64_t)(juce::int64)value;const int eventBank=(int)((word>>32)&15),eventPad=(int)((word>>36)&15);if(bank==juce::String::charToString((juce::juce_wchar)('A'+eventBank))&&eventPad<order.size())for(int i=0;i<order.size();++i)if((int)order[i]==eventPad+1){word=(word&~(15ull<<36))|((uint64_t)i<<36);value=(juce::int64)word;break;}
            }
        }
    }
    auto restore=PadLooper::restore(songs[juce::Identifier(looperSong)],looperGeneration+1);looperSongs=songs;++looperGeneration;padLooper.publish(std::move(restore));looperDirty.store(true);
}
juce::var CueProcessor::mixerState() const {return waveformObject({{"enabled",compressorEnabled.load()},{"song",songLevel.load()},{"samples",sampleLevel.load()},{"output",compressorLevel.load()}});}
void CueProcessor::setMixer(const juce::var& value){
    if(!value.isObject())throw std::runtime_error("Invalid mixer settings");
    const auto level=[&](const char* key,float current){if(!value.hasProperty(key))return current;const auto input=value[key];const double number=(double)input;if((!input.isInt()&&!input.isInt64()&&!input.isDouble())||!std::isfinite(number)||number<0||number>2)throw std::runtime_error("Mixer level must be between zero and two");return (float)number;};
    const float song=level("song",songLevel.load()),samples=level("samples",sampleLevel.load()),output=level("output",compressorLevel.load());if(value.hasProperty("enabled")&&!value["enabled"].isBool())throw std::runtime_error("Compressor enabled must be boolean");
    songLevel.store(song);sampleLevel.store(samples);compressorLevel.store(output);if(value.hasProperty("enabled"))compressorEnabled.store((bool)value["enabled"]);
    int latency;{std::lock_guard<std::mutex> lock(metadataMutex);latency=beatmaker::dsp::FxGraph::latency(requestedFxGraph,fxControlRate.load());}
    setLatencySamples(latency+(compressorEnabled.load()?(int)juce::jmin(1023.0,.006*fxControlRate.load()):0));
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
    latency+=compressorEnabled.load()?(int)juce::jmin(1023.0,.006*fxControlRate.load()):0;if(getLatencySamples()!=latency)setLatencySamples(latency);
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
void CueProcessor::render(juce::AudioBuffer<float>& buffer,int start,int count){
    while(count>0){padLooper.fire([this](const PadLooper::Event& event){replayingLoop=true;hit(event.bank,event.pad,false,event.velocity/127.0f);replayingLoop=false;});
        const int length=padLooper.segment(count,hostRate);renderCore(buffer,start,length);padLooper.advance(length,hostRate);start+=length;count-=length;}
}
void CueProcessor::renderCore(juce::AudioBuffer<float>& buffer, int start, int count) {
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
   #if JUCE_ANDROID
    const auto androidCallbackStarted=juce::Time::getMillisecondCounterHiRes();
   #endif
    juce::ScopedNoDenormals noDenormals;
    const bool host=hostedInput();int monitored=0;
    if(host){
        const int inputs=juce::jmin(2,juce::jmin(getTotalNumInputChannels(),output.getNumChannels()));hostBusChannels.store(inputs);const bool active=hostInputEnabled.load()&&inputs>0;inputChannels.store(active?inputs:0);inputRate.store(hostRate);monitorInput.store(active&&hostMonitorRequested.load());
        if(active){recorder.capture(output.getArrayOfReadPointers(),inputs,output.getNumSamples(),hostRate,false);float peak=0;for(int c=0;c<inputs;++c)for(int i=0;i<output.getNumSamples();++i)if(std::isfinite(output.getSample(c,i)))peak=juce::jmax(peak,std::abs(output.getSample(c,i)));inputPeak.store(juce::jmax(peak,inputPeak.load()*(float)std::exp(-output.getNumSamples()/(hostRate*.3))));}
        else{inputPeak.store(0);recorder.capture(nullptr,0,output.getNumSamples(),hostRate,false);if(hostMonitorRequested.load())monitorInput.store(false);}
        if(monitorInput.load()&&output.getNumSamples()<=hostMonitorCopy.getNumSamples()){monitored=output.getNumSamples();for(int c=0;c<2;++c){const auto* source=output.getReadPointer(juce::jmin(c,inputs-1));auto* target=hostMonitorCopy.getWritePointer(c);for(int i=0;i<monitored;++i)target[i]=std::isfinite(source[i])?juce::jlimit(-1.0f,1.0f,source[i]):0;}}
    }
    juce::AudioBuffer<float> mainOutput(output.getArrayOfWritePointers(),juce::jmin(output.getNumChannels(),getTotalNumOutputChannels()),output.getNumSamples());
    const auto fade=fadeRequested.load();if(fade!=fadeObserved){fadeObserved=fade;songFade.reset(hostRate,transitionSeconds.load());songFade.setTargetValue(fade?0.0f:1.0f);}
    padLooper.beginBlock();
    smoothSongLevel.setTargetValue(songLevel.load());smoothSampleLevel.setTargetValue(sampleLevel.load());smoothCompressorLevel.setTargetValue(compressorLevel.load());
    const bool compressor=compressorEnabled.load();if(compressor!=previousCompressor){performanceCompressor.reset();previousCompressor=compressor;}
    if(!playing.load()){smoothedSpeed.setCurrentAndTargetValue(speedValue->load());smoothedTuning.setCurrentAndTargetValue(semitones.load());}
    beatmaker::dsp::FxState update;if(fxGraphUpdates.consume(update))nativeFxGraph.configure(update);
    const auto effect=requestedEffectKernel.load();currentEffectKernel=(beatmaker::dsp::Kernel)(effect&255);currentEffectBits=(int)((effect>>8)&255);
    const auto effectGain=(juce::uint32)(effect>>16);std::memcpy(&currentEffectAmount,&effectGain,sizeof(currentEffectAmount));
    output.clear();
    Sample* next;
    do { next = published.load(); audioHazard.store(next); } while (next != published.load());
    if (next != current) {
        nativeRenderingTicket=0;
       #if JUCE_ANDROID
        androidRenderingTicket=0;
       #endif
        current = next;
        if(current){fadeRequested.store(0);fadeObserved=0;if(fadeInNext.exchange(false)&&transitionsEnabled.load()){songFade.reset(hostRate,transitionSeconds.load());songFade.setCurrentAndTargetValue(0);songFade.setTargetValue(1);}else songFade.setCurrentAndTargetValue(1);}
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
        render(mainOutput, rendered, offset - rendered);
        if(metadata.numBytes<=3)handleMidi(metadata.getMessage()); // Ignore unsupported SysEx without allocating a copied message.
        rendered = offset;
    }
    render(mainOutput, rendered, output.getNumSamples() - rendered);
    recorder.capture(mainOutput.getArrayOfReadPointers(),mainOutput.getNumChannels(),mainOutput.getNumSamples(),hostRate,true);
    if(monitored&&monitorInput.load()&&hostMonitorRequested.load()){const float level=monitorLevel.load();for(int c=0;c<mainOutput.getNumChannels();++c)mainOutput.addFrom(c,0,hostMonitorCopy,c,0,monitored,level);}
    // The main-bus view aliases this buffer, but its clear flag is independent.
    // Hosts must see the rendered samples rather than an obsolete silence flag.
    output.setNotClear();
    if(fadeObserved&&songFade.getTargetValue()==0&&!songFade.isSmoothing())fadeCompleted.store(fadeObserved);
    if(current&&current->paged)current->paged->releasePages();
    if(loadFirstRenderMs.load()==0&&current&&current==published.load()&&measuredLoadGeneration.load()==loadGeneration.load()&&loadPublishedMs.load()>0)loadFirstRenderMs.store(juce::Time::getMillisecondCounterHiRes());
    playhead.store(current ? position / current->rate : 0);
    if(nativeRenderingTicket&&(!nativeRenderingNeedsAudio||!cacheWaiting)){
        nativePadInputRenderMs.store(juce::Time::getMillisecondCounterHiRes()-nativeRenderingStarted);nativePadInputRendered.store(nativeRenderingTicket);nativeRenderingTicket=0;
    }
   #if JUCE_ANDROID
    const auto androidFinished=juce::Time::getMillisecondCounterHiRes();
    const auto androidElapsed=androidFinished-androidCallbackStarted;
    androidCallbackFrames.store(output.getNumSamples());androidCallbackMs.store(androidElapsed);
    if(androidElapsed>androidPeakCallbackMs.load())androidPeakCallbackMs.store(androidElapsed);
    // A cache-wait callback fades to silence; it has not rendered the requested
    // cue. Keep timing until the target PCM actually reaches the renderer.
    if(androidRenderingTicket&&(!androidRenderingNeedsAudio||!cacheWaiting)){
        androidFastLastRenderMs.store(androidFinished-androidRenderingStarted);androidFastRendered.store(androidRenderingTicket);androidRenderingTicket=0;
    }
   #endif
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
juce::var CueProcessor::unloadSong(){
    prepareLooperSong({});
    const auto previous=getWebCues();setWebState(sessionUiState());
    std::lock_guard<std::mutex> lock(metadataMutex);
    ++loadGeneration;++queueGeneration;manualQueueRequest.store(0);manualQueueIntent.store(-1);needAdvance.store(false);restartAtZero.store(false);
    nativeQueue=waveformObject({{"tracks",juce::Array<juce::var>{}},{"index",0},{"repeat","off"}});nativeIndex.store(0);webTrack={};samplePath={};
    requestedPlay.store(false);playing.store(false);ready.store(false);published.store(nullptr);nativeAdvancing.store(false);nativeEnded.store(false);
    durationSeconds.store(0);restorePosition.store(0);playhead.store(0);loopEnabled.store(false);loopIn.store(-1);loopOut.store(-1);activePad.store(-1);cacheBuffering.store(false);
    for(auto& bank:cues)for(auto& cue:bank)cue.store(-1);++cueRevision;status="Empty track · ready to record";
    return previous;
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
    if(sample&&sample->paged){
        result->setProperty("cachedPages",sample->paged->loadedPages());result->setProperty("decoderPageReads",sample->paged->decoderReads());
        result->setProperty("cueCacheBank",selectedBank.load());result->setProperty("readyCueHeads",sample->paged->readyCueHeads(selectedBank.load()));
    }
    result->setProperty("generation",measuredLoadGeneration.load());result->setProperty("downloadMs",loadDownloadMs.load());result->setProperty("decoderInitMs",loadDecoderMs.load());result->setProperty("pcmReadMs",loadPcmReadMs.load());
    result->setProperty("requestToPublishMs",publishedAt>0?publishedAt-start:-1);result->setProperty("requestToFirstRenderMs",first>0?first-start:-1);result->setProperty("note","First-render timing measures buffer processing, excluding earlier UI URL resolution, FX look-ahead (reported separately) and physical device output latency");return juce::var(result);
}
double CueProcessor::getDuration() const {return durationSeconds.load();}

void CueProcessor::getStateInformation(juce::MemoryBlock& destination) {
    juce::XmlElement state("BeatmakerCuesPrototype");
    state.createNewChildElement("EffectKernel")->addTextElement(juce::JSON::toString(effectKernelState()));
    state.createNewChildElement("NativeFxGraph")->addTextElement(juce::JSON::toString(fxGraphState()));
    state.createNewChildElement("PadSamples")->addTextElement(juce::JSON::toString(padSamples()));
    state.createNewChildElement("Mixer")->addTextElement(juce::JSON::toString(mixerState()));
    state.createNewChildElement("SongTransitions")->addTextElement(juce::JSON::toString(transitions()));
    if(hostedInput())state.createNewChildElement("HostAudioInput")->addTextElement(juce::JSON::toString(hostAudioState()));
    state.createNewChildElement("PadLoopers")->addTextElement(juce::JSON::toString(looperData()));
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
    state.setAttribute("midiVelocity",midiVelocityEnabled.load());
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
    setMixer(state->getChildByName("Mixer")?juce::JSON::parse(state->getChildByName("Mixer")->getAllSubText()):juce::JSON::parse(R"({"enabled":false,"song":1,"samples":1,"output":1.5})"));
    setTransitions(state->getChildByName("SongTransitions")?juce::JSON::parse(state->getChildByName("SongTransitions")->getAllSubText()):juce::JSON::parse(R"({"enabled":true,"seconds":0.35})"));
    if(hostedInput())restoreHostAudio(state->getChildByName("HostAudioInput")?juce::JSON::parse(state->getChildByName("HostAudioInput")->getAllSubText()):juce::var{});
    {const auto saved=state->getChildByName("PadLoopers")?juce::JSON::parse(state->getChildByName("PadLoopers")->getAllSubText()):juce::var{};std::lock_guard<std::mutex> lock(looperMutex);
        looperSongs=saved["songs"].isObject()?saved["songs"].clone():juce::var(new juce::DynamicObject);looperSong=saved["song"].toString();if(looperSong.isEmpty())looperSong="@empty";padLooper.publish(PadLooper::restore(looperSongs[juce::Identifier(looperSong)],++looperGeneration));looperDirty.store(true);}
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
    preset.store(juce::jlimit(0, 3, state->getIntAttribute("preset")));
    overwrite.store(state->getBoolAttribute("overwrite"));
    midiVelocityEnabled.store(state->getBoolAttribute("midiVelocity",true));
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
    if(parsed["musike:transitions"].isString())try{setTransitions(juce::JSON::parse(parsed["musike:transitions"].toString()));}catch(...) {}
    if(hostedInput()&&parsed["musike:audio:routes"].isString()){const auto audio=juce::JSON::parse(parsed["musike:audio:routes"].toString());if(audio["input"].toString()=="host")restoreHostAudio(audio);}
    if(parsed.hasProperty("musike:midi:velocity"))midiVelocityEnabled.store(parsed["musike:midi:velocity"].toString()!="off");
    {std::lock_guard<std::mutex> lock(metadataMutex);if(parsed.hasProperty("plugin-file:library.json"))legacyState=state;}
    if(auto* fields=parsed.getDynamicObject()){
        fields->removeProperty("plugin-file:library.json");fields->removeProperty("plugin-file:library.tmp.json");
    }
    std::lock_guard<std::mutex> lock(metadataMutex);
    if(songPlaybackEnabled.load()&&parsed.hasProperty("musike:track-playback")){
        const auto playback=juce::JSON::parse(parsed["musike:track-playback"].toString());
        if(const auto* saved=playback.getDynamicObject()){
            if(!trackPlaybackSettings.isObject())trackPlaybackSettings=juce::var(new juce::DynamicObject);
            for(const auto& entry:saved->getProperties())if(entry.value.isObject())trackPlaybackSettings.getDynamicObject()->setProperty(entry.name,cleanTrackPlayback(entry.value));
        }
    }
    webState = juce::JSON::toString(parsed);
}
juce::String CueProcessor::getWebState() const { std::lock_guard<std::mutex> lock(metadataMutex); return webState; }
juce::String CueProcessor::sessionUiState() const {
    const auto original=getWebState();auto state=juce::JSON::parse(original);if(!state.isObject())state=juce::var(new juce::DynamicObject);
    if(hostRestored.load()||state.hasProperty("musike:midi:velocity"))state.getDynamicObject()->setProperty("musike:midi:velocity",midiVelocityEnabled.load()?"on":"off");
    if(songPlaybackEnabled.load()){
        std::lock_guard<std::mutex> lock(metadataMutex);
        state.getDynamicObject()->setProperty("musike:track-playback",juce::JSON::toString(trackPlaybackSettings.isObject()?trackPlaybackSettings:juce::var(new juce::DynamicObject)));
    }
    state.getDynamicObject()->setProperty("musike:transitions",juce::JSON::toString(transitions()));
    if(hostedInput())state.getDynamicObject()->setProperty("musike:audio:routes",juce::JSON::toString(hostAudioState()));
    if(wrapperType!=wrapperType_Standalone&&wrapperType!=wrapperType_Undefined){
        const char* names[]={"sp404mkii-a","sp404mkii-b","legacy12","linear16"};
        state.getDynamicObject()->setProperty("musike:midi:preset",juce::String(names[juce::jlimit(0,3,preset.load())]));
    }
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
        if(hostRestored.load()||songPlaybackEnabled.load()){
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
    preset.store(mapping == "linear16" ? 3 : mapping == "legacy12" ? 2 : mapping == "sp404mkii-b" ? 1 : 0);
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

juce::var CueProcessor::trackPlayback(const juce::String& id) const {
    std::lock_guard<std::mutex> lock(metadataMutex);return cleanTrackPlayback(trackPlaybackSettings[juce::Identifier(id)]);
}
void CueProcessor::applyTrackPlayback(const juce::String& id){
    if(!songPlaybackEnabled.load()||id.isEmpty())return;
    const auto value=trackPlayback(id);preservePitch.store(value["speedMode"].toString()!="pitch");semitones.store((float)value["tuning"]);
    auto* parameter=parameters.getParameter("speed");const auto target=parameter->convertTo0to1(1.0f+(float)value["speed"]/100.0f);
    if(std::abs(parameter->getValue()-target)>.00001f)parameter->setValueNotifyingHost(target);
}
bool CueProcessor::setTrackPlayback(const juce::String& id,const juce::var& settings){
    if(!songPlaybackEnabled.load()||id.isEmpty())return false;
    const auto clean=cleanTrackPlayback(settings);
    {std::lock_guard<std::mutex> lock(metadataMutex);const auto tracks=nativeQueue["tracks"];const int index=nativeIndex.load();
        if(!tracks.isArray()||index<0||index>=tracks.size()||tracks[index]["id"].toString()!=id)return false;
        if(!trackPlaybackSettings.isObject())trackPlaybackSettings=juce::var(new juce::DynamicObject);
        trackPlaybackSettings.getDynamicObject()->setProperty(juce::Identifier(id),clean);
    }
    applyTrackPlayback(id);return true;
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
    if(!prefetch){prepareLooperSong(trackId);applyTrackPlayback(trackId);}
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
    persistPadSamples(padSamples());
}
void CueProcessor::persistPadSamples(const juce::var& pads){
    std::lock_guard<std::mutex> lock(padSamplePersistenceMutex);
    double tail=0;if(const auto* values=pads.getArray())for(const auto& pad:*values)tail=juce::jmax(tail,(double)pad["duration"]);
    const auto file=padSampleManifest();if(!file.getParentDirectory().createDirectory())throw std::runtime_error("Cannot create pad sample storage");
    juce::TemporaryFile temporary(file);if(!temporary.getFile().replaceWithText(juce::JSON::toString(pads))||!temporary.overwriteTargetFileWithTemporary())throw std::runtime_error("Cannot save pad sample assignments");padSampleTail.store(tail);
   #if JUCE_IOS
    appleAllowBackgroundFileAccess(file);appleAllowBackgroundFileAccess(file.getParentDirectory());
   #endif
}
juce::var CueProcessor::importPadSample(int bank,int pad,const juce::File& input){
    return importPadSample(bank,pad,juce::URL(input));
}
juce::var CueProcessor::importPadSample(int bank,int pad,const juce::URL& input){
    if(bank<0||bank>=10||pad<0||pad>=16)throw std::runtime_error("Invalid sample pad");
    const int slot=bank*16+pad,ticket=padSampler.reserve(slot);
    juce::String name=juce::URL::removeEscapeChars(input.getFileName());std::unique_ptr<juce::InputStream> source;
   #if JUCE_ANDROID
    if(input.getScheme()=="content"){
        const auto document=juce::AndroidDocument::fromDocument(input);
        if(document){name=document.getInfo().getName();source=document.createInputStream();}
    }else
   #endif
    source=input.createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress));
    if(!source)throw std::runtime_error("Cannot open the selected sample");
    name=juce::File::createLegalFileName(name);if(name.isEmpty())name="Sample";
    const auto extension=name.containsChar('.')?name.fromLastOccurrenceOf(".",true,false):juce::String{};
    const auto directory=libraryStore.mediaDirectory().getChildFile("PadSamples");
    if(!directory.createDirectory())throw std::runtime_error("Cannot create sample media storage");
    const auto destination=directory.getChildFile(juce::Uuid().toString()+extension);
    {auto output=destination.createOutputStream();if(!output)throw std::runtime_error("Cannot create the app-local sample copy");
        const auto bytes=output->writeFromInputStream(*source,-1);output->flush();
        if(bytes<=0||(source->getTotalLength()>0&&bytes!=source->getTotalLength())||output->getStatus().failed()){output.reset();destination.deleteFile();throw std::runtime_error("Cannot retain a complete app-local copy of this sample");}}
   #if JUCE_IOS
    appleAllowBackgroundFileAccess(directory);appleAllowBackgroundFileAccess(destination);
   #endif
    try{
        juce::AudioFormatManager formats;formats.registerBasicFormats();juce::String error;
        auto reader=mediaReader(formats,destination,error);
        if(!reader)throw std::runtime_error(error.isNotEmpty()?error.toStdString():"Cannot decode this sample");
        padSampler.load(slot,std::move(reader),destination.getFullPathName(),name.upToLastOccurrenceOf(".",false,false),ticket);
    }catch(...){destination.deleteFile();throw;}
    persistPadSamples();return padSamples();
}
juce::var CueProcessor::removePadSample(int bank,int pad){
    if(bank<0||bank>=10||pad<0||pad>=16)throw std::runtime_error("Invalid sample pad");
    padSampler.clear(bank*16+pad);persistPadSamples();return padSamples();
}
juce::var CueProcessor::remapPadSamples(const juce::var& mappings){
    if(!mappings.isArray()||mappings.size()>10)throw std::runtime_error("Invalid pad move");
    std::array<int,PadSampler::slots> source{},inverse{};std::array<bool,10> banks{};
    for(int slot=0;slot<PadSampler::slots;++slot)source[(size_t)slot]=slot;
    for(const auto& row:*mappings.getArray()){
        const auto bank=row["bank"].toString();const auto pads=row["pads"];
        if(bank.length()!=1||bank[0]<'A'||bank[0]>'J'||!pads.isArray()||pads.size()<1||pads.size()>16)throw std::runtime_error("Invalid pad move");
        const int b=(int)bank[0]-'A';if(banks[(size_t)b])throw std::runtime_error("Duplicate pad bank");banks[(size_t)b]=true;std::array<bool,16> used{};
        for(int p=0;p<pads.size();++p){const double value=(double)pads[p];
            if(!std::isfinite(value)||value<1||value>pads.size()||value!=std::floor(value))throw std::runtime_error("Invalid pad permutation");
            const int from=(int)value-1;if(used[(size_t)from])throw std::runtime_error("Invalid pad permutation");
            used[(size_t)from]=true;source[(size_t)(b*16+p)]=b*16+from;}
    }
    for(int slot=0;slot<PadSampler::slots;++slot)inverse[(size_t)source[(size_t)slot]]=slot;
    padSampler.reassign(source);
    try{persistPadSamples();}catch(...){padSampler.reassign(inverse);throw;}
    return padSamples();
}
juce::var CueProcessor::editPadSample(int bank,int pad,double start){
    if(bank<0||bank>=10||pad<0||pad>=16)throw std::runtime_error("Invalid sample pad");
    padSampler.setStart(bank*16+pad,start);persistPadSamples();return padSamples();
}
juce::var CueProcessor::restorePadSample(int bank,int pad,const juce::var& descriptor){
    if(bank<0||bank>=10||pad<0||pad>=16)throw std::runtime_error("Invalid sample pad");
    if(!descriptor.isObject())return removePadSample(bank,pad);
    const juce::File file(descriptor["path"].toString());
    if(!file.isAChildOf(libraryStore.mediaDirectory().getChildFile("PadSamples"))||!file.existsAsFile())throw std::runtime_error("The retained sample is unavailable");
    juce::AudioFormatManager formats;formats.registerBasicFormats();juce::String error;auto reader=mediaReader(formats,file,error);
    if(!reader)throw std::runtime_error("Cannot restore the retained sample");
    const int slot=bank*16+pad,ticket=padSampler.reserve(slot);padSampler.load(slot,std::move(reader),file.getFullPathName(),descriptor["name"].toString(),ticket,(double)descriptor["start"]);
    persistPadSamples();return padSamples();
}
juce::var CueProcessor::waveformRegion(const juce::var& request){
    const double from=(double)request["from"],to=(double)request["to"];const int bins=juce::jlimit(64,2048,(int)request["bins"]);
    if(!std::isfinite(from)||!std::isfinite(to)||from<0||to<=from||to-from>10.001)throw std::runtime_error("Invalid waveform window");
    if((bool)request["sample"]){const auto bank=request["bank"].toString();const int pad=(int)request["pad"]-1;
        if(bank.length()!=1||bank[0]<'A'||bank[0]>'J'||pad<0||pad>=16)throw std::runtime_error("Invalid waveform pad");
        return padSampler.waveform(((int)bank[0]-'A')*16+pad,from,to,bins);}
    const auto id=request["trackId"].toString();const int generation=audioGeneration();
    if(!ready.load()||nativeSnapshot()["trackId"].toString()!=id)throw std::runtime_error("Song changed");
    juce::String path;{std::lock_guard<std::mutex> lock(metadataMutex);path=samplePath;}
    juce::AudioFormatManager formats;formats.registerBasicFormats();juce::String error;
    auto reader=mediaReader(formats,juce::File(path),error,[this,generation]{return stopQueue.load()||generation!=audioGeneration();});
    if(!reader||reader->sampleRate<=0)throw std::runtime_error("Waveform audio is unavailable");
    const auto first=juce::jlimit((juce::int64)0,reader->lengthInSamples,(juce::int64)(from*reader->sampleRate));
    const auto last=juce::jlimit(first,reader->lengthInSamples,(juce::int64)std::ceil(to*reader->sampleRate));
    std::vector<float> values((size_t)bins,0);juce::AudioBuffer<float> chunk(juce::jlimit(1,2,(int)reader->numChannels),65536);
    for(auto offset=first;offset<last;){if(generation!=audioGeneration())throw std::runtime_error("Song changed");
        const int count=(int)juce::jmin((juce::int64)65536,last-offset);if(!reader->read(&chunk,0,count,offset,true,chunk.getNumChannels()>1))break;
        for(int i=0;i<count;++i){const auto bin=(size_t)juce::jmin((juce::int64)bins-1,(offset+i-first)*bins/juce::jmax((juce::int64)1,last-first));for(int c=0;c<chunk.getNumChannels();++c)values[bin]=juce::jmax(values[bin],std::abs(chunk.getSample(c,i)));}offset+=count;}
    juce::Array<juce::var> peaks;for(float value:values)peaks.add(value);auto* result=new juce::DynamicObject;
    result->setProperty("peaks",peaks);result->setProperty("from",from);result->setProperty("to",to);result->setProperty("duration",reader->lengthInSamples/reader->sampleRate);return juce::var(result);
}

void CueProcessor::restorePadSamples(const juce::var& saved){
    for(int slot=0;slot<PadSampler::slots;++slot)padSampler.clear(slot);
    struct Restore {int slot,ticket;juce::String path,name;double start;};std::vector<Restore> restore;
    if(const auto* pads=saved.getArray())for(const auto& value:*pads){
        const auto bank=value["bank"].toString();const int pad=(int)value["pad"]-1;
        if(bank.length()!=1||bank[0]<'A'||bank[0]>'J'||pad<0||pad>=16||!juce::File::isAbsolutePath(value["path"].toString()))continue;
        const int slot=((int)bank[0]-'A')*16+pad;const auto path=value["path"].toString(),name=value["name"].toString();
        restore.push_back({slot,padSampler.pending(slot,path,name),path,name,(double)value["start"]});
    }
    padSampleTail.store(0);
    if(restore.empty())return;
    padSampleLoaders.addJob([this,restore=std::move(restore)]{
        for(const auto& item:restore){if(stopQueue.load())return;
            try{juce::AudioFormatManager formats;formats.registerBasicFormats();juce::String error;
                auto reader=mediaReader(formats,juce::File(item.path),error,[this]{return stopQueue.load();});
                if(!reader)throw std::runtime_error(error.isNotEmpty()?error.toStdString():"Sample file is missing or unreadable; replace or remove it");
                padSampler.load(item.slot,std::move(reader),item.path,item.name,item.ticket,item.start);
            }catch(const std::exception& error){padSampler.failed(item.slot,item.ticket,error.what());}
        }
        padSampleTail.store(padSampler.tailSeconds());
    });
}

juce::var CueProcessor::importLocalFile(const juce::File& input){
    return importLocalAudio(juce::URL(input));
}
juce::var CueProcessor::eraseLocalAudio(const juce::String& id){
    juce::StringArray protectedPaths;const auto samples=padSamples();for(const auto& sample:*samples.getArray())protectedPaths.add(sample["path"].toString());
    auto result=libraryStore.eraseLocalMedia(id,protectedPaths);
    {std::lock_guard<std::mutex> lock(looperMutex);looperSongs.getDynamicObject()->removeProperty(juce::Identifier(id));looperDirty.store(true);}
    auto state=juce::JSON::parse(getWebState());for(const auto* key:{"musike:cues:v1","musike:loops","musike:track-playback"}){auto data=juce::JSON::parse(state[key].toString());if(auto* fields=data.getDynamicObject()){fields->removeProperty(juce::Identifier(id));state.getDynamicObject()->setProperty(key,juce::JSON::toString(data));}}
    {std::lock_guard<std::mutex> lock(metadataMutex);if(auto* playback=trackPlaybackSettings.getDynamicObject())playback->removeProperty(juce::Identifier(id));}
    setWebState(juce::JSON::toString(state));libraryStore.writePreferences(sessionUiState(),getSessionId());return result;
}
juce::var CueProcessor::prepareLocalAudioExport(const juce::String& id){
    if(!id.startsWith("loc")||id.length()!=11||!id.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"))throw std::runtime_error("Select an imported file or recording to export");
    const auto entry=libraryStore.media(id);const auto path=entry["path"].toString();
    if(!entry.isObject()||path.isEmpty())throw std::runtime_error("Retained audio is unavailable");
    const juce::File original(path);if(!original.isAChildOf(libraryStore.mediaDirectory())||!original.existsAsFile()||original.getSize()<1)throw std::runtime_error("The original audio file is unavailable");
    auto name=juce::File::createLegalFileName(entry["title"].toString()).trim().substring(0,120);if(name.isEmpty())name="Beatmaker audio";
    if(!name.endsWithIgnoreCase(original.getFileExtension()))name+=original.getFileExtension();
    const auto folder=juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("Beatmaker-Audio-Export-"+juce::Uuid().toString());
    const auto file=folder.getChildFile(name);
    if(!folder.createDirectory()||!original.copyFileTo(file)||file.getSize()!=original.getSize()){folder.deleteRecursively();throw std::runtime_error("Cannot prepare a complete audio export");}
   #if JUCE_IOS
    appleAllowBackgroundFileAccess(folder);appleAllowBackgroundFileAccess(file);
   #endif
    return waveformObject({{"path",file.getFullPathName()},{"folder",folder.getFullPathName()},{"name",name}});
}

juce::var CueProcessor::recording(const juce::var& request){
    const auto command=request["cmd"].toString();
    if(command=="start"){
        if(request["source"].toString()!="input"&&request["source"].toString()!="playback")throw std::runtime_error("Select a recording source");
        const bool playback=request["source"].toString()=="playback";
        if(!playback&&inputChannels.load()<1)throw std::runtime_error("Enable an audio input before recording");
        const auto file=libraryStore.mediaDirectory().getChildFile("Recordings").getChildFile("Recording-"+juce::Time::getCurrentTime().formatted("%Y-%m-%d-%H%M%S")+"-"+juce::Uuid().toString().substring(0,8)+".wav");
        recorder.start(file,playback?playbackRate.load():inputRate.load(),playback);
       #if JUCE_IOS
        appleAllowBackgroundFileAccess(file);appleAllowBackgroundFileAccess(file.getParentDirectory());
       #endif
        return recorder.state();
    }
    if(command=="stop"){
        auto take=recorder.finish();if(!take.isObject())return {};
        const juce::File file(take["path"].toString());if((juce::int64)take["frames"]<2){file.deleteFile();throw std::runtime_error("No audio was captured");}
        return waveformObject({{"track",registerRecording(file,take["source"].toString())},{"message",take["message"]}});
    }
    if(command=="recover"){
        juce::Array<juce::var> recovered;if(recorder.hasTake())return juce::var(recovered);
        const auto registered=libraryStore.allMedia();juce::StringArray paths;for(const auto& track:*registered.getArray())paths.add(track["path"].toString());
        for(const auto& file:libraryStore.mediaDirectory().getChildFile("Recordings").findChildFiles(juce::File::findFiles,false,"*.wav"))if(!paths.contains(file.getFullPathName())){try{recovered.add(registerRecording(file,"input"));}catch(const std::exception&) {}}
        return juce::var(recovered);
    }
    auto state=recorder.state();state.getDynamicObject()->setProperty("inputPeak",inputPeak.load());return state;
}
juce::var CueProcessor::registerRecording(const juce::File& file,const juce::String& source){
    juce::AudioFormatManager formats;formats.registerBasicFormats();juce::String error;auto reader=mediaReader(formats,file,error);
    if(!reader||reader->lengthInSamples<2)throw std::runtime_error("The take was retained but could not be decoded");
    const auto id="loc"+juce::Uuid().toString().removeCharacters("-").substring(0,8);
    auto track=waveformObject({{"id",id},{"title",file.getFileNameWithoutExtension()},{"artist",source=="playback"?"Recorded Beatmaker playback":"Recorded audio input"},{"kind","song"},{"duration",reader->lengthInSamples/reader->sampleRate},{"path",file.getFullPathName()},{"thumb",""},{"art",""},{"recorded",true}});
    libraryStore.registerMedia(id,track);return track;
}
juce::var CueProcessor::importLocalAudio(const juce::URL& input){
    juce::String name=juce::File::createLegalFileName(juce::URL::removeEscapeChars(input.getFileName()));
    std::unique_ptr<juce::InputStream> stream;
   #if JUCE_ANDROID
    if(input.getScheme()=="content"){const auto document=juce::AndroidDocument::fromDocument(input);if(document){name=document.getInfo().getName();stream=document.createInputStream();}}else
   #endif
    stream=input.createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress));
    if(!stream)throw std::runtime_error("Cannot open the selected audio file");
    if(name.isEmpty())name="Imported audio";
    const auto id="loc"+juce::Uuid().toString().removeCharacters("-").substring(0,8);
    const auto directory=libraryStore.mediaDirectory();if(!directory.createDirectory())throw std::runtime_error("Cannot create media storage");
    const auto extension=name.containsChar('.')?name.fromLastOccurrenceOf(".",true,false):juce::String{};
    const auto destination=directory.getChildFile(id+extension);
    try{
    {auto output=destination.createOutputStream();if(!output)throw std::runtime_error("Cannot create an app-local audio copy");
        constexpr juce::int64 limit=1024ll*1024*1024;const auto bytes=output->writeFromInputStream(*stream,limit+1);output->flush();
        if(bytes<1||bytes>limit||(stream->getTotalLength()>0&&bytes!=stream->getTotalLength())||output->getStatus().failed())throw std::runtime_error("Cannot retain the complete audio file (maximum 1 GiB per import)");}
    juce::AudioFormatManager formats;formats.registerBasicFormats();juce::String error;auto reader=mediaReader(formats,destination,error);
    if(!reader||reader->sampleRate<=0||reader->lengthInSamples<2)throw std::runtime_error("Cannot decode audio from this file");
    if(reader->lengthInSamples>PagedAudio::maxFrames)throw std::runtime_error("Audio exceeds the supported frame range");
   #if JUCE_IOS
    appleAllowBackgroundFileAccess(directory);appleAllowBackgroundFileAccess(destination);
   #endif
    auto* metadata=new juce::DynamicObject;
    metadata->setProperty("id",id);metadata->setProperty("title",name.containsChar('.')?name.upToLastOccurrenceOf(".",false,false):name);metadata->setProperty("artist","Local audio");
    metadata->setProperty("duration",reader->lengthInSamples/reader->sampleRate);metadata->setProperty("path",destination.getFullPathName());
    metadata->setProperty("kind","song");metadata->setProperty("thumb","");metadata->setProperty("art","");
    juce::var result(metadata);libraryStore.registerMedia(id,result);return result;
    }catch(...){destination.deleteFile();throw;}
}

namespace {
std::unique_ptr<juce::AudioFormatReader> samplerReader(LibraryStore& store,const juce::String& id){
    const auto entry=store.media(id);const juce::File file(entry["path"].toString());
    if(!entry.isObject()||!file.isAChildOf(store.mediaDirectory())||!file.existsAsFile())throw std::runtime_error("Retained source audio is unavailable");
    juce::AudioFormatManager formats;formats.registerBasicFormats();juce::String error;auto reader=mediaReader(formats,file,error);
    if(!reader||reader->sampleRate<=0||reader->lengthInSamples<2)throw std::runtime_error("Cannot decode retained source audio");return reader;
}
std::pair<juce::int64,juce::int64> samplerRange(const juce::AudioFormatReader& reader,const juce::var& request){
    const double from=(double)request["from"],to=(double)request["to"],duration=reader.lengthInSamples/reader.sampleRate;
    if(!std::isfinite(from)||!std::isfinite(to)||from<0||to<=from||to>duration+1.0/reader.sampleRate)throw std::runtime_error("Invalid chop selection");
    const auto first=(juce::int64)std::floor(from*reader.sampleRate),last=juce::jmin(reader.lengthInSamples,(juce::int64)std::ceil(to*reader.sampleRate));
    if(last-first<2)throw std::runtime_error("Select at least two audio frames");return {first,last};
}
}
juce::var CueProcessor::samplerSource(const juce::var& track,const std::function<bool()>& cancelled){
    const auto originalId=track["id"].toString();if(originalId.length()!=11||!originalId.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"))throw std::runtime_error("Invalid source track");
    auto source=libraryStore.media(originalId);
    if(!source.isObject()){
        const auto all=libraryStore.allMedia();for(const auto& entry:*all.getArray())if(entry["sourceTrackId"].toString()==originalId&&juce::File(entry["path"].toString()).existsAsFile()){source=entry.clone();break;}
        if(!source.isObject()){
            juce::String path;{std::lock_guard<std::mutex> lock(metadataMutex);if(ready.load()&&nativeQueue["tracks"][nativeIndex.load()]["id"].toString()==originalId)path=samplePath;}
            const auto file=path.isNotEmpty()?juce::File(path):audioCacheFolder().getChildFile("song-"+originalId+".m4a");
            if(!file.existsAsFile())throw std::runtime_error("Load this song in Cues before chopping it");
            source=importLocalFile(file);auto* fields=source.getDynamicObject();fields->setProperty("sourceTrackId",originalId);
            if(track["title"].toString().isNotEmpty())fields->setProperty("title",track["title"]);if(track["artist"].toString().isNotEmpty())fields->setProperty("artist",track["artist"]);
            libraryStore.registerMedia(source["id"].toString(),source);
        }
    }
    auto reader=samplerReader(libraryStore,source["id"].toString());const juce::File file(source["path"].toString());
    const auto cache=libraryStore.mediaDirectory().getChildFile("Waveforms").getChildFile("sampler-"+source["id"].toString()+".json");
    const auto saved=juce::JSON::parse(cache.loadFileAsString());juce::Array<juce::var> peaks;
    if(saved["peaks"].isArray()&&saved["peaks"].size()==2048&&(juce::int64)saved["size"]==file.getSize()&&(juce::int64)saved["modified"]==file.getLastModificationTime().toMilliseconds())peaks=*saved["peaks"].getArray();
    else{
        std::array<float,2048> values{};juce::AudioBuffer<float> chunk(juce::jlimit(1,2,(int)reader->numChannels),65536);
        for(juce::int64 offset=0;offset<reader->lengthInSamples;){if(stopQueue.load()||(cancelled&&cancelled()))throw std::runtime_error("Source preparation cancelled");const int count=(int)juce::jmin((juce::int64)65536,reader->lengthInSamples-offset);
            if(!reader->read(&chunk,0,count,offset,true,chunk.getNumChannels()>1))throw std::runtime_error("Cannot read the complete source waveform");
            for(int i=0;i<count;++i){auto& value=values[(size_t)((offset+i)*2048/reader->lengthInSamples)];for(int c=0;c<chunk.getNumChannels();++c){const float sample=chunk.getSample(c,i);if(std::isfinite(sample))value=juce::jmax(value,std::abs(sample));}}offset+=count;}
        for(const auto peak:values)peaks.add(peak);cache.getParentDirectory().createDirectory();juce::TemporaryFile temporary(cache);
        if(temporary.getFile().replaceWithText(juce::JSON::toString(waveformObject({{"size",file.getSize()},{"modified",file.getLastModificationTime().toMilliseconds()},{"peaks",peaks}}))))temporary.overwriteTargetFileWithTemporary();
    }
    auto result=source.clone();result.getDynamicObject()->setProperty("duration",reader->lengthInSamples/reader->sampleRate);result.getDynamicObject()->setProperty("peaks",peaks);return result;
}
juce::var CueProcessor::previewSamplerSource(const juce::var& request){
    auto reader=samplerReader(libraryStore,request["sourceId"].toString());const auto [first,last]=samplerRange(*reader,request);
    if((last-first)/reader->sampleRate>30.001)throw std::runtime_error("Preview up to 30 seconds at a time");
    const int ticket=request.hasProperty("ticket")?(int)request["ticket"]:reserveSamplerPreview();
    auto part=std::make_unique<juce::AudioSubsectionReader>(reader.release(),first,last-first,true);
    if(padSampler.load(PadSampler::previewSlot,std::move(part),{},"Chop preview",ticket))submit({Action::auditionSource});return true;
}
juce::var CueProcessor::assignPadSamples(const juce::var& assignments){
    if(!assignments.isArray()||assignments.size()<1||assignments.size()>16)throw std::runtime_error("Invalid sample assignments");
    std::vector<PadSampler::Assignment> batch;size_t bytes=0;
    for(const auto& item:*assignments.getArray()){
        const auto bank=item["bank"].toString();const int pad=(int)item["pad"]-1;if(bank.length()!=1||bank[0]<'A'||bank[0]>'J'||pad<0||pad>=16)throw std::runtime_error("Invalid sample pad");
        const int slot=((int)bank[0]-'A')*16+pad;const auto descriptor=item["descriptor"];
        if(!descriptor.isObject()){batch.push_back({slot,nullptr});continue;}
        const juce::File file(descriptor["path"].toString());if(!file.isAChildOf(libraryStore.mediaDirectory().getChildFile("PadSamples"))||!file.existsAsFile())throw std::runtime_error("The retained sample is unavailable");
        juce::AudioFormatManager formats;formats.registerBasicFormats();juce::String error;auto reader=mediaReader(formats,file,error);
        auto clip=PadSampler::prepare(std::move(reader),file.getFullPathName(),descriptor["name"].toString());bytes+=clip->bytes();if(bytes>PadSampler::memoryLimit)throw std::runtime_error("Chops exceed the pad-memory budget; select a shorter range");
        batch.push_back({slot,std::move(clip),(double)descriptor["start"]});
    }
    padSampler.assign(std::move(batch),[this](const juce::var& desired){persistPadSamples(desired);});return padSamples();
}
juce::var CueProcessor::chopSamplerSource(const juce::var& request,const std::function<bool()>& cancelled){
    const auto id=request["sourceId"].toString(),bank=request["bank"].toString();const int pad=(int)request["pad"]-1,slices=(int)request["slices"];
    if(bank.length()!=1||bank[0]<'A'||bank[0]>'J'||pad<0||slices<1||slices>16||pad+slices>padCount())throw std::runtime_error("Chops must fit within the selected pad bank");
    auto reader=samplerReader(libraryStore,id);const auto [first,last]=samplerRange(*reader,request);const int channels=juce::jlimit(1,2,(int)reader->numChannels);
    if(last-first<slices*2||(juce::uint64)(last-first)*channels*sizeof(float)>PadSampler::memoryLimit)throw std::runtime_error("Select a shorter range with at least two frames per chop");
    const auto directory=libraryStore.mediaDirectory().getChildFile("PadSamples");if(!directory.createDirectory())throw std::runtime_error("Cannot create sample storage");
    juce::Array<juce::var> assignments;std::vector<juce::File> created;
    try{for(int slice=0;slice<slices;++slice){
        const auto begin=first+(last-first)*slice/slices,end=first+(last-first)*(slice+1)/slices;const auto file=directory.getChildFile(juce::Uuid().toString()+".wav");created.push_back(file);
        {juce::WavAudioFormat format;std::unique_ptr<juce::AudioFormatWriter> writer(format.createWriterFor(file.createOutputStream().release(),reader->sampleRate,(unsigned int)channels,24,{},0));if(!writer)throw std::runtime_error("Cannot create a chop file");
            juce::AudioBuffer<float> chunk(channels,65536);for(auto offset=begin;offset<end;){const int count=(int)juce::jmin((juce::int64)65536,end-offset);
                if(stopQueue.load()||(cancelled&&cancelled()))throw std::runtime_error("Chopping cancelled");if(!reader->read(&chunk,0,count,offset,true,channels>1)||!writer->writeFromAudioSampleBuffer(chunk,0,count))throw std::runtime_error("Cannot write a complete chop");offset+=count;}}
       #if JUCE_IOS
        appleAllowBackgroundFileAccess(file);
       #endif
        assignments.add(waveformObject({{"bank",bank},{"pad",pad+slice+1},{"descriptor",waveformObject({{"path",file.getFullPathName()},{"name",libraryStore.media(id)["title"].toString()+" · "+juce::String(slice+1)},{"start",0.0}})}}));
    }
    if(cancelled&&cancelled())throw std::runtime_error("Chopping cancelled");return assignPadSamples(juce::var(assignments));
    }catch(...){const auto pads=padSamples();for(const auto& file:created){bool used=false;for(const auto& pad:*pads.getArray())if(pad["path"].toString()==file.getFullPathName())used=true;if(!used)file.deleteFile();}throw;}
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

juce::var CueProcessor::transitions() const{return waveformObject({{"enabled",transitionsEnabled.load()},{"seconds",transitionSeconds.load()}});}
void CueProcessor::setTransitions(const juce::var& value){
    const double seconds=value["seconds"].isVoid()?.35:(double)value["seconds"];if(!value.isObject()||!std::isfinite(seconds)||seconds<.05||seconds>2)throw std::runtime_error("Song fade duration must be 0.05 to 2 seconds");
    transitionSeconds.store(seconds);transitionsEnabled.store(value["enabled"].isVoid()||bool(value["enabled"]));if(!transitionsEnabled.load()){fadeRequested.store(0);fadeInNext.store(false);}
}
void CueProcessor::cancelSongChange(){
    fadeRequested.store(0);fadeInNext.store(false);songFade.setCurrentAndTargetValue(1);
    if(manualQueueIntent.exchange(-1)>=0){++queueGeneration;manualQueueRequest.store(0);}
}
bool CueProcessor::navigateTo(int target,bool autoplay){
    std::lock_guard<std::mutex> lock(metadataMutex);const auto tracks=nativeQueue["tracks"];if(!tracks.isArray()||target<0||target>=tracks.size())return false;
    if(target==nativeIndex.load()&&ready.load()){if(autoplay)requestedPlay.store(true);return submitRemoteCommand({autoplay?Action::cue:Action::seek,0,-1,0});}
    const auto generation=(juce::uint32)++queueGeneration;++loadGeneration;manualQueueIntent.store(target);manualQueueRequest.store(((juce::uint64)generation<<32)|(juce::uint32)(target+1));needAdvance.store(false);nativeEnded.store(false);requestedPlay.store(autoplay);remoteTransportRevision.fetch_add(1);return true;
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
    if(songPlaybackEnabled.load()){
        if(nativeAdvancing.load()&&tracks.isArray()&&index>=0&&index<tracks.size())result->setProperty("playback",cleanTrackPlayback(trackPlaybackSettings[juce::Identifier(tracks[index]["id"].toString())]));
        else {auto* playback=new juce::DynamicObject;playback->setProperty("speed",std::round((speedValue->load()-1.0f)*100.0f));
            playback->setProperty("speedMode",preservePitch.load()?"speed":"pitch");playback->setProperty("tuning",semitones.load());result->setProperty("playback",juce::var(playback));}
    }
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
    juce::uint32 lastSaved=0,lastLoopSave=0;
    while(!stopQueue.load()){
        juce::Thread::sleep(20);
        if(juce::Time::getMillisecondCounter()-lastLoopSave>=500&&(looperDirty.load()||padLooper.revision()!=lastLooperSaved.load())){try{saveLoopers();}catch(const std::exception& error){juce::Logger::outputDebugString(juce::String("Looper save: ")+error.what());}lastLoopSave=juce::Time::getMillisecondCounter();}
        bool cacheFailed=false;int cacheGeneration=0;
        {std::lock_guard<std::mutex> lock(metadataMutex);
            const auto* latest=published.load();const auto* inUse=audioHazard.load();
            retained.erase(std::remove_if(retained.begin(),retained.end(),[latest,inUse](const auto& sample){return sample.get()!=latest&&sample.get()!=inUse;}),retained.end());
            if(auto* sample=published.load())if(sample->paged){
                cacheFailed=sample->paged->failed();cacheGeneration=loadGeneration.load();
                for(int b=0;b<10;++b)for(int p=0;p<16;++p)sample->paged->setCue(b*16+p,cues[(size_t)b][(size_t)p].load());
                sample->paged->setLoop(loopIn.load(),loopOut.load(),loopEnabled.load());
                sample->paged->setCueBank(selectedBank.load());
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
            if(manual>=0&&transitionsEnabled.load()&&playing.load()&&ready.load()){
                auto ticket=++fadeSerial;if(ticket==0)ticket=++fadeSerial;fadeRequested.store(ticket);
                const auto deadline=juce::Time::getMillisecondCounterHiRes()+transitionSeconds.load()*1000+750;
                while(!cancelled()&&transitionsEnabled.load()&&requestedPlay.load()&&fadeCompleted.load()!=ticket&&juce::Time::getMillisecondCounterHiRes()<deadline)juce::Thread::sleep(2);
                if(cancelled()){if(fadeRequested.load()==ticket)fadeRequested.store(0);continue;}
            }
            fadeInNext.store(transitionsEnabled.load()&&requestedPlay.load());
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
