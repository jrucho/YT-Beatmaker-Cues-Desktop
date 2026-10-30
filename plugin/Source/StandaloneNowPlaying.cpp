#include "StandaloneNowPlaying.h"
#include "Processor.h"
#include <atomic>
namespace {std::atomic<StandaloneNowPlayingFactory> factory{nullptr};}
void registerStandaloneNowPlayingFactory(StandaloneNowPlayingFactory value){factory.store(value);}
#if !JUCE_IOS && !JUCE_ANDROID
namespace {
class MinimalStandaloneShell final:public StandaloneNowPlaying,private juce::Timer {
public:
    explicit MinimalStandaloneShell(CueProcessor& value):engine(value){startTimer(50);}
private:
    void timerCallback() override {
        auto* editor=engine.getActiveEditor();if(!editor)return;
        auto* window=dynamic_cast<juce::DocumentWindow*>(editor->getTopLevelComponent());if(!window)return;
        window->setUsingNativeTitleBar(true);
        for(int i=0;i<window->getNumChildComponents();++i)if(auto* button=dynamic_cast<juce::Button*>(window->getChildComponent(i)))if(button->getButtonText()=="Options")button->setVisible(false);
        stopTimer();
    }
    CueProcessor& engine;
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
