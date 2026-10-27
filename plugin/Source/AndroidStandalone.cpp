#include "Processor.h"
#include "StandaloneNowPlaying.h"
#include <jni.h>
#include <juce_core/native/juce_JNIHelpers_android.h>

namespace {
std::atomic<CueProcessor*> current{nullptr};
jclass bridge=nullptr;jmethodID publishMethod=nullptr,shutdownMethod=nullptr,backgroundMethod=nullptr;
class AndroidNowPlaying final:public StandaloneNowPlaying,private juce::Timer {
public:
    explicit AndroidNowPlaying(CueProcessor& value):engine(value){current.store(&engine);if(bridge&&backgroundMethod)engine.backgroundPlayback.store(juce::getEnv()->CallStaticBooleanMethod(bridge,backgroundMethod));startTimerHz(2);}
    ~AndroidNowPlaying() override {stopTimer();current.store(nullptr);if(bridge&&shutdownMethod)juce::getEnv()->CallStaticVoidMethod(bridge,shutdownMethod);}
private:
    void timerCallback() override {
        if(!bridge||!publishMethod)return;
        auto data=engine.nativeSnapshot();auto* fields=data.getDynamicObject();
        fields->setProperty("wantedPlaying",engine.requestedPlay.load()&&!engine.nativeEnded.load());
        fields->setProperty("playbackRate",engine.playing.load()&&engine.ready.load()?(double)data["rate"]:0.0);
        fields->setProperty("playIntentRevision",engine.playIntentRevision.load());
        const auto json=juce::JSON::toString(data,true);juce::getEnv()->CallStaticVoidMethod(bridge,publishMethod,juce::javaString(json).get());
        if(juce::getEnv()->ExceptionCheck()){juce::getEnv()->ExceptionDescribe();juce::getEnv()->ExceptionClear();}
    }
    CueProcessor& engine;
};
std::unique_ptr<StandaloneNowPlaying> makeAndroid(CueProcessor& engine){if(engine.wrapperType!=juce::AudioProcessor::wrapperType_Standalone)return {};return std::make_unique<AndroidNowPlaying>(engine);}
const bool registered=[] {registerStandaloneNowPlayingFactory(makeAndroid);return true;}();
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
