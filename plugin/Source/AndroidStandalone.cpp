#include "Processor.h"
#include "StandaloneNowPlaying.h"
#include "AndroidStandalone.h"
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_audio_plugin_client/Standalone/juce_StandaloneFilterWindow.h>
#include <jni.h>
#include <juce_core/native/juce_JNIHelpers_android.h>

namespace {
std::atomic<CueProcessor*> current{nullptr};
std::array<std::atomic<int>,4> safeInsets{};
jclass bridge=nullptr;jmethodID publishMethod=nullptr,shutdownMethod=nullptr,backgroundMethod=nullptr;
class AndroidNowPlaying final:public StandaloneNowPlaying,private juce::Timer {
public:
    explicit AndroidNowPlaying(CueProcessor& value):engine(value){current.store(&engine);if(bridge&&backgroundMethod)engine.backgroundPlayback.store(juce::getEnv()->CallStaticBooleanMethod(bridge,backgroundMethod));startTimer(20);}
    ~AndroidNowPlaying() override {stopTimer();current.store(nullptr);if(bridge&&shutdownMethod)juce::getEnv()->CallStaticVoidMethod(bridge,shutdownMethod);}
private:
    void timerCallback() override {
        if(!audioConfigured){
            if(auto* holder=juce::StandalonePluginHolder::getInstance())if(auto* device=holder->deviceManager.getCurrentAudioDevice()){
                auto sizes=device->getAvailableBufferSizes();sizes.sort();
                if(!sizes.isEmpty()){
                    const auto previous=holder->deviceManager.getAudioDeviceSetup();auto setup=previous;
                    // Two hardware bursts give a practical low-latency margin,
                    // instead of JUCE Android's default 40/100 ms queue.
                    int target=sizes[0];for(const int size:sizes)if(size>=sizes[0]*2){target=size;break;}
                    if(setup.bufferSize>target){setup.bufferSize=target;
                        const auto error=holder->deviceManager.setAudioDeviceSetup(setup,true);
                        if(error.isNotEmpty()){juce::Logger::outputDebugString("Android low-latency setup: "+error);holder->deviceManager.setAudioDeviceSetup(previous,true);}
                    }
                }
                audioConfigured=true;startTimerHz(2);
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
};
std::unique_ptr<StandaloneNowPlaying> makeAndroid(CueProcessor& engine){if(engine.wrapperType!=juce::AudioProcessor::wrapperType_Standalone)return {};return std::make_unique<AndroidNowPlaying>(engine);}
const bool registered=[] {registerStandaloneNowPlayingFactory(makeAndroid);return true;}();
}
juce::var androidPlatformState(){
    auto* result=new juce::DynamicObject;
    const char* names[]{"left","top","right","bottom"};
    for(size_t i=0;i<4;++i)result->setProperty(names[i],safeInsets[i].load());
    if(auto* holder=juce::StandalonePluginHolder::getInstance())if(auto* device=holder->deviceManager.getCurrentAudioDevice()){
        result->setProperty("bufferFrames",device->getCurrentBufferSizeSamples());
        result->setProperty("sampleRate",device->getCurrentSampleRate());
        result->setProperty("outputLatencyFrames",device->getOutputLatencyInSamples());
    }
    return juce::var(result);
}
extern "C" JNIEXPORT void JNICALL Java_app_musike_android_StandaloneBridge_setInsets(JNIEnv*,jclass,jint left,jint top,jint right,jint bottom){
    const int values[]{left,top,right,bottom};for(size_t i=0;i<4;++i)safeInsets[i].store(juce::jmax(0,values[i]));
}
extern "C" JNIEXPORT void JNICALL Java_app_musike_android_StandaloneBridge_bind(JNIEnv* env,jclass type,jobject){
    if(bridge)env->DeleteGlobalRef(bridge);bridge=(jclass)env->NewGlobalRef(type);
    publishMethod=env->GetStaticMethodID(type,"publish","(Ljava/lang/String;)V");shutdownMethod=env->GetStaticMethodID(type,"shutdown","()V");backgroundMethod=env->GetStaticMethodID(type,"isBackground","()Z");
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
