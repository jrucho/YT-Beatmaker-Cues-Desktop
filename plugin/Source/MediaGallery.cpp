#include "MediaGallery.h"
#include <mutex>
#if !JUCE_IOS
#if JUCE_ANDROID
extern bool androidOpenGallery();
extern bool androidOpenPlaylistImage(bool photos);
#endif
namespace {
struct GalleryCallback {std::function<void(GallerySelection)> complete;};
#if JUCE_ANDROID
std::weak_ptr<GalleryCallback> pendingGallery;
struct CoverCallback {std::function<void(PlaylistCoverSelection)> complete;};
std::weak_ptr<CoverCallback> pendingCover;
std::mutex galleryMutex;
#endif
class GalleryPicker final:public MediaGallery {
public:
    GalleryPicker(juce::Component& parent,std::function<void(GallerySelection)> callback):state(std::make_shared<GalleryCallback>()){
        state->complete=std::move(callback);
       #if JUCE_ANDROID
         {std::lock_guard<std::mutex> lock(galleryMutex);pendingGallery=state;}if(!androidOpenGallery())finish({{}, {}, "Phone gallery is unavailable", {}});
       #else
        chooser=std::make_unique<juce::FileChooser>("Choose a video",juce::File{},"*.mp4;*.mov;*.m4v;*.webm;*.mkv",true,false,&parent);
        std::weak_ptr<GalleryCallback> weak=state;chooser->launchAsync(juce::FileBrowserComponent::openMode|juce::FileBrowserComponent::canSelectFiles,[weak](const auto& picker){if(auto value=weak.lock()){const auto url=picker.getURLResult();value->complete({url,url.getFileName(),{}, {}});}});
       #endif
    }
private:
    void finish(GallerySelection value){const auto shared=state;juce::MessageManager::callAsync([shared,value]{shared->complete(value);});}
    std::shared_ptr<GalleryCallback> state;std::unique_ptr<juce::FileChooser> chooser;
};
#if JUCE_ANDROID
class AndroidCoverPicker final:public MediaGallery {
public:
    AndroidCoverPicker(bool photos,std::function<void(PlaylistCoverSelection)> complete):state(std::make_shared<CoverCallback>()){
        state->complete=std::move(complete);
        {std::lock_guard<std::mutex> lock(galleryMutex);pendingCover=state;}
        if(!androidOpenPlaylistImage(photos)){
            std::weak_ptr<CoverCallback> weak=state;
            juce::MessageManager::callAsync([weak]{if(auto value=weak.lock())value->complete({{},true});});
        }
    }
private:
    std::shared_ptr<CoverCallback> state;
};
#endif
}
std::unique_ptr<MediaGallery> pickGalleryVideo(juce::Component& parent,std::function<void(GallerySelection)> complete){return std::make_unique<GalleryPicker>(parent,std::move(complete));}
#if JUCE_ANDROID
#include <jni.h>
#include <juce_core/native/juce_JNIHelpers_android.h>
extern "C" JNIEXPORT void JNICALL Java_app_musike_android_StandaloneBridge_galleryResult(JNIEnv*,jclass,jstring uri,jstring name){std::weak_ptr<GalleryCallback> weak;{std::lock_guard<std::mutex> lock(galleryMutex);weak=pendingGallery;pendingGallery.reset();}const auto source=juce::juceString(uri),title=juce::juceString(name);juce::MessageManager::callAsync([weak,source,title]{if(auto state=weak.lock())state->complete({source.isEmpty()?juce::URL{}:juce::URL(source),title,{}, {}});});}
std::unique_ptr<MediaGallery> pickAndroidPlaylistImage(bool photos,std::function<void(PlaylistCoverSelection)> complete){
    return std::make_unique<AndroidCoverPicker>(photos,std::move(complete));
}
extern "C" JNIEXPORT void JNICALL Java_app_musike_android_StandaloneBridge_playlistImageResult(JNIEnv*,jclass,jstring image,jboolean failed){
    std::weak_ptr<CoverCallback> weak;
    {std::lock_guard<std::mutex> lock(galleryMutex);weak=pendingCover;pendingCover.reset();}
    const auto data=juce::juceString(image);
    juce::MessageManager::callAsync([weak,data,failed]{
        if(auto state=weak.lock())state->complete({data,failed!=0});
    });
}
#else
PlaylistCoverSelection playlistCoverFromFile(const juce::URL& file){
    auto input=file.createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress));
    if(!input||input->getTotalLength()>16*1024*1024)return {{},true};
    auto image=juce::ImageFileFormat::loadFrom(*input);
    if(!image.isValid())return {{},true};
    const int extent=juce::jmax(image.getWidth(),image.getHeight());
    if(extent>640){
        image=image.rescaled(juce::jmax(1,image.getWidth()*640/extent),juce::jmax(1,image.getHeight()*640/extent));
    }
    juce::JPEGImageFormat jpeg;
    for(const auto quality:{0.82f,0.66f,0.48f,0.30f,0.15f}){
        juce::MemoryOutputStream output;
        jpeg.setQuality(quality);
        if(jpeg.writeImageToStream(image,output)&&output.getDataSize()<=128*1024)
            return {"data:image/jpeg;base64,"+juce::Base64::toBase64(output.getData(),output.getDataSize()),false};
    }
    return {{},true};
}
#endif
#endif
