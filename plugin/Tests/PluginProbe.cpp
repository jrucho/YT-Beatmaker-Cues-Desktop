#include <juce_audio_utils/juce_audio_utils.h>
#include <iostream>

int main(int argc, char** argv) {
    juce::ScopedJuceInitialiser_GUI initialise;
    if (argc != 2) { std::cerr << "Usage: PluginProbe path/to/plugin.vst3\n"; return 2; }
    juce::AudioPluginFormatManager formats;
    juce::addDefaultFormatsToManager(formats);
    juce::OwnedArray<juce::PluginDescription> descriptions;
    for (int i = 0; i < formats.getNumFormats(); ++i) formats.getFormat(i)->findAllTypesForFile(descriptions, argv[1]);
    if (descriptions.isEmpty()) { std::cerr << "No plug-in found\n"; return 1; }
    for (const auto* description : descriptions) {
        juce::String error;
        auto instance = formats.createPluginInstance(*description, 48000, 256, error);
        if (!instance) { std::cerr << error << "\n"; return 1; }
        instance->prepareToPlay(48000, 256);
        juce::AudioBuffer<float> audio(2, 256); juce::MidiBuffer midi;
        for (int i = 0; i < 100; ++i) {
            audio.clear(); midi.addEvent(juce::MidiMessage::noteOn(1, 48, (juce::uint8) 100), 31);
            instance->processBlock(audio, midi);
            if (audio.getMagnitude(0, 256) != 0) { std::cerr << "Empty plug-in must be silent\n"; return 1; }
        }
        juce::MemoryBlock state; instance->getStateInformation(state);
        instance->setStateInformation(state.getData(), (int) state.getSize());
        std::unique_ptr<juce::AudioProcessorEditor> editor(instance->createEditorIfNeeded());
        if (!editor || editor->getWidth() < 320) { std::cerr << "Editor failed\n"; return 1; }
        if (description->pluginFormatName == "VST3") {
            // Exercise the actual plug-in binary through the host's VST3 state envelope.
            juce::XmlElement saved("BeatmakerCuesPrototype");
            saved.setAttribute("version", 1); saved.setAttribute("file", "demo:");
            auto* cue = saved.createNewChildElement("Cue");
            cue->setAttribute("bank", 0); cue->setAttribute("pad", 0); cue->setAttribute("time", 0.5);
            juce::MemoryBlock processorState, hostState;
            juce::AudioProcessor::copyXmlToBinary(saved, processorState);
            juce::XmlElement envelope("VST3PluginState");
            envelope.createNewChildElement("IComponent")->addTextElement(processorState.toBase64Encoding());
            juce::AudioProcessor::copyXmlToBinary(envelope, hostState);
            instance->setStateInformation(hostState.getData(), (int) hostState.getSize());
            bool audible = false;
            for (int i = 0; i < 300 && !audible; ++i) {
                juce::Thread::sleep(10);
                audio.clear(); midi.clear();
                midi.addEvent(juce::MidiMessage::noteOn(1, 48, (juce::uint8) 100), 31);
                instance->processBlock(audio, midi);
                audible = audio.getMagnitude(0, 256) > 0.01f;
            }
            if (!audible) { std::cerr << "Demo did not produce DAW-bus audio via MIDI\n"; return 1; }
            std::cout << "PASS: VST3 demo rendered into host audio buffers from MIDI\n";
        }
        editor.reset(); instance->releaseResources();
        std::cout << "PASS: loaded " << description->name << " (" << description->pluginFormatName
                  << "), processed MIDI/audio, round-tripped state and created editor\n";
    }
    return 0;
}
