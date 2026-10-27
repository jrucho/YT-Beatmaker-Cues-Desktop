#pragma once
#include <memory>
class CueProcessor;
class StandaloneNowPlaying {
public:
    virtual ~StandaloneNowPlaying()=default;
};
std::unique_ptr<StandaloneNowPlaying> createStandaloneNowPlaying(CueProcessor&);
using StandaloneNowPlayingFactory=std::unique_ptr<StandaloneNowPlaying>(*)(CueProcessor&);
void registerStandaloneNowPlayingFactory(StandaloneNowPlayingFactory);
