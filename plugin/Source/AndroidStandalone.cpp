#include "Processor.h"
#include "StandaloneNowPlaying.h"
#include "AndroidStandalone.h"
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_audio_plugin_client/Standalone/juce_StandaloneFilterWindow.h>
#include <jni.h>
#include <juce_core/native/juce_JNIHelpers_android.h>
#include <limits>

namespace {
std::atomic<CueProcessor*> current{nullptr};
std::mutex engineAccess;
std::array<std::atomic<int>,4> safeInsets{};
std::atomic<int> insetsRevision{0};
std::atomic<int> minimumBufferFrames{0},requestedBufferFrames{0},initialXRuns{-1},bufferFallbacks{0};
 #if BEATMAKER_ANDROID_LATENCY_PROBE
std::atomic<int> forcedBufferBursts{0};
 #endif
jclass bridge=nullptr;jmethodID publishMethod=nullptr,shutdownMethod=nullptr,backgroundMethod=nullptr,nativeRateMethod=nullptr;
class AndroidNowPlaying final:public StandaloneNowPlaying,private juce::Timer {
public:
    explicit AndroidNowPlaying(CueProcessor& value):engine(value){{std::lock_guard<std::mutex> lock(engineAccess);current.store(&engine);}if(bridge&&backgroundMethod)engine.backgroundPlayback.store(juce::getEnv()->CallStaticBooleanMethod(bridge,backgroundMethod));startTimer(20);}
    ~AndroidNowPlaying() override {stopTimer();{std::lock_guard<std::mutex> lock(engineAccess);current.store(nullptr);}if(bridge&&shutdownMethod)juce::getEnv()->CallStaticVoidMethod(bridge,shutdownMethod);}
private:
    void timerCallback() override {
        if(auto* holder=juce::StandalonePluginHolder::getInstance())if(auto* device=holder->deviceManager.getCurrentAudioDevice()){
           #if BEATMAKER_ANDROID_LATENCY_PROBE
            if(lastForcedBursts!=forcedBufferBursts.load()){lastForcedBursts=forcedBufferBursts.load();audioConfigured=false;}
           #endif
            if(!audioConfigured||device!=configuredDevice){
                sizes=device->getAvailableBufferSizes();sizes.sort();
                const auto previous=holder->deviceManager.getAudioDeviceSetup();auto setup=previous;
                if(!sizes.isEmpty()){
                    burst=sizes[0];minimumBufferFrames.store(burst);initialXRuns.store(device->getXRunCount());
                    // Two native bursts are the stable low-latency starting
                    // point. Native touch routing removes UI wait instead of
                    // making the audio queue too small to play cleanly.
                    int wanted=burst*2;
                   #if BEATMAKER_ANDROID_LATENCY_PROBE
                    if(lastForcedBursts>0)wanted=burst*lastForcedBursts;
                   #endif
                    int target=sizes.getLast();for(const int size:sizes)if(size>=wanted){target=size;break;}
                    setup.bufferSize=target;
                    requestedBufferFrames.store(setup.bufferSize);
                    if(bridge&&nativeRateMethod){const int rate=juce::getEnv()->CallStaticIntMethod(bridge,nativeRateMethod);if(rate>0&&device->getAvailableSampleRates().contains((double)rate))setup.sampleRate=rate;}
                    if(setup.bufferSize!=previous.bufferSize||setup.sampleRate!=previous.sampleRate){
                        const auto error=holder->deviceManager.setAudioDeviceSetup(setup,true);
                        if(error.isNotEmpty()){juce::Logger::outputDebugString("Android low-latency setup: "+error);holder->deviceManager.setAudioDeviceSetup(previous,true);}
                    }
                }
                configuredDevice=holder->deviceManager.getCurrentAudioDevice();
                lastXRuns=configuredDevice?configuredDevice->getXRunCount():0;
                warmupUntil=juce::Time::getMillisecondCounterHiRes()+2000;
                xrunBudget=0;
                audioConfigured=true;startTimerHz(2);
            }else{
                const int xruns=device->getXRunCount();const int delta=xruns>=lastXRuns?xruns-lastXRuns:0;lastXRuns=xruns;
                if(juce::Time::getMillisecondCounterHiRes()>warmupUntil)xrunBudget+=delta;
                bool canAdapt=true;
               #if BEATMAKER_ANDROID_LATENCY_PROBE
                canAdapt=lastForcedBursts==0;
               #endif
                if(canAdapt&&xrunBudget>=3&&burst>0){
                    const auto previous=holder->deviceManager.getAudioDeviceSetup();auto setup=previous;
                    for(const int size:sizes)if(size>setup.bufferSize&&size<=burst*4){setup.bufferSize=size;break;}
                    if(setup.bufferSize!=previous.bufferSize){
                        requestedBufferFrames.store(setup.bufferSize);bufferFallbacks.fetch_add(1);
                        const auto error=holder->deviceManager.setAudioDeviceSetup(setup,true);
                        if(error.isNotEmpty())holder->deviceManager.setAudioDeviceSetup(previous,true);
                        configuredDevice=holder->deviceManager.getCurrentAudioDevice();lastXRuns=configuredDevice?configuredDevice->getXRunCount():0;
                        warmupUntil=juce::Time::getMillisecondCounterHiRes()+2000;
                        xrunBudget=0;
                    }
                }
            }
        }
        if(!bridge||!publishMethod)return;
        auto data=engine.nativeSnapshot();auto* fields=data.getDynamicObject();
        fields->setProperty("wantedPlaying",engine.requestedPlay.load()&&!engine.nativeEnded.load());
        fields->setProperty("playbackRate",engine.playing.load()&&engine.ready.load()?(double)data["rate"]:0.0);
        fields->setProperty("playIntentRevision",engine.playIntentRevision.load());
        const auto json=juce::JSON::toString(data,true);juce::getEnv()->CallStaticVoidMethod(bridge,publishMethod,juce::javaString(json).get());
        if(juce::getEnv()->ExceptionCheck()){juce::getEnv()->ExceptionDescribe();juce::getEnv()->ExceptionClear();}
    }
    CueProcessor& engine;
    bool audioConfigured=false;
    juce::AudioIODevice* configuredDevice=nullptr;
    juce::Array<int> sizes;int burst=0,lastXRuns=0,xrunBudget=0;double warmupUntil=0;
   #if BEATMAKER_ANDROID_LATENCY_PROBE
    int lastForcedBursts=0;
   #endif
};
std::unique_ptr<StandaloneNowPlaying> makeAndroid(CueProcessor& engine){if(engine.wrapperType!=juce::AudioProcessor::wrapperType_Standalone)return {};return std::make_unique<AndroidNowPlaying>(engine);}
const bool registered=[] {registerStandaloneNowPlayingFactory(makeAndroid);return true;}();
}
int androidInsetsRevision(){return insetsRevision.load();}
juce::var androidPlatformState(){
    auto* result=new juce::DynamicObject;
    const char* names[]{"left","top","right","bottom"};
    for(size_t i=0;i<4;++i)result->setProperty(names[i],safeInsets[i].load());
    result->setProperty("minimumBufferFrames",minimumBufferFrames.load());result->setProperty("requestedBufferFrames",requestedBufferFrames.load());
    result->setProperty("initialXRuns",initialXRuns.load());result->setProperty("bufferFallbacks",bufferFallbacks.load());
    if(auto* holder=juce::StandalonePluginHolder::getInstance())if(auto* device=holder->deviceManager.getCurrentAudioDevice()){
        result->setProperty("bufferFrames",device->getCurrentBufferSizeSamples());
        result->setProperty("sampleRate",device->getCurrentSampleRate());
        result->setProperty("outputLatencyFrames",device->getOutputLatencyInSamples());
        result->setProperty("deviceType",device->getTypeName());result->setProperty("xRuns",device->getXRunCount());
    }
    {std::lock_guard<std::mutex> lock(engineAccess);if(auto* engine=current.load()){
        result->setProperty("fastCommandsAccepted",engine->androidFastAccepted.load());result->setProperty("fastCommandsRendered",engine->androidFastRendered.load());
        result->setProperty("lastFastCommandToRenderMs",engine->androidFastLastRenderMs.load());
        result->setProperty("callbackFrames",engine->androidCallbackFrames.load());result->setProperty("callbackElapsedMs",engine->androidCallbackMs.load());
        result->setProperty("peakCallbackElapsedMs",engine->androidPeakCallbackMs.load());
        result->setProperty("nativeTouchCommands",engine->androidNativeTouches.load());
        result->setProperty("audioGeneration",engine->androidAudioGeneration());result->setProperty("sourceId",engine->androidBridgeSourceId.load());
    }}
    return juce::var(result);
}
extern "C" JNIEXPORT void JNICALL Java_app_musike_android_StandaloneBridge_setInsets(JNIEnv*,jclass,jint left,jint top,jint right,jint bottom){
    const int values[]{left,top,right,bottom};bool changed=false;
    for(size_t i=0;i<4;++i){const int value=juce::jmax(0,values[i]);if(safeInsets[i].exchange(value)!=value)changed=true;}
    if(changed)++insetsRevision;
}
extern "C" JNIEXPORT void JNICALL Java_app_musike_android_StandaloneBridge_bind(JNIEnv* env,jclass type,jobject){
    if(bridge)env->DeleteGlobalRef(bridge);bridge=(jclass)env->NewGlobalRef(type);
    publishMethod=env->GetStaticMethodID(type,"publish","(Ljava/lang/String;)V");shutdownMethod=env->GetStaticMethodID(type,"shutdown","()V");backgroundMethod=env->GetStaticMethodID(type,"isBackground","()Z");
    nativeRateMethod=env->GetStaticMethodID(type,"nativeSampleRate","()I");
}
extern "C" JNIEXPORT jboolean JNICALL Java_app_musike_android_StandaloneBridge_performance(JNIEnv*,jclass,jint action,jint sourceId,jdouble value,jint bank,jint pad){
   #if BEATMAKER_ANDROID_LATENCY_PROBE
    if(action==5&&std::isfinite(value)&&value>=0&&value<=4){forcedBufferBursts.store((int)value);return true;}
   #endif
    std::lock_guard<std::mutex> lock(engineAccess);auto* engine=current.load();if(!engine)return false;
    if(action==4){
        if(!engine->hasPadSample(bank,pad))return false;
        return engine->submitAndroidPerformance({CueProcessor::Action::pad,bank,pad});
    }
    if(engine->backgroundPlayback.load()||engine->nativeAdvancing.load()||!engine->ready.load()||engine->androidBridgeSourceId.load()!=sourceId)return false;
    CueProcessor::Action target;
    if(action==0)target=CueProcessor::Action::cue;else if(action==1)target=CueProcessor::Action::seek;
    else if(action==2)target=CueProcessor::Action::play;else if(action==3)target=CueProcessor::Action::pause;else return false;
    if((action==0||action==1)&&(!std::isfinite(value)||value<0))return false;
    if(action==0&&(bank<0||bank>=10||pad<-1||pad>=16))return false;
    const bool accepted=engine->submitAndroidPerformance({target,bank,pad,value});
    if(accepted&&(action==0||action==2||action==3)){engine->requestedPlay.store(action!=3);if(action!=0)engine->playIntentRevision.fetch_add(1);}
    return accepted;
}
extern "C" JNIEXPORT jdouble JNICALL Java_app_musike_android_StandaloneBridge_performancePosition(JNIEnv*,jclass,jint sourceId){
    std::lock_guard<std::mutex> lock(engineAccess);auto* engine=current.load();
    return engine&&engine->ready.load()&&engine->androidBridgeSourceId.load()==sourceId?engine->playhead.load():std::numeric_limits<double>::quiet_NaN();
}
extern "C" JNIEXPORT jdouble JNICALL Java_app_musike_android_StandaloneBridge_performanceTouch(JNIEnv*,jclass,jint sourceId,jint generation,jdouble target,jint bank,jint pad,jboolean sample,jboolean enabled,jdouble ageMs){
    std::lock_guard<std::mutex> lock(engineAccess);auto* engine=current.load();
    const auto unavailable=std::numeric_limits<double>::quiet_NaN();
    if(!engine||engine->backgroundPlayback.load()||bank<0||bank>=10||pad<0||pad>=16)return unavailable;
    if(engine->hasPadSample(bank,pad)!=(bool)sample)return unavailable;
    if(!sample&&(!engine->ready.load()||engine->nativeAdvancing.load()||engine->androidBridgeSourceId.load()!=sourceId||engine->androidAudioGeneration()!=generation||!std::isfinite(target)||target<0))return unavailable;
    const auto started=juce::Time::getMillisecondCounterHiRes()-juce::jlimit(0.0,60000.0,(double)ageMs);
    if(!enabled){engine->androidTouchStartedMs[(size_t)(bank*16+pad)].store(started);return unavailable;} // Internal comparison: timestamp the normal UI route.
    const auto origin=engine->playhead.load();
    CueProcessor::Command command{sample?CueProcessor::Action::pad:CueProcessor::Action::cue,bank,pad,target};
    command.androidStartedMs=started;
    if(!sample)command.androidGeneration=generation;
    const bool accepted=engine->submitAndroidPerformance(command);
    if(!accepted)return unavailable;
    engine->androidNativeTouches.fetch_add(1);if(!sample)engine->requestedPlay.store(true);
    return origin;
}
extern "C" JNIEXPORT void JNICALL Java_app_musike_android_StandaloneBridge_background(JNIEnv*,jclass,jboolean value){if(auto* engine=current.load())engine->backgroundPlayback.store(value);}
extern "C" JNIEXPORT jboolean JNICALL Java_app_musike_android_StandaloneBridge_transport(JNIEnv* env,jclass,jstring command,jdouble position){
    const auto action=juce::juceString(command);CueProcessor::RemoteAction target;
    if(action=="play")target=CueProcessor::RemoteAction::play;else if(action=="pause")target=CueProcessor::RemoteAction::pause;else if(action=="toggle")target=CueProcessor::RemoteAction::toggle;else if(action=="seek")target=CueProcessor::RemoteAction::seek;else if(action=="next")target=CueProcessor::RemoteAction::next;else if(action=="previous")target=CueProcessor::RemoteAction::previous;else return false;
    if(auto* engine=current.load()){
        if(juce::MessageManager::getInstance()->isThisTheMessageThread())return engine->performRemoteAction(target,position);
        juce::MessageManager::callAsync([target,position]{if(auto* value=current.load())value->performRemoteAction(target,position);});return true;
    }return false;
}
extern "C" JNIEXPORT jstring JNICALL Java_app_musike_android_StandaloneBridge_snapshot(JNIEnv* env,jclass){
    auto* engine=current.load();auto data=engine?engine->nativeSnapshot():juce::var(new juce::DynamicObject);
    if(engine)data.getDynamicObject()->setProperty("playIntentRevision",engine->playIntentRevision.load());return juce::javaString(juce::JSON::toString(data,true)).release();
}
