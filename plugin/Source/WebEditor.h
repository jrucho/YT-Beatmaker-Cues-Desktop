#pragma once
#include "Processor.h"
#include <juce_gui_extra/juce_gui_extra.h>

class MobileWebEditor final : public juce::AudioProcessorEditor, private juce::Timer {
public:
    explicit MobileWebEditor(CueProcessor&, bool offlineSmoke = false);
    ~MobileWebEditor() override;
    void resized() override;
    void evaluate(const juce::String& script, juce::WebBrowserComponent::EvaluationCallback callback) { browser.evaluateJavascript(script,std::move(callback)); }
    void paint(juce::Graphics& graphics) override { graphics.fillAll(juce::Colours::black); }
private:
    juce::WebBrowserComponent::Options options();
    std::optional<juce::WebBrowserComponent::Resource> resource(const juce::String&);
    juce::var audio(const juce::var&);
    void http(const juce::var&, juce::WebBrowserComponent::NativeFunctionCompletion);
    void timerCallback() override;
    void emit(const juce::String&, juce::var);
    bool uiStateIsStale() const;
    CueProcessor& engine;
    const bool offlineSmoke;
    juce::MemoryInputStream webBytes;
    juce::ZipFile archive;
    juce::WebBrowserComponent browser;
    juce::ThreadPool requests{4};
    juce::ThreadPool storageWorker{1};
    std::shared_ptr<std::atomic<bool>> cancelled=std::make_shared<std::atomic<bool>>(false);
    std::unique_ptr<juce::FileChooser> exporter;
    int sourceId=0, lastRevision=-1;
    bool announced=false, previousPlaying=false;
    bool pendingLoad=false;
    juce::String sourceUrl;
    void storageTask(std::function<juce::var()> action,juce::WebBrowserComponent::NativeFunctionCompletion);
    double lastPosition=0;
    std::array<unsigned int,160> previousPads{};
    int timerTicks=0;
    int previousTrackRevision=0,previousErrorRevision=0;
    int previousRestoreRevision=0;
    int previousSampleRevision=-1;
    int previousRemoteRevision=0;
    juce::String previousParameters;
    juce::String previousAndroidPlatform;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MobileWebEditor)
};
