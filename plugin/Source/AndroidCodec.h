#pragma once
#include <juce_core/juce_core.h>
#include <juce_audio_formats/juce_audio_formats.h>
std::unique_ptr<juce::AudioFormatReader> createAndroidAudioReader(const juce::File&,juce::String&,const std::function<bool()>&);
#if JUCE_DEBUG
juce::var checkAndroidReaderPCM(const juce::File&,const juce::File&);
#endif
