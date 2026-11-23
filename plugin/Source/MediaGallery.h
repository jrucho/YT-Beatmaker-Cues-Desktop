#pragma once
#include <juce_gui_basics/juce_gui_basics.h>

struct GallerySelection {juce::URL source;juce::String name,error;juce::File temporaryDirectory;};
class MediaGallery {public:virtual ~MediaGallery()=default;};
std::unique_ptr<MediaGallery> pickGalleryVideo(juce::Component&,std::function<void(GallerySelection)>);
#if JUCE_IOS && BEATMAKER_IOS_PREVIEW
struct PlaylistCoverSelection {juce::String image;bool failed=false;};
std::unique_ptr<MediaGallery> pickGalleryImage(juce::Component&,std::function<void(PlaylistCoverSelection)>);
PlaylistCoverSelection playlistCoverFromFile(const juce::URL&);
#endif
