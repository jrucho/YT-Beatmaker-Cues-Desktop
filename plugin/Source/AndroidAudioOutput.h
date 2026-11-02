#pragma once

// Small app-owned hook into the pinned JUCE/Oboe backend. No decoder or DSP
// changes: inspect the stream that actually opened, including fallback routes.
struct AndroidAudioOutputInfo {
    bool active=false,mmap=false;
    int revision=0,api=0,performance=0,sharing=0,format=0;
    int rate=0,channels=0,burst=0,buffer=0,capacity=0,device=0,usage=0,content=0;
};

extern "C" void beatmakerAndroidOutputStarted(void*,const AndroidAudioOutputInfo&);
extern "C" void beatmakerAndroidOutputStopped(void*);
extern "C" int beatmakerAndroidOutputProfile();
AndroidAudioOutputInfo androidAudioOutputInfo();
bool androidSetOutputProfile(int);
