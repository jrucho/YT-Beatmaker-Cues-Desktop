#pragma once
#include <memory>
#include <juce_core/juce_core.h>
class CueProcessor;
class StandaloneNowPlaying {
public:
    virtual ~StandaloneNowPlaying()=default;
    virtual juce::var audioRoutes(){auto* fields=new juce::DynamicObject;fields->setProperty("supported",false);return juce::var(fields);}
    virtual void configureAudio(const juce::var&,std::function<void(juce::var)> complete){auto* fields=new juce::DynamicObject;fields->setProperty("__error","Audio routing is unavailable in this wrapper");complete(juce::var(fields));}
};
std::unique_ptr<StandaloneNowPlaying> createStandaloneNowPlaying(CueProcessor&);
using StandaloneNowPlayingFactory=std::unique_ptr<StandaloneNowPlaying>(*)(CueProcessor&);
void registerStandaloneNowPlayingFactory(StandaloneNowPlayingFactory);
std::unique_ptr<StandaloneNowPlaying> createStandaloneAudioRoutes(CueProcessor&);
void registerStandaloneAudioRoutesFactory(StandaloneNowPlayingFactory);
