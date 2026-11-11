#include "StandaloneNowPlaying.h"
#include "Processor.h"
#include <atomic>
namespace {std::atomic<StandaloneNowPlayingFactory> factory{nullptr},audioFactory{nullptr};}
void registerStandaloneNowPlayingFactory(StandaloneNowPlayingFactory value){factory.store(value);}
void registerStandaloneAudioRoutesFactory(StandaloneNowPlayingFactory value){audioFactory.store(value);}
std::unique_ptr<StandaloneNowPlaying> createStandaloneAudioRoutes(CueProcessor& engine){if(auto create=audioFactory.load())return create(engine);return {};}
#if !JUCE_IOS && !JUCE_ANDROID
namespace {
class MinimalStandaloneShell final:public StandaloneNowPlaying,private juce::Timer {
public:
    explicit MinimalStandaloneShell(CueProcessor& value):engine(value),routes(createStandaloneAudioRoutes(value)){startTimer(50);}
    juce::var audioRoutes() override{return routes?routes->audioRoutes():StandaloneNowPlaying::audioRoutes();}
    void configureAudio(const juce::var& value,std::function<void(juce::var)> complete) override{if(routes)routes->configureAudio(value,std::move(complete));else StandaloneNowPlaying::configureAudio(value,std::move(complete));}
private:
    void timerCallback() override {
        auto* editor=engine.getActiveEditor();if(!editor)return;
        auto* window=dynamic_cast<juce::DocumentWindow*>(editor->getTopLevelComponent());if(!window)return;
        window->setUsingNativeTitleBar(true);
        for(int i=0;i<window->getNumChildComponents();++i)if(auto* button=dynamic_cast<juce::Button*>(window->getChildComponent(i)))if(button->getButtonText()=="Options")button->setVisible(false);
        stopTimer();
    }
    CueProcessor& engine;
    std::unique_ptr<StandaloneNowPlaying> routes;
};
}
#endif
std::unique_ptr<StandaloneNowPlaying> createStandaloneNowPlaying(CueProcessor& engine){
    if(const auto create=factory.load())return create(engine);
   #if !JUCE_IOS && !JUCE_ANDROID
    if(engine.wrapperType==juce::AudioProcessor::wrapperType_Standalone)return std::make_unique<MinimalStandaloneShell>(engine);
   #endif
    return {};
}
