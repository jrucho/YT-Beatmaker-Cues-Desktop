#pragma once
#include <juce_core/juce_core.h>
juce::File decodeAndroidAudio(const juce::File&,juce::String&,const std::function<bool()>&);
