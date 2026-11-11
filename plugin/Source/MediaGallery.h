#pragma once
#include <juce_gui_basics/juce_gui_basics.h>

struct GallerySelection {juce::URL source;juce::String name,error;juce::File temporaryDirectory;};
class MediaGallery {public:virtual ~MediaGallery()=default;};
std::unique_ptr<MediaGallery> pickGalleryVideo(juce::Component&,std::function<void(GallerySelection)>);
