#include "AndroidAudioOutput.h"
#include <atomic>
#include <mutex>

namespace {
std::mutex outputMutex;
AndroidAudioOutputInfo outputInfo;
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
AndroidAudioOutputInfo androidAudioOutputInfo(){std::lock_guard<std::mutex> lock(outputMutex);return outputInfo;}
bool androidSetOutputProfile(int profile){
   #if BEATMAKER_ANDROID_LATENCY_PROBE
    if(profile>=0&&profile<=3){outputProfile.store(profile);return true;}
   #else
    (void)profile;
   #endif
    return false;
}
