#include "AndroidAudioOutput.h"
#include <atomic>
#include <mutex>

namespace {
std::mutex outputMutex;
AndroidAudioOutputInfo outputInfo;
AndroidAudioOutputInfo inputInfo;
void* inputContext=nullptr;
std::atomic<uint64_t> routeRevision{0};
void* outputContext=nullptr;
std::atomic<int> outputProfile{0}; // Production retains JUCE's float-first transport.
}

extern "C" void beatmakerAndroidOutputStarted(void* context,const AndroidAudioOutputInfo& info){
    std::lock_guard<std::mutex> lock(outputMutex);
    const int revision=outputInfo.revision+1;
    outputInfo=info;outputInfo.active=true;outputInfo.revision=revision;outputContext=context;
}
extern "C" void beatmakerAndroidOutputStopped(void* context){
    std::lock_guard<std::mutex> lock(outputMutex);
    if(context==outputContext){outputInfo.active=false;++outputInfo.revision;outputContext=nullptr;}
}
extern "C" int beatmakerAndroidOutputProfile(){return outputProfile.load();}
extern "C" void beatmakerAndroidInputStarted(void* context,const AndroidAudioOutputInfo& info){std::lock_guard<std::mutex> lock(outputMutex);const auto revision=inputInfo.revision+1;inputInfo=info;inputInfo.active=true;inputInfo.revision=revision;inputContext=context;}
extern "C" void beatmakerAndroidInputStopped(void* context){std::lock_guard<std::mutex> lock(outputMutex);if(context==inputContext){inputInfo.active=false;++inputInfo.revision;inputContext=nullptr;}}
AndroidAudioOutputInfo androidAudioInputInfo(){std::lock_guard<std::mutex> lock(outputMutex);return inputInfo;}
void androidAudioDevicesChanged(){++routeRevision;}
uint64_t androidAudioRouteRevision(){return routeRevision.load();}
AndroidAudioOutputInfo androidAudioOutputInfo(){std::lock_guard<std::mutex> lock(outputMutex);return outputInfo;}
bool androidSetOutputProfile(int profile){
   #if BEATMAKER_ANDROID_LATENCY_PROBE
    if(profile>=0&&profile<=3){outputProfile.store(profile);return true;}
   #else
    (void)profile;
   #endif
    return false;
}
