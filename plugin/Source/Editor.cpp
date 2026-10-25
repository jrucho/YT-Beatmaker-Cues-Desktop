#include "Editor.h"

namespace {
juce::String timeText(double seconds) {
    const auto value = (int) juce::jmax(0.0, seconds);
    return juce::String(value / 60) + ":" + juce::String(value % 60).paddedLeft('0', 2);
}
}

CueEditor::CueEditor(CueProcessor& processor) : AudioProcessorEditor(processor), engine(processor) {
   #if JUCE_IOS
    setSize(390, 720);
   #else
    setSize(800, 720);
   #endif
    setResizable(true, true);
    setResizeLimits(320, 660, 1200, 1200);
    title.setText("BEATMAKER CUES · LOCAL PLUG-IN PROTOTYPE", juce::dontSendNotification);
    title.setFont(juce::Font(juce::FontOptions(19.0f, juce::Font::bold)));
    for (auto* label : {&title, &status, &clock, &mappingHelp, &speedLabel, &gainLabel}) {
        addAndMakeVisible(label);
        label->setColour(juce::Label::textColourId, juce::Colours::whitesmoke);
    }
    for (auto* button : {&load, &demo, &play, &pause, &mark, &clear, &in, &out, &loop, &importApp}) {
        addAndMakeVisible(button); button->setTriggeredOnMouseDown(true);
    }
    load.onClick = [this] { chooseFile(); };
    demo.onClick = [this] { engine.loadDemo(); };
    play.onClick = [this] { engine.submit({CueProcessor::Action::play}); };
    pause.onClick = [this] { engine.submit({CueProcessor::Action::pause}); };
    mark.onClick = [this] { engine.submit({CueProcessor::Action::markNext}); };
    clear.onClick = [this] { engine.submit({CueProcessor::Action::clearBank, engine.selectedBank.load()}); };
    in.onClick = [this] { engine.submit({CueProcessor::Action::setIn}); };
    out.onClick = [this] { engine.submit({CueProcessor::Action::setOut}); };
    loop.onClick = [this] { engine.submit({CueProcessor::Action::toggleLoop}); };
    addAndMakeVisible(videoId); addAndMakeVisible(port);
    videoId.setTextToShowWhenEmpty("YouTube URL / video ID · desktop app must be running", juce::Colours::grey);
    port.setText("4280"); port.setInputRestrictions(5, "0123456789");
    importApp.onClick = [this] {
        auto text = videoId.getText().trim();
        if (text.contains("youtu.be/")) text = text.fromFirstOccurrenceOf("youtu.be/", false, false).upToFirstOccurrenceOf("?", false, false);
        else if (text.contains("v=")) text = text.fromFirstOccurrenceOf("v=", false, false).upToFirstOccurrenceOf("&", false, false);
        engine.loadFromApp(text, port.getText().getIntValue());
    };
   #if JUCE_IOS
    videoId.setVisible(false); port.setVisible(false); importApp.setVisible(false);
   #endif
    preset.addItem("SP-404MKII · Mode A", 1); preset.addItem("SP-404MKII · Mode B", 2); preset.addItem("Legacy · 12 pads", 3);
    preset.setSelectedId(engine.preset.load() + 1, juce::dontSendNotification);
    preset.onChange = [this] { engine.preset.store(preset.getSelectedId() - 1); resized(); };
    addAndMakeVisible(preset); addAndMakeVisible(overwrite);
    overwrite.setToggleState(engine.overwrite.load(), juce::dontSendNotification);
    overwrite.onClick = [this] { engine.overwrite.store(overwrite.getToggleState()); };
    overwrite.setColour(juce::ToggleButton::textColourId, juce::Colours::whitesmoke);
    for (int index = 0; index < 10; ++index) {
        auto& button = banks[(size_t) index];
        button.setButtonText(juce::String::charToString((juce::juce_wchar) ('A' + index)));
        button.onClick = [this, index] { engine.selectedBank.store(index); };
        addAndMakeVisible(button);
    }
    for (int index = 0; index < 16; ++index) {
        auto& button = pads[(size_t) index];
        button.setTriggeredOnMouseDown(true);
        button.onClick = [this, index] {
            engine.submit({CueProcessor::Action::pad, engine.selectedBank.load(), index, 0,
                engine.overwrite.load() || juce::ModifierKeys::getCurrentModifiers().isShiftDown()});
        };
        addAndMakeVisible(button);
    }
    for (auto* slider : {&timeline, &speed, &gain}) {
        addAndMakeVisible(slider);
        slider->setSliderStyle(juce::Slider::LinearHorizontal);
        slider->setTextBoxStyle(juce::Slider::TextBoxRight, false, 65, 22);
    }
    timeline.setRange(0, 1, 0.001);
    timeline.onDragEnd = [this] { engine.submit({CueProcessor::Action::seek, 0, 0, timeline.getValue()}); };
    speedAttachment = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(engine.parameters, "speed", speed);
    gainAttachment = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(engine.parameters, "gain", gain);
    speedLabel.setText("Varispeed (speed + pitch)", juce::dontSendNotification);
    gainLabel.setText("Output", juce::dontSendNotification);
    startTimerHz(25);
    timerCallback();
}

void CueEditor::chooseFile() {
    chooser = std::make_unique<juce::FileChooser>("Load a sample or song", juce::File{}, "*.wav;*.aif;*.aiff;*.flac;*.mp3;*.m4a");
    juce::Component::SafePointer<CueEditor> safe(this);
    chooser->launchAsync(juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
        [safe](const juce::FileChooser& result) {
            if (safe && result.getResult().existsAsFile()) safe->engine.loadFile(result.getResult());
        });
}

void CueEditor::paint(juce::Graphics& graphics) {
    graphics.fillAll(juce::Colour(0xff0b0d10));
}

void CueEditor::resized() {
    auto area = getLocalBounds().reduced(16);
    const bool compact = area.getWidth() < 600;
    title.setBounds(area.removeFromTop(32));
    status.setBounds(area.removeFromTop(26));
    auto top = area.removeFromTop(38);
    load.setBounds(top.removeFromLeft(110).reduced(2)); demo.setBounds(top.removeFromLeft(80).reduced(2));
    if (compact) {
        overwrite.setBounds(top.reduced(3));
        preset.setBounds(area.removeFromTop(35).reduced(3));
    } else {
        preset.setBounds(top.removeFromLeft(230).reduced(3)); overwrite.setBounds(top.reduced(3));
    }
    clear.setButtonText(compact ? "Clear" : "Clear bank");
    in.setButtonText(compact ? "IN" : "Set IN"); out.setButtonText(compact ? "OUT" : "Set OUT");
    auto row = area.removeFromTop(35);
    for (int i = 0; i < 10; ++i) banks[(size_t) i].setBounds(row.removeFromLeft(area.getWidth() / 10).reduced(2));
    area.removeFromTop(8);
    const int count = engine.padCount(), columns = count == 12 ? 3 : 4;
    const int height = juce::jmax(240, area.getHeight() - 232);
    auto grid = area.removeFromTop(height);
    for (int i = 0; i < 16; ++i) {
        pads[(size_t) i].setVisible(i < count);
        if (i < count) pads[(size_t) i].setBounds(grid.getX() + (i % columns) * grid.getWidth() / columns + 3,
            grid.getY() + (i / columns) * grid.getHeight() / 4 + 3,
            grid.getWidth() / columns - 6, grid.getHeight() / 4 - 6);
    }
    auto transport = area.removeFromTop(38);
    for (auto* button : {&play, &pause, &mark, &clear, &in, &out, &loop}) button->setBounds(transport.removeFromLeft(area.getWidth() / 7).reduced(2));
    clock.setBounds(area.removeFromTop(23));
    timeline.setBounds(area.removeFromTop(28));
    auto speedRow = area.removeFromTop(30); speedLabel.setBounds(speedRow.removeFromLeft(190)); speed.setBounds(speedRow);
    auto gainRow = area.removeFromTop(30); gainLabel.setBounds(gainRow.removeFromLeft(190)); gain.setBounds(gainRow);
    mappingHelp.setBounds(area.removeFromTop(28));
    auto importRow = area.removeFromTop(32);
    importApp.setBounds(importRow.removeFromRight(135).reduced(2)); port.setBounds(importRow.removeFromRight(65).reduced(2)); videoId.setBounds(importRow.reduced(2));
    lastPadCount = count;
}

void CueEditor::timerCallback() {
    const int bank = engine.selectedBank.load(), count = engine.padCount();
    if (count != lastPadCount) resized();
    preset.setSelectedId(engine.preset.load() + 1, juce::dontSendNotification);
    overwrite.setToggleState(engine.overwrite.load(), juce::dontSendNotification);
    status.setText(engine.getStatus(), juce::dontSendNotification);
    clock.setText("Bank " + juce::String::charToString((juce::juce_wchar) ('A' + bank)) + "  ·  "
        + timeText(engine.playhead.load()) + " / " + timeText(engine.getDuration()) + "  ·  "
        + (engine.playing.load() ? "Playing" : "Paused"), juce::dontSendNotification);
    for (int i = 0; i < 10; ++i) banks[(size_t) i].setColour(juce::TextButton::buttonColourId,
        i == bank ? juce::Colour(0xff287451) : juce::Colour(0xff24282d));
    for (int i = 0; i < count; ++i) {
        const double cue = engine.getCue(bank, i);
        pads[(size_t) i].setButtonText(juce::String(i + 1) + "   " + (cue >= 0 ? timeText(cue) : "MARK"));
        pads[(size_t) i].setColour(juce::TextButton::buttonColourId,
            engine.activePad.load() == bank * 16 + i ? juce::Colour(0xff378968)
                : cue >= 0 ? juce::Colour(0xff234439) : juce::Colour(0xff24282d));
    }
    if (!timeline.isMouseButtonDown()) {
        timeline.setRange(0, juce::jmax(0.001, engine.getDuration()), 0.001);
        timeline.setValue(engine.playhead.load(), juce::dontSendNotification);
    }
    loop.setButtonText(engine.loopEnabled.load() ? "Loop ON" : "Loop OFF");
    mappingHelp.setText(engine.preset.load() == 0 ? "Mode A: CH 1–10 = A–J · empty pad marks; saved pad plays"
        : engine.preset.load() == 1 ? "Mode B: CH 1 = A–E, CH 2 = F–J · Roland default channels"
        : "Legacy: notes 36–47 · selected bank · 12 pads", juce::dontSendNotification);
}
