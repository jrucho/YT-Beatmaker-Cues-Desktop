#include "MediaGallery.h"
#if JUCE_IOS
#import <PhotosUI/PhotosUI.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <ImageIO/ImageIO.h>

namespace {
UIViewController* galleryPresenter(juce::Component& parent){
    UIView* view=parent.getPeer()?(UIView*)parent.getPeer()->getNativeHandle():nil;
    UIResponder* responder=view;
    while(responder&&![responder isKindOfClass:UIViewController.class])responder=responder.nextResponder;
    UIViewController* controller=(UIViewController*)responder;
    if(!controller)controller=view.window.rootViewController;
    while(controller.presentedViewController)controller=controller.presentedViewController;
    return controller;
}
}

struct GalleryState {
    std::function<void(GallerySelection)> complete;std::atomic<bool> live{true},finished{false};
    void finish(GallerySelection result){if(!live.load()||finished.exchange(true)){if(result.temporaryDirectory!=juce::File{})result.temporaryDirectory.deleteRecursively();return;}complete(std::move(result));}
};
@interface BeatmakerGalleryDelegate:NSObject<PHPickerViewControllerDelegate,UIAdaptivePresentationControllerDelegate> {
@public std::shared_ptr<GalleryState> state;
}
@end
@implementation BeatmakerGalleryDelegate
-(void)presentationControllerDidDismiss:(UIPresentationController*)controller {(void)controller;state->finish({});}
-(void)picker:(PHPickerViewController*)picker didFinishPicking:(NSArray<PHPickerResult*>*)results {
    [picker dismissViewControllerAnimated:YES completion:nil];
    if(results.count==0){state->finish({});return;}
    NSItemProvider* provider=results.firstObject.itemProvider;const auto shared=state;
    if(![provider hasItemConformingToTypeIdentifier:UTTypeMovie.identifier]){shared->finish({{}, {}, "Choose a video containing audio", {}});return;}
    const juce::String name(provider.suggestedName.UTF8String);
    [provider loadFileRepresentationForTypeIdentifier:UTTypeMovie.identifier completionHandler:^(NSURL* url,NSError* error){
        GallerySelection result;
        if(url&&!error){const auto original=juce::File(juce::String(url.path.UTF8String));result.temporaryDirectory=juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("Beatmaker-Gallery-"+juce::Uuid().toString());const auto copy=result.temporaryDirectory.getChildFile(original.getFileName());
            if(!result.temporaryDirectory.createDirectory()||!original.copyFileTo(copy))result.error="Cannot retain the selected gallery video";else{result.source=juce::URL(copy);result.name=name.isNotEmpty()?name:original.getFileName();}
        }else result.error=juce::String(error.localizedDescription.UTF8String?:"Could not load the selected gallery video");
        juce::MessageManager::callAsync([shared,result]{shared->finish(result);});
    }];
}
@end

namespace {
class IOSGallery final:public MediaGallery {
public:
    IOSGallery(juce::Component& parent,std::function<void(GallerySelection)> complete):state(std::make_shared<GalleryState>()){
        state->complete=std::move(complete);delegate=[[BeatmakerGalleryDelegate alloc] init];delegate->state=state;
        PHPickerConfiguration* configuration=[[[PHPickerConfiguration alloc] init] autorelease];configuration.filter=PHPickerFilter.videosFilter;configuration.selectionLimit=1;
        picker=[[PHPickerViewController alloc] initWithConfiguration:configuration];picker.delegate=delegate;
        if(auto* controller=galleryPresenter(parent)){[controller presentViewController:picker animated:YES completion:nil];picker.presentationController.delegate=delegate;}
        else{const auto shared=state;juce::MessageManager::callAsync([shared]{shared->finish({{}, {}, "No gallery presentation window is available", {}});});}
    }
    ~IOSGallery() override {state->live.store(false);if(picker.presentingViewController)[picker dismissViewControllerAnimated:NO completion:nil];[picker release];[delegate release];}
private:
    std::shared_ptr<GalleryState> state;PHPickerViewController* picker=nil;BeatmakerGalleryDelegate* delegate=nil;
};
}
std::unique_ptr<MediaGallery> pickGalleryVideo(juce::Component& parent,std::function<void(GallerySelection)> complete){return std::make_unique<IOSGallery>(parent,std::move(complete));}

namespace {
constexpr int coverMaxFileBytes=64*1024*1024;
constexpr int coverMaxJPEGBytes=128*1024;

PlaylistCoverSelection playlistCover(CGImageSourceRef source){
    if(!source)return {{},true};
    // Decode a bounded, correctly oriented thumbnail instead of the full photo.
    NSDictionary* options=@{(NSString*)kCGImageSourceCreateThumbnailFromImageAlways:@YES,
        (NSString*)kCGImageSourceCreateThumbnailWithTransform:@YES,
        (NSString*)kCGImageSourceThumbnailMaxPixelSize:@640};
    auto image=CGImageSourceCreateThumbnailAtIndex(source,0,(CFDictionaryRef)options);
    CFRelease(source);
    if(!image)return {{},true};
    PlaylistCoverSelection result{{},true};
    for(NSNumber* quality in @[@0.82,@0.66,@0.48,@0.30,@0.15]){
        auto data=CFDataCreateMutable(kCFAllocatorDefault,0);
        auto encoder=CGImageDestinationCreateWithData(data,(CFStringRef)UTTypeJPEG.identifier,1,nullptr);
        if(encoder){
            // Store only pixels. No original photo metadata, location, or URL goes to the WebView.
            CGImageDestinationAddImage(encoder,image,(CFDictionaryRef)@{(NSString*)kCGImageDestinationLossyCompressionQuality:quality});
            if(CGImageDestinationFinalize(encoder)&&CFDataGetLength(data)<=coverMaxJPEGBytes){
                result={"data:image/jpeg;base64,"+juce::Base64::toBase64(CFDataGetBytePtr(data),(size_t)CFDataGetLength(data)),false};
            }
            CFRelease(encoder);
        }
        CFRelease(data);
        if(!result.failed)break;
    }
    CGImageRelease(image);
    return result;
}

struct CoverPickerState {
    std::function<void(PlaylistCoverSelection)> complete;
    std::atomic<bool> live{true},finished{false};
    void finish(PlaylistCoverSelection value){
        if(live.load()&&!finished.exchange(true))complete(std::move(value));
    }
};
}

PlaylistCoverSelection playlistCoverFromFile(const juce::URL& file){
    @autoreleasepool {
        // JUCE keeps the document picker's Files bookmark alive for the stream.
        auto stream=file.createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress));
        if(!stream||stream->getTotalLength()>coverMaxFileBytes)return {{},true};
        juce::MemoryBlock bytes;
        stream->readIntoMemoryBlock(bytes,coverMaxFileBytes+1);
        if(bytes.isEmpty()||bytes.getSize()>coverMaxFileBytes)return {{},true};
        auto data=CFDataCreateWithBytesNoCopy(kCFAllocatorDefault,(const UInt8*)bytes.getData(),(CFIndex)bytes.getSize(),kCFAllocatorNull);
        if(!data)return {{},true};
        auto result=playlistCover(CGImageSourceCreateWithData(data,nullptr));
        CFRelease(data);
        return result;
    }
}

@interface BeatmakerCoverDelegate:NSObject<PHPickerViewControllerDelegate,UIAdaptivePresentationControllerDelegate> {
@public std::shared_ptr<CoverPickerState> state;
}
@end
@implementation BeatmakerCoverDelegate
-(void)presentationControllerDidDismiss:(UIPresentationController*)controller {(void)controller;state->finish({});}
-(void)picker:(PHPickerViewController*)picker didFinishPicking:(NSArray<PHPickerResult*>*)results {
    const auto shared=state;
    NSItemProvider* provider=results.firstObject.itemProvider;
    [picker dismissViewControllerAnimated:YES completion:^{
        if(!provider){shared->finish({});return;}
        NSString* imageType=nil;
        for(NSString* identifier in provider.registeredTypeIdentifiers){
            if([[UTType typeWithIdentifier:identifier] conformsToType:UTTypeImage]){imageType=identifier;break;}
        }
        if(!imageType){shared->finish({{},true});return;}
        [provider loadFileRepresentationForTypeIdentifier:imageType completionHandler:^(NSURL* url,NSError* error){
            // The provider's temporary URL is valid only within this callback.
            const auto photo=url?juce::File(juce::String::fromUTF8(url.path.UTF8String)):juce::File{};
            const auto result=(error||!photo.existsAsFile()||photo.getSize()>coverMaxFileBytes)
                ?PlaylistCoverSelection{{},true}:playlistCover(CGImageSourceCreateWithURL((CFURLRef)url,nullptr));
            juce::MessageManager::callAsync([shared,result]{shared->finish(result);});
        }];
    }];
}
@end

namespace {
class IOSCoverGallery final:public MediaGallery {
public:
    IOSCoverGallery(juce::Component& parent,std::function<void(PlaylistCoverSelection)> complete):state(std::make_shared<CoverPickerState>()){
        state->complete=std::move(complete);
        delegate=[[BeatmakerCoverDelegate alloc] init];
        delegate->state=state;
        PHPickerConfiguration* configuration=[[[PHPickerConfiguration alloc] init] autorelease];
        configuration.filter=PHPickerFilter.imagesFilter;
        configuration.preferredAssetRepresentationMode=PHPickerConfigurationAssetRepresentationModeCurrent;
        configuration.selectionLimit=1;
        picker=[[PHPickerViewController alloc] initWithConfiguration:configuration];
        picker.delegate=delegate;
        if(auto* controller=galleryPresenter(parent)){[controller presentViewController:picker animated:YES completion:nil];picker.presentationController.delegate=delegate;}
        else{const auto shared=state;juce::MessageManager::callAsync([shared]{shared->finish({{},true});});}
    }
    ~IOSCoverGallery() override {state->live.store(false);if(picker.presentingViewController)[picker dismissViewControllerAnimated:NO completion:nil];[picker release];[delegate release];}
private:
    std::shared_ptr<CoverPickerState> state;
    PHPickerViewController* picker=nil;
    BeatmakerCoverDelegate* delegate=nil;
};
}

std::unique_ptr<MediaGallery> pickGalleryImage(juce::Component& parent,std::function<void(PlaylistCoverSelection)> complete){
    return std::make_unique<IOSCoverGallery>(parent,std::move(complete));
}
#endif
