#include "Processor.h"
#include "StandaloneNowPlaying.h"
#import <AVFoundation/AVFoundation.h>
#import <MediaPlayer/MediaPlayer.h>
#import <ImageIO/ImageIO.h>
#import <UIKit/UIKit.h>
#if BEATMAKER_IOS_PREVIEW || BEATMAKER_PERFORMANCE_FEATURES
#include "MonitorRouteGuard.h"
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_audio_plugin_client/Standalone/juce_StandaloneFilterWindow.h>
#endif

namespace {
class IOSNowPlaying;
struct Callbacks {std::atomic<IOSNowPlaying*> owner{nullptr};std::atomic<bool> available{false};std::atomic<juce::uint32> routeRevision{0};};
class IOSNowPlaying final:public StandaloneNowPlaying,private juce::Timer
   #if BEATMAKER_IOS_PREVIEW || BEATMAKER_PERFORMANCE_FEATURES
    ,private juce::AudioIODeviceCallback
   #endif
{
public:
    explicit IOSNowPlaying(CueProcessor& processor):engine(processor){
        callbacks->owner.store(this);commands=[[NSMutableArray alloc] init];observers=[[NSMutableArray alloc] init];
       #if BEATMAKER_IOS_PREVIEW || BEATMAKER_PERFORMANCE_FEATURES
        const auto saved=juce::JSON::parse(engine.libraryStore.readPreferences(engine.getSessionId()));audioPreferences=juce::JSON::parse(saved["musike:audio:routes"].toString());
        if(!audioPreferences.isObject())audioPreferences=juce::JSON::parse(R"({"inputEnabled":false,"input":"automatic","output":"automatic","monitor":false,"monitorLevel":0.5})");
        monitorRoute.restore((bool)audioPreferences["monitor"],audioPreferences["monitorRoute"]);
       #endif
        auto* center=[MPRemoteCommandCenter sharedCommandCenter];
        add(center.playCommand,CueProcessor::RemoteAction::play);add(center.pauseCommand,CueProcessor::RemoteAction::pause);
        add(center.togglePlayPauseCommand,CueProcessor::RemoteAction::toggle);add(center.nextTrackCommand,CueProcessor::RemoteAction::next);
        add(center.previousTrackCommand,CueProcessor::RemoteAction::previous);add(center.changePlaybackPositionCommand,CueProcessor::RemoteAction::seek);
        const auto state=callbacks;
       #if BEATMAKER_IOS_PREVIEW || BEATMAKER_PERFORMANCE_FEATURES
        // Gate the next input buffer on the notification's posting thread. The
        // main queue may be busy in a WebView; fallback audio cannot wait for it.
        id routeGate=[[NSNotificationCenter defaultCenter] addObserverForName:AVAudioSessionRouteChangeNotification object:nil queue:nil usingBlock:^(NSNotification* notification){
            const auto revision=state->routeRevision.fetch_add(1)+1;auto* retained=[notification retain];
            const bool queued=juce::MessageManager::callAsync([state,retained,revision]{
                if(auto* owner=state->owner.load()){owner->monitorRouteChanged(retained,revision);if([retained.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue]==AVAudioSessionRouteChangeReasonOldDeviceUnavailable)owner->remote(CueProcessor::RemoteAction::pause,0);}
                [retained release];
            });if(!queued)[retained release];
        }];
        [observers addObject:routeGate];
       #endif
        observe(AVAudioSessionInterruptionNotification,^(NSNotification* notification){
            const auto type=[notification.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
            const auto options=[notification.userInfo[AVAudioSessionInterruptionOptionKey] unsignedIntegerValue];
            if(auto* owner=state->owner.load())owner->interruption(type,options);
        });
       #if !BEATMAKER_IOS_PREVIEW && !BEATMAKER_PERFORMANCE_FEATURES
        observe(AVAudioSessionRouteChangeNotification,^(NSNotification* notification){
            if([notification.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue]==AVAudioSessionRouteChangeReasonOldDeviceUnavailable)
                if(auto* owner=state->owner.load())owner->remote(CueProcessor::RemoteAction::pause,0);
        });
       #endif
        observe(UIApplicationDidEnterBackgroundNotification,^(NSNotification*){if(auto* owner=state->owner.load()){owner->engine.backgroundPlayback.store(true);owner->tick();}});
        observe(UIApplicationWillEnterForegroundNotification,^(NSNotification*){if(auto* owner=state->owner.load()){owner->engine.backgroundPlayback.store(false);owner->tick();}});
        [[UIApplication sharedApplication] beginReceivingRemoteControlEvents];
        startTimerHz(5);
        juce::Logger::outputDebugString("Beatmaker plug-in standalone: native Now Playing controls enabled");
    }
    ~IOSNowPlaying() override {
        stopTimer();callbacks->available.store(false);callbacks->owner.store(nullptr);engine.backgroundPlayback.store(false);
       #if BEATMAKER_IOS_PREVIEW || BEATMAKER_PERFORMANCE_FEATURES
        if(deviceManager)deviceManager->removeAudioCallback(this);engine.monitorInput.store(false);engine.recorder.interrupt();
       #endif
        for(NSArray* pair in commands){[(MPRemoteCommand*)pair[0] removeTarget:pair[1]];[(MPRemoteCommand*)pair[0] setEnabled:[pair[2] boolValue]];}
        for(id token in observers)[[NSNotificationCenter defaultCenter] removeObserver:token];
        [commands release];[observers release];[artworkTask cancel];[artworkTask release];[artwork release];
        if(published){[MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo=nil;[MPNowPlayingInfoCenter defaultCenter].playbackState=MPNowPlayingPlaybackStateStopped;}
        [[UIApplication sharedApplication] endReceivingRemoteControlEvents];
    }
   #if BEATMAKER_IOS_PREVIEW || BEATMAKER_PERFORMANCE_FEATURES
    juce::var audioRoutes() override {
        updateMonitoring();
        auto result=audioPreferences.clone();auto* fields=result.getDynamicObject();auto* session=[AVAudioSession sharedInstance];
        fields->setProperty("monitorRequested",monitorRoute.requested());fields->setProperty("monitor",engine.monitorInput.load());fields->setProperty("monitorSuspended",monitorRoute.requested()&&!engine.monitorInput.load());
        fields->setProperty("supported",true);fields->setProperty("inputActive",engine.inputChannels.load()>0);fields->setProperty("sampleRate",session.sampleRate);
        fields->setProperty("platform","ios");
        fields->setProperty("permission",session.recordPermission==AVAudioSessionRecordPermissionGranted?"granted":session.recordPermission==AVAudioSessionRecordPermissionDenied?"denied":"undetermined");
        juce::Array<juce::var> inputs;
        for(AVAudioSessionPortDescription* port in session.availableInputs){auto* item=new juce::DynamicObject;item->setProperty("id",juce::String(port.UID.UTF8String));item->setProperty("name",juce::String(port.portName.UTF8String));item->setProperty("type",juce::String(port.portType.UTF8String));item->setProperty("kind",portKind(port));inputs.add(juce::var(item));}
        fields->setProperty("inputs",inputs);
        juce::Array<juce::var> outputs;for(AVAudioSessionPortDescription* port in session.currentRoute.outputs){auto* item=new juce::DynamicObject;item->setProperty("id",juce::String(port.UID.UTF8String));item->setProperty("name",juce::String(port.portName.UTF8String));item->setProperty("type",juce::String(port.portType.UTF8String));item->setProperty("kind",portKind(port));outputs.add(juce::var(item));}fields->setProperty("outputs",outputs);
        const auto names=[](NSArray<AVAudioSessionPortDescription*>* ports){juce::StringArray result;for(AVAudioSessionPortDescription* port in ports)result.addIfNotAlreadyThere(portName(port));return result.joinIntoString(" + ");};
        const auto active=hasPort(session,AVAudioSessionPortUSBAudio)?"usb":hasSpeaker(session)?"speaker":"other";
        fields->setProperty("activeOutput",active);fields->setProperty("outputAccepted",outputAccepted(session,audioPreferences["output"].toString()));fields->setProperty("inputAccepted",inputAccepted(session,audioPreferences));
        juce::String message=routeMessage;
        if(audioPreferences["output"].toString()=="speaker"&&!hasSpeaker(session))message="iOS has not accepted iPhone speaker output; showing the current route";
        for(AVAudioSessionPortDescription* port in session.currentRoute.inputs)if([port.portType isEqualToString:AVAudioSessionPortBuiltInMic]&&engine.inputChannels.load()>0){
            auto* source=port.selectedDataSource;if(source){fields->setProperty("microphoneDataSource",juce::String(source.dataSourceName.UTF8String));fields->setProperty("microphonePosition",juce::String(source.orientation.UTF8String));}
            if(audioPreferences["input"].toString()=="usb"&&audioPreferences["output"].toString()=="speaker")message="iOS selected the iPhone microphone with speaker output";
        }
        if(audioPreferences["output"].toString()=="usb"&&audioPreferences["input"].toString()=="microphone"&&engine.inputChannels.load()>0)for(AVAudioSessionPortDescription* port in session.currentRoute.inputs)if([port.portType isEqualToString:AVAudioSessionPortUSBAudio])message="iOS selected the interface input with USB output";
        if(monitorRoute.requested()&&!engine.monitorInput.load())message="Monitoring muted · reconnect the audio device to resume, or turn monitoring off";
        fields->setProperty("actualInput",engine.inputChannels.load()>0?names(session.currentRoute.inputs):"Off");fields->setProperty("actualOutput",names(session.currentRoute.outputs));fields->setProperty("message",message);return result;
    }
    void configureAudio(const juce::var& request,std::function<void(juce::var)> complete) override {
        if(confirmingOutput){complete(audioFailure("Audio output is changing; try again"));return;}
        auto next=audioPreferences.clone();auto* fields=next.getDynamicObject();
        for(const auto* key:{"inputEnabled","input","output","monitor","monitorLevel"})if(request.hasProperty(key))fields->setProperty(key,request[key]);
        const auto input=next["input"].toString(),output=next["output"].toString();const double level=(double)next["monitorLevel"];
        if((output!="automatic"&&output!="usb"&&output!="speaker")||!std::isfinite(level)||level<0||level>1){complete(audioFailure("Invalid audio routing preference"));return;}
        if((bool)next["monitor"])fields->setProperty("inputEnabled",true);
        auto* session=[AVAudioSession sharedInstance];
        const bool retryOutput=output!="automatic"&&(!outputAccepted(session,output)||![session.category isEqualToString:AVAudioSessionCategoryPlayAndRecord]);
        const bool routeRequest=request.hasProperty("inputEnabled")||request.hasProperty("input")||request.hasProperty("output");
        const bool changesDevice=(routeRequest&&(retryOutput||!inputAccepted(session,next)))||(bool)next["inputEnabled"]!=(bool)audioPreferences["inputEnabled"]||input!=audioPreferences["input"].toString()||output!=audioPreferences["output"].toString();
        if(changesDevice&&engine.recorder.hasTake()){complete(audioFailure("Finish the recording before changing audio routes"));return;}
        if(!changesDevice){audioPreferences=next.clone();monitorRoute.configure((bool)next["monitor"],externalPorts(session.currentRoute.inputs),externalPorts(session.currentRoute.outputs));engine.monitorLevel.store((float)level);complete(audioRoutes());return;}
        if((bool)next["inputEnabled"]&&session.recordPermission!=AVAudioSessionRecordPermissionGranted){
            if(session.recordPermission==AVAudioSessionRecordPermissionDenied){complete(audioFailure("Microphone access is disabled in iPhone Settings"));return;}
            const auto state=callbacks;
            [session requestRecordPermission:^(BOOL granted){juce::MessageManager::callAsync([state,next,granted,complete]{if(auto* owner=state->owner.load()){if(granted)owner->configureAudio(next,complete);else complete(audioFailure("Microphone access was not granted"));}});}];return;
        }
        const auto previous=audioPreferences.clone();confirmingOutput=true;
        try{applyAudio(next,true);confirmRoutes(next,previous,std::move(complete),20);}catch(const std::exception& error){restoreAudio(previous);confirmingOutput=false;complete(audioFailure(error.what()));}
    }
   #endif
private:
   #if BEATMAKER_IOS_PREVIEW || BEATMAKER_PERFORMANCE_FEATURES
    static juce::var audioFailure(const juce::String& message){auto* fields=new juce::DynamicObject;fields->setProperty("__error",message);return juce::var(fields);}
    static const char* portKind(AVAudioSessionPortDescription* port){return [port.portType isEqualToString:AVAudioSessionPortBuiltInMic]?"microphone":[port.portType isEqualToString:AVAudioSessionPortBuiltInSpeaker]?"speaker":[port.portType isEqualToString:AVAudioSessionPortUSBAudio]?"usb":"other";}
    static juce::String portName(AVAudioSessionPortDescription* port){
        const auto kind=juce::String(portKind(port));if(kind=="microphone")return "iPhone microphone";if(kind=="speaker")return "iPhone speaker";
        const juce::String name(port.portName.UTF8String);if(kind=="usb"&&name.toLowerCase().removeCharacters(" -_").contains("sp404"))return "SP-404";return name;
    }
    static bool hasSpeaker(AVAudioSession* session){for(AVAudioSessionPortDescription* port in session.currentRoute.outputs)if([port.portType isEqualToString:AVAudioSessionPortBuiltInSpeaker])return true;return false;}
    static bool hasPort(AVAudioSession* session,NSString* type){for(AVAudioSessionPortDescription* port in session.currentRoute.outputs)if([port.portType isEqualToString:type])return true;return false;}
    static bool outputAccepted(AVAudioSession* session,const juce::String& output){return output=="automatic"||(output=="speaker"?hasSpeaker(session):hasPort(session,AVAudioSessionPortUSBAudio));}
    static bool inputAccepted(AVAudioSession* session,const juce::var& preferences){
        if(!(bool)preferences["inputEnabled"])return true;const auto input=preferences["input"].toString();
        for(AVAudioSessionPortDescription* port in session.currentRoute.inputs)if(input=="automatic"||(input=="usb"&&[port.portType isEqualToString:AVAudioSessionPortUSBAudio])||(input=="microphone"&&[port.portType isEqualToString:AVAudioSessionPortBuiltInMic])||input==juce::String(port.UID.UTF8String))return true;
        return false;
    }
    static juce::StringArray externalPorts(NSArray<AVAudioSessionPortDescription*>* ports){
        juce::StringArray result;for(AVAudioSessionPortDescription* port in ports)if(![port.portType isEqualToString:AVAudioSessionPortBuiltInMic]&&![port.portType isEqualToString:AVAudioSessionPortBuiltInSpeaker]&&![port.portType isEqualToString:AVAudioSessionPortBuiltInReceiver])result.addIfNotAlreadyThere(juce::String(port.UID.UTF8String));return result;
    }
    void updateMonitoring(){
        auto* session=[AVAudioSession sharedInstance];
        const auto revision=callbacks->routeRevision.load();
        const bool active=monitorRoute.update(externalPorts(session.currentRoute.inputs),externalPorts(session.currentRoute.outputs),revision==monitorObservedRevision&&(bool)audioPreferences["inputEnabled"]&&engine.inputChannels.load()>0&&!interrupted&&juce::Time::getMillisecondCounterHiRes()>=monitorSettleUntil&&inputAccepted(session,audioPreferences)&&outputAccepted(session,audioPreferences["output"].toString()));
        audioPreferences.getDynamicObject()->setProperty("monitorRoute",monitorRoute.route());if(active)monitorAcceptedRevision.store(revision);engine.monitorInput.store(active);
    }
    void monitorRouteChanged(NSNotification* notification,juce::uint32 revision){
        monitorObservedRevision=juce::jmax(monitorObservedRevision,revision);
        engine.monitorInput.store(false);monitorSettleUntil=juce::Time::getMillisecondCounterHiRes()+250;
        if([notification.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue]==AVAudioSessionRouteChangeReasonOldDeviceUnavailable){
            engine.recorder.interrupt();
            // Capture a departing automatic interface even if it changed between polls.
            auto* previous=(AVAudioSessionRouteDescription*)notification.userInfo[AVAudioSessionRouteChangePreviousRouteKey];
            if(previous&&monitorRoute.requested())monitorRoute.update(externalPorts(previous.inputs),externalPorts(previous.outputs),true);
        }
    }
    void restoreAudio(const juce::var& previous){monitorRoute.restore((bool)previous["monitor"],previous["monitorRoute"]);try{applyAudio(previous);}catch(...){audioPreferences=previous.clone();engine.monitorInput.store(false);}}
    void confirmRoutes(const juce::var& next,const juce::var& previous,std::function<void(juce::var)> complete,int retries){
        auto* session=[AVAudioSession sharedInstance];const auto output=next["output"].toString();
        if(outputAccepted(session,output)&&inputAccepted(session,next)){confirmingOutput=false;complete(audioRoutes());return;}
        if(retries==0){const bool combination=(bool)next["inputEnabled"]&&next["input"].toString()=="usb"&&output=="speaker";const auto message=combination?juce::String("iOS did not accept SP-404 USB input with iPhone speaker output on this route"):!inputAccepted(session,next)?juce::String("iOS did not accept the selected audio input"):output=="usb"?juce::String("iOS could not switch output to the SP-404 / USB card"):juce::String("iOS could not switch output to the iPhone speaker");restoreAudio(previous);confirmingOutput=false;complete(audioFailure(message));return;}
        const auto state=callbacks;juce::Timer::callAfterDelay(50,[state,next,previous,complete,retries]{if(auto* owner=state->owner.load())owner->confirmRoutes(next,previous,complete,retries-1);});
    }
    void preferBuiltInMicrophone(AVAudioSessionPortDescription* port){
        if(![port.portType isEqualToString:AVAudioSessionPortBuiltInMic])return;
        AVAudioSessionDataSourceDescription* preferred=nil;int score=0;
        for(AVAudioSessionDataSourceDescription* source in port.dataSources){const int value=([source.orientation isEqualToString:AVAudioSessionOrientationBottom]?2:0)+([source.location isEqualToString:AVAudioSessionLocationLower]?1:0);if(value>score){preferred=source;score=value;}}
        if(preferred&&![port.preferredDataSource.dataSourceID isEqualToNumber:preferred.dataSourceID]){NSError* error=nil;if(![port setPreferredDataSource:preferred error:&error])routeMessage="The preferred bottom microphone is unavailable; using the system-selected microphone";}
    }
    void applyAudio(const juce::var& next,bool rebind=false){
        engine.monitorInput.store(false);
        auto* holder=juce::StandalonePluginHolder::getInstance();if(!holder||holder->processor.get()!=&engine)throw std::runtime_error("Standalone audio device is not ready");
        if(!deviceManager){deviceManager=&holder->deviceManager;deviceManager->addAudioCallback(this);}
        const bool enabled=(bool)next["inputEnabled"];auto setup=deviceManager->getAudioDeviceSetup();
        const bool wasEnabled=!setup.inputChannels.isZero();
        if(enabled!=wasEnabled){setup.useDefaultInputChannels=false;setup.inputChannels.clear();if(enabled){setup.inputChannels.setRange(0,2,true);if(setup.inputDeviceName.isEmpty())setup.inputDeviceName=setup.outputDeviceName;}
            const auto error=deviceManager->setAudioDeviceSetup(setup,false);if(error.isNotEmpty())throw std::runtime_error(error.toStdString());}
        auto* session=[AVAudioSession sharedInstance];NSError* error=nil;
        const auto output=next["output"].toString();const bool duplex=enabled||output!="automatic";
        const auto category=duplex?AVAudioSessionCategoryPlayAndRecord:AVAudioSessionCategoryPlayback;
        const AVAudioSessionCategoryOptions options=duplex?AVAudioSessionCategoryOptionDefaultToSpeaker|AVAudioSessionCategoryOptionAllowBluetoothA2DP:0;
        if(![session setCategory:category mode:AVAudioSessionModeDefault options:options error:&error]||![session setActive:YES error:&error])throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot activate audio");
        routeMessage={};AVAudioSessionPortDescription* preferred=nil;const auto input=next["input"].toString();auto applied=next.clone();
        if(enabled&&input!="automatic"){
            for(AVAudioSessionPortDescription* port in session.availableInputs)if((input=="microphone"&&[port.portType isEqualToString:AVAudioSessionPortBuiltInMic])||(input=="usb"&&[port.portType isEqualToString:AVAudioSessionPortUSBAudio])||input==juce::String(port.UID.UTF8String)){preferred=port;break;}
            if(!preferred)routeMessage="Preferred input is unavailable; using the accepted route";
        }
        if(enabled&&preferred){const auto kind=juce::String(portKind(preferred));if(kind=="microphone"||kind=="usb")applied.getDynamicObject()->setProperty("input",kind);preferBuiltInMicrophone(preferred);}
        if(enabled&&![session setPreferredInput:preferred error:&error])throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot select audio input");
        if(duplex){
            if(![session overrideOutputAudioPort:output=="speaker"?AVAudioSessionPortOverrideSpeaker:AVAudioSessionPortOverrideNone error:&error])throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot select audio output");
        }
        if(output=="usb"){
            // iOS has no arbitrary setPreferredOutput API. Releasing a speaker
            // override and selecting the USB port is how a duplex interface
            // becomes the output route. This does not enable input capture.
            AVAudioSessionPortDescription* usb=nil;for(AVAudioSessionPortDescription* port in session.availableInputs)if([port.portType isEqualToString:AVAudioSessionPortUSBAudio]){usb=port;break;}
            if(usb){if(![session setPreferredInput:usb error:&error])throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot select the USB audio card");}
            else if(!hasPort(session,AVAudioSessionPortUSBAudio))throw std::runtime_error("No SP-404 / USB audio card is available");
        }
        if(enabled&&output=="speaker"&&preferred&&[preferred.portType isEqualToString:AVAudioSessionPortUSBAudio]){
            // Retry USB input after the speaker override, which commonly resets
            // it to BuiltInMic. Confirmation checks BOTH ends; unsupported iOS
            // combinations must never silently record the phone microphone.
            if(![session setPreferredInput:preferred error:&error])throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot retain USB audio input");
        }
        if(enabled)for(AVAudioSessionPortDescription* port in session.currentRoute.inputs)preferBuiltInMicrophone(port);
        audioPreferences=applied;monitorRoute.configure((bool)next["monitor"],externalPorts(session.currentRoute.inputs),externalPorts(session.currentRoute.outputs),rebind);engine.monitorLevel.store((float)(double)next["monitorLevel"]);updateMonitoring();sessionClaimed=true;
    }
    void audioDeviceIOCallbackWithContext(const float* const* input,int inputs,float* const* output,int outputs,int frames,const juce::AudioIODeviceCallbackContext&) override {
        engine.recorder.capture(input,inputs,frames,engine.inputRate.load(),false);float peak=0;
        for(int c=0;c<inputs;++c)if(input[c])for(int i=0;i<frames;++i)if(std::isfinite(input[c][i]))peak=juce::jmax(peak,std::abs(input[c][i]));engine.inputPeak.store(juce::jmax(peak,engine.inputPeak.load()*(float)std::exp(-frames/(juce::jmax(8000.0,engine.inputRate.load())*.3))));
        const float level=engine.monitorInput.load()&&monitorAcceptedRevision.load()==callbacks->routeRevision.load()?engine.monitorLevel.load():0;
        for(int c=0;c<outputs;++c)if(output[c]){const auto* source=inputs>0?input[juce::jmin(c,inputs-1)]:nullptr;for(int i=0;i<frames;++i)output[c][i]=source&&std::isfinite(source[i])?source[i]*level:0;}
    }
    void audioDeviceAboutToStart(juce::AudioIODevice* device) override {engine.inputRate.store(device->getCurrentSampleRate());engine.inputChannels.store(device->getActiveInputChannels().countNumberOfSetBits());}
    void audioDeviceStopped() override {engine.monitorInput.store(false);engine.inputChannels.store(0);engine.inputPeak.store(0);engine.recorder.interrupt();}
    juce::AudioDeviceManager* deviceManager=nullptr;juce::var audioPreferences;MonitorRouteGuard monitorRoute;juce::uint32 monitorObservedRevision=0;std::atomic<juce::uint32> monitorAcceptedRevision{~0u};double monitorSettleUntil=0;juce::String routeMessage;bool audioRestored=false,confirmingOutput=false;
   #endif
    static void dispatch(std::shared_ptr<Callbacks> state,CueProcessor::RemoteAction action,double position){
        juce::MessageManager::callAsync([state,action,position]{if(auto* owner=state->owner.load())owner->remote(action,position);});
    }
    void add(MPRemoteCommand* command,CueProcessor::RemoteAction action){
        const auto state=callbacks;const BOOL wasEnabled=command.enabled;
        id token=[command addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent* event){
            if(!state->available.load())return MPRemoteCommandHandlerStatusCommandFailed;
            double position=0;
            if(action==CueProcessor::RemoteAction::seek){if(![event isKindOfClass:[MPChangePlaybackPositionCommandEvent class]])return MPRemoteCommandHandlerStatusCommandFailed;position=[(MPChangePlaybackPositionCommandEvent*)event positionTime];}
            dispatch(state,action,position);return MPRemoteCommandHandlerStatusSuccess;
        }];
        [commands addObject:@[command,token,@(wasEnabled)]];command.enabled=NO;
    }
    void observe(NSString* name,void(^callback)(NSNotification*)){id token=[[NSNotificationCenter defaultCenter] addObserverForName:name object:nil queue:[NSOperationQueue mainQueue] usingBlock:callback];[observers addObject:token];}
    bool activate(){
        if(interrupted)return false;
        auto* session=[AVAudioSession sharedInstance];NSError* error=nil;
       #if BEATMAKER_IOS_PREVIEW || BEATMAKER_PERFORMANCE_FEATURES
        if((bool)audioPreferences["inputEnabled"]||audioPreferences["output"].toString()!="automatic"){
            if(![session.category isEqualToString:AVAudioSessionCategoryPlayAndRecord])if(![session setCategory:AVAudioSessionCategoryPlayAndRecord mode:AVAudioSessionModeDefault options:AVAudioSessionCategoryOptionDefaultToSpeaker|AVAudioSessionCategoryOptionAllowBluetoothA2DP error:&error])return false;
            if(![session setActive:YES error:&error])return false;
            if(audioPreferences["output"].toString()=="speaker"&&!hasSpeaker(session))return [session overrideOutputAudioPort:AVAudioSessionPortOverrideSpeaker error:&error];
            return true;
        }
       #endif
        if(sessionClaimed&&[session.category isEqualToString:AVAudioSessionCategoryPlayback]&&!(session.categoryOptions&AVAudioSessionCategoryOptionMixWithOthers))return true;
        // JUCE initially permits mixing. Claim the nonmixing music session only
        // when this standalone actually plays; AUv3 never links this controller.
        if(![session.category isEqualToString:AVAudioSessionCategoryPlayback]||(session.categoryOptions&AVAudioSessionCategoryOptionMixWithOthers))
            if(![session setCategory:AVAudioSessionCategoryPlayback mode:AVAudioSessionModeDefault options:0 error:&error])return false;
        sessionClaimed=[session setActive:YES error:&error];return sessionClaimed;
    }
    void remote(CueProcessor::RemoteAction action,double position){
        const bool wantsPlay=action==CueProcessor::RemoteAction::play||(action==CueProcessor::RemoteAction::toggle&&(!engine.requestedPlay.load()||engine.nativeEnded.load()));
        if(action==CueProcessor::RemoteAction::pause)resumeAfterInterruption=false;
        if(wantsPlay&&!activate())return;
        if(engine.performRemoteAction(action,position)){
            if(action==CueProcessor::RemoteAction::seek){pendingSeek=std::clamp(position,0.0,engine.getDuration());seekDeadline=juce::Time::getMillisecondCounterHiRes()+1000;seekPending=true;}
            else if(action==CueProcessor::RemoteAction::next||action==CueProcessor::RemoteAction::previous)seekPending=false;
            lastPublish=0;tick();
        }
    }
    void interruption(NSUInteger type,NSUInteger options){
        if(type==AVAudioSessionInterruptionTypeBegan){
            engine.monitorInput.store(false);
            engine.recorder.interrupt();
            resumeAfterInterruption=engine.requestedPlay.load()&&!engine.nativeEnded.load();interrupted=true;sessionClaimed=false;
            engine.performRemoteAction(CueProcessor::RemoteAction::pause);engine.requestedPlay.store(false);engine.playing.store(false);resumeIntentRevision=engine.playIntentRevision.load();tick();
        }else{
            interrupted=false;const bool resume=resumeAfterInterruption&&engine.playIntentRevision.load()==resumeIntentRevision&&(options&AVAudioSessionInterruptionOptionShouldResume);resumeAfterInterruption=false;
            if(resume&&activate())engine.performRemoteAction(CueProcessor::RemoteAction::play);tick();
        }
    }
    void timerCallback() override {tick();}
    void tick(){
        @autoreleasepool {
           #if BEATMAKER_IOS_PREVIEW || BEATMAKER_PERFORMANCE_FEATURES
            if(!audioRestored){auto* holder=juce::StandalonePluginHolder::getInstance();if(holder&&holder->processor.get()==&engine){audioRestored=true;auto initial=audioPreferences.clone();if([AVAudioSession sharedInstance].recordPermission!=AVAudioSessionRecordPermissionGranted){initial.getDynamicObject()->setProperty("inputEnabled",false);initial.getDynamicObject()->setProperty("monitor",false);}try{applyAudio(initial);}catch(const std::exception& error){routeMessage=error.what();}}}
            if(audioRestored)updateMonitoring();
           #endif
            const auto snapshot=engine.nativeSnapshot();const auto title=snapshot["title"].toString();
            const auto id=snapshot["trackId"].toString();const bool ready=(bool)snapshot["ready"];
            const bool playing=engine.requestedPlay.load()&&!engine.nativeEnded.load()&&!interrupted;
            if(title.isEmpty()||id.isEmpty()){
                if(published){[MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo=nil;[MPNowPlayingInfoCenter defaultCenter].playbackState=MPNowPlayingPlaybackStateStopped;published=false;callbacks->available.store(false);}return;
            }
            if(playing&&!activate())return;
            if(!published&&!playing)return;
            const auto now=juce::Time::getMillisecondCounter();
            double position=snapshot["position"];const double duration=snapshot["duration"],rate=playing&&ready&&engine.playing.load()?(double)snapshot["rate"]:0;
            if(id!=lastTrack)seekPending=false;
            if(seekPending){if(std::abs(position-pendingSeek)<0.25||juce::Time::getMillisecondCounterHiRes()>seekDeadline)seekPending=false;else position=pendingSeek;}
            const double expectedPosition=lastPosition+(lastPlaying?(now-lastPublish)*0.001*lastRate:0);
            const bool changed=id!=lastTrack||playing!=lastPlaying||ready!=lastReady||duration!=lastDuration||std::abs(position-expectedPosition)>0.25||rate!=lastRate;
            if(!changed&&now-lastPublish<1000)return;
            lastTrack=id;lastPlaying=playing;lastReady=ready;lastDuration=duration;lastPosition=position;lastRate=rate;lastPublish=now;published=true;callbacks->available.store(true);
            artworkFor(snapshot["artwork"].toString());
            NSMutableDictionary* info=[NSMutableDictionary dictionary];
            info[MPMediaItemPropertyTitle]=[NSString stringWithUTF8String:title.toRawUTF8()];
            info[MPMediaItemPropertyArtist]=[NSString stringWithUTF8String:snapshot["artist"].toString().toRawUTF8()];
            info[MPMediaItemPropertyAlbumTitle]=[NSString stringWithUTF8String:snapshot["album"].toString().toRawUTF8()];
            info[MPMediaItemPropertyPlaybackDuration]=@(std::max(0.0,duration));
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime]=@(std::max(0.0,position));
            info[MPNowPlayingInfoPropertyPlaybackRate]=@(rate);
            info[MPNowPlayingInfoPropertyDefaultPlaybackRate]=@1;
            info[MPNowPlayingInfoPropertyMediaType]=@(MPNowPlayingInfoMediaTypeAudio);
            info[MPNowPlayingInfoPropertyIsLiveStream]=@NO;
            info[MPNowPlayingInfoPropertyExternalContentIdentifier]=[NSString stringWithUTF8String:("beatmaker-plugin:"+id).toRawUTF8()];
            if(artwork)info[MPMediaItemPropertyArtwork]=artwork;
            [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo=info;
            [MPNowPlayingInfoCenter defaultCenter].playbackState=playing?MPNowPlayingPlaybackStatePlaying:MPNowPlayingPlaybackStatePaused;
            auto* center=[MPRemoteCommandCenter sharedCommandCenter];center.playCommand.enabled=YES;center.pauseCommand.enabled=YES;center.togglePlayPauseCommand.enabled=YES;
            center.nextTrackCommand.enabled=(bool)snapshot["canNext"];center.previousTrackCommand.enabled=(bool)snapshot["canPrevious"];
            center.changePlaybackPositionCommand.enabled=(bool)snapshot["ready"]&&duration>0;
        }
    }
    void artworkFor(const juce::String& link){
        if(link==artworkURL)return;artworkURL=link;++artworkGeneration;
        [artworkTask cancel];[artworkTask release];artworkTask=nil;[artwork release];artwork=nil;
        NSURL* url=[NSURL URLWithString:[NSString stringWithUTF8String:link.toRawUTF8()]];
        if(![url.scheme isEqualToString:@"https"])return;
        const auto state=callbacks;const int generation=artworkGeneration;
        NSMutableURLRequest* request=[NSMutableURLRequest requestWithURL:url];request.timeoutInterval=10;
        artworkTask=[[[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData* data,NSURLResponse*,NSError*){
            UIImage* image=nil;
            if(data.length>0&&data.length<=4*1024*1024){
                if(CGImageSourceRef source=CGImageSourceCreateWithData((CFDataRef)data,nullptr)){
                    NSDictionary* options=@{(NSString*)kCGImageSourceCreateThumbnailFromImageAlways:@YES,(NSString*)kCGImageSourceThumbnailMaxPixelSize:@512,(NSString*)kCGImageSourceCreateThumbnailWithTransform:@YES};
                    if(CGImageRef thumb=CGImageSourceCreateThumbnailAtIndex(source,0,(CFDictionaryRef)options)){image=[[UIImage alloc] initWithCGImage:thumb];CGImageRelease(thumb);}CFRelease(source);
                }
            }
            const bool queued=juce::MessageManager::callAsync([state,image,generation]{
                if(auto* owner=state->owner.load())if(owner->artworkGeneration==generation){
                    [owner->artworkTask release];owner->artworkTask=nil;
                    if(image){UIImage* thumbnail=image;owner->artwork=[[MPMediaItemArtwork alloc] initWithBoundsSize:thumbnail.size requestHandler:^UIImage*(CGSize){return thumbnail;}];owner->lastPublish=0;owner->tick();}
                }
                [image release];
            });
            if(!queued)[image release];
        }] retain];
        [artworkTask resume];
    }
    CueProcessor& engine;std::shared_ptr<Callbacks> callbacks=std::make_shared<Callbacks>();
    NSMutableArray* commands=nil;NSMutableArray* observers=nil;NSURLSessionDataTask* artworkTask=nil;MPMediaItemArtwork* artwork=nil;
    juce::String artworkURL,lastTrack;int artworkGeneration=0;juce::uint32 lastPublish=0;double lastPosition=0,lastRate=1,lastDuration=0,pendingSeek=0,seekDeadline=0;
    bool published=false,lastPlaying=false,lastReady=false,interrupted=false,resumeAfterInterruption=false,sessionClaimed=false,seekPending=false;
    int resumeIntentRevision=0;
};
std::unique_ptr<StandaloneNowPlaying> makeNowPlaying(CueProcessor& engine){
    if(engine.wrapperType!=juce::AudioProcessor::wrapperType_Standalone||[[[NSBundle mainBundle] bundlePath].pathExtension isEqualToString:@"appex"])return {};
    return std::make_unique<IOSNowPlaying>(engine);
}
const bool registered=[] {registerStandaloneNowPlayingFactory(makeNowPlaying);return true;}();
}
