#pragma once
#include <juce_core/juce_core.h>
// Physical-pixel display insets and current native device timing, for the shell.
juce::var androidPlatformState();
int androidInsetsRevision();
juce::var androidAudioDevices();
