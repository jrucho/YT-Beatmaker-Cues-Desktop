#include "Processor.h"
#include "StandaloneNowPlaying.h"
#import <AVFoundation/AVFoundation.h>
#import <MediaPlayer/MediaPlayer.h>
#import <ImageIO/ImageIO.h>
#import <UIKit/UIKit.h>

namespace {
class IOSNowPlaying;
struct Callbacks {std::atomic<IOSNowPlaying*> owner{nullptr};std::atomic<bool> available{false};};
class IOSNowPlaying final:public StandaloneNowPlaying,private juce::Timer {
public:
    explicit IOSNowPlaying(CueProcessor& processor):engine(processor){
        callbacks->owner.store(this);commands=[[NSMutableArray alloc] init];observers=[[NSMutableArray alloc] init];
        auto* center=[MPRemoteCommandCenter sharedCommandCenter];
        add(center.playCommand,CueProcessor::RemoteAction::play);add(center.pauseCommand,CueProcessor::RemoteAction::pause);
        add(center.togglePlayPauseCommand,CueProcessor::RemoteAction::toggle);add(center.nextTrackCommand,CueProcessor::RemoteAction::next);
        add(center.previousTrackCommand,CueProcessor::RemoteAction::previous);add(center.changePlaybackPositionCommand,CueProcessor::RemoteAction::seek);
        const auto state=callbacks;
        observe(AVAudioSessionInterruptionNotification,^(NSNotification* notification){
            const auto type=[notification.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
            const auto options=[notification.userInfo[AVAudioSessionInterruptionOptionKey] unsignedIntegerValue];
            if(auto* owner=state->owner.load())owner->interruption(type,options);
        });
        observe(AVAudioSessionRouteChangeNotification,^(NSNotification* notification){
            if([notification.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue]==AVAudioSessionRouteChangeReasonOldDeviceUnavailable)
                if(auto* owner=state->owner.load())owner->remote(CueProcessor::RemoteAction::pause,0);
        });
        observe(UIApplicationDidEnterBackgroundNotification,^(NSNotification*){if(auto* owner=state->owner.load()){owner->engine.backgroundPlayback.store(true);owner->tick();}});
        observe(UIApplicationWillEnterForegroundNotification,^(NSNotification*){if(auto* owner=state->owner.load()){owner->engine.backgroundPlayback.store(false);owner->tick();}});
        [[UIApplication sharedApplication] beginReceivingRemoteControlEvents];
        startTimerHz(5);
        juce::Logger::outputDebugString("Beatmaker plug-in standalone: native Now Playing controls enabled");
    }
    ~IOSNowPlaying() override {
        stopTimer();callbacks->available.store(false);callbacks->owner.store(nullptr);engine.backgroundPlayback.store(false);
        for(NSArray* pair in commands){[(MPRemoteCommand*)pair[0] removeTarget:pair[1]];[(MPRemoteCommand*)pair[0] setEnabled:[pair[2] boolValue]];}
        for(id token in observers)[[NSNotificationCenter defaultCenter] removeObserver:token];
        [commands release];[observers release];[artworkTask cancel];[artworkTask release];[artwork release];
        if(published){[MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo=nil;[MPNowPlayingInfoCenter defaultCenter].playbackState=MPNowPlayingPlaybackStateStopped;}
        [[UIApplication sharedApplication] endReceivingRemoteControlEvents];
    }
private:
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
