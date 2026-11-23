#pragma once
#include <juce_gui_basics/juce_gui_basics.h>

struct GallerySelection {juce::URL source;juce::String name,error;juce::File temporaryDirectory;};
class MediaGallery {public:virtual ~MediaGallery()=default;};
std::unique_ptr<MediaGallery> pickGalleryVideo(juce::Component&,std::function<void(GallerySelection)>);
struct PlaylistCoverSelection {juce::String image;bool failed=false;};
#if JUCE_ANDROID
std::unique_ptr<MediaGallery> pickAndroidPlaylistImage(bool fromPhotos,std::function<void(PlaylistCoverSelection)>);
#else
PlaylistCoverSelection playlistCoverFromFile(const juce::URL&);
#if JUCE_IOS
std::unique_ptr<MediaGallery> pickGalleryImage(juce::Component&,std::function<void(PlaylistCoverSelection)>);
#endif
#endif
