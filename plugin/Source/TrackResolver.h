#pragma once
#include <juce_core/juce_core.h>
juce::var resolveYouTubeTrack(const juce::String& id,const std::function<bool()>& cancelled);
