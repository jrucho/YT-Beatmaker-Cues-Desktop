#include "StandaloneNowPlaying.h"
#include <atomic>
namespace {std::atomic<StandaloneNowPlayingFactory> factory{nullptr};}
void registerStandaloneNowPlayingFactory(StandaloneNowPlayingFactory value){factory.store(value);}
std::unique_ptr<StandaloneNowPlaying> createStandaloneNowPlaying(CueProcessor& engine){if(const auto create=factory.load())return create(engine);return {};}
