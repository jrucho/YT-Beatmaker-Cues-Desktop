#pragma once
#include "Processor.h"

class CueEditor final : public juce::AudioProcessorEditor, private juce::Timer {
public:
    explicit CueEditor(CueProcessor&);
    void paint(juce::Graphics&) override;
    void resized() override;
private:
    void timerCallback() override;
    void chooseFile();
    CueProcessor& engine;
    juce::Label title, status, clock, mappingHelp, speedLabel, gainLabel;
    juce::TextButton load{"Load audio"}, demo{"Demo"}, play{"Play"}, pause{"Pause"}, mark{"Mark"}, clear{"Clear bank"};
    juce::TextButton in{"Set IN"}, out{"Set OUT"}, loop{"Loop"}, importApp{"Import app track"};
    juce::TextEditor videoId, port;
    juce::ToggleButton overwrite{"Overwrite cues"};
    juce::ComboBox preset;
    std::array<juce::TextButton, 10> banks;
    std::array<juce::TextButton, 16> pads;
    juce::Slider timeline, speed, gain;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> speedAttachment, gainAttachment;
    std::unique_ptr<juce::FileChooser> chooser;
    int lastPadCount = -1;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(CueEditor)
};
