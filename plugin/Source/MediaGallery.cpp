#include "MediaGallery.h"
#include <mutex>
#if !JUCE_IOS
namespace {
struct GalleryCallback {std::function<void(GallerySelection)> complete;};
#if JUCE_ANDROID
std::weak_ptr<GalleryCallback> pendingGallery;
std::mutex galleryMutex;
#endif
class GalleryPicker final:public MediaGallery {
public:
    GalleryPicker(juce::Component& parent,std::function<void(GallerySelection)> callback):state(std::make_shared<GalleryCallback>()){
        state->complete=std::move(callback);
       #if JUCE_ANDROID
        {std::lock_guard<std::mutex> lock(galleryMutex);pendingGallery=state;}extern bool openAndroidGallery();if(!openAndroidGallery())finish({{}, {}, "Phone gallery is unavailable", {}});
       #else
        chooser=std::make_unique<juce::FileChooser>("Choose a video",juce::File{},"*.mp4;*.mov;*.m4v;*.webm;*.mkv",true,false,&parent);
        std::weak_ptr<GalleryCallback> weak=state;chooser->launchAsync(juce::FileBrowserComponent::openMode|juce::FileBrowserComponent::canSelectFiles,[weak](const auto& picker){if(auto value=weak.lock()){const auto url=picker.getURLResult();value->complete({url,url.getFileName(),{}, {}});}});
       #endif
    }
private:
    void finish(GallerySelection value){const auto shared=state;juce::MessageManager::callAsync([shared,value]{shared->complete(value);});}
    std::shared_ptr<GalleryCallback> state;std::unique_ptr<juce::FileChooser> chooser;
};
}
std::unique_ptr<MediaGallery> pickGalleryVideo(juce::Component& parent,std::function<void(GallerySelection)> complete){return std::make_unique<GalleryPicker>(parent,std::move(complete));}
#if JUCE_ANDROID
#include <jni.h>
#include <juce_core/native/juce_JNIHelpers_android.h>
extern bool androidOpenGallery();
namespace {bool openAndroidGallery(){return androidOpenGallery();}}
extern "C" JNIEXPORT void JNICALL Java_app_musike_android_StandaloneBridge_galleryResult(JNIEnv*,jclass,jstring uri,jstring name){std::weak_ptr<GalleryCallback> weak;{std::lock_guard<std::mutex> lock(galleryMutex);weak=pendingGallery;pendingGallery.reset();}const auto source=juce::juceString(uri),title=juce::juceString(name);juce::MessageManager::callAsync([weak,source,title]{if(auto state=weak.lock())state->complete({source.isEmpty()?juce::URL{}:juce::URL(source),title,{}, {}});});}
#endif
#endif
