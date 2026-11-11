#include "MediaGallery.h"
#if JUCE_IOS
#import <PhotosUI/PhotosUI.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

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
        UIView* view=parent.getPeer()?(UIView*)parent.getPeer()->getNativeHandle():nil;UIResponder* responder=view;while(responder&&![responder isKindOfClass:UIViewController.class])responder=responder.nextResponder;
        UIViewController* controller=(UIViewController*)responder;if(!controller)controller=view.window.rootViewController;while(controller.presentedViewController)controller=controller.presentedViewController;
        if(controller){[controller presentViewController:picker animated:YES completion:nil];picker.presentationController.delegate=delegate;}
        else{const auto shared=state;juce::MessageManager::callAsync([shared]{shared->finish({{}, {}, "No gallery presentation window is available", {}});});}
    }
    ~IOSGallery() override {state->live.store(false);if(picker.presentingViewController)[picker dismissViewControllerAnimated:NO completion:nil];[picker release];[delegate release];}
private:
    std::shared_ptr<GalleryState> state;PHPickerViewController* picker=nil;BeatmakerGalleryDelegate* delegate=nil;
};
}
std::unique_ptr<MediaGallery> pickGalleryVideo(juce::Component& parent,std::function<void(GallerySelection)> complete){return std::make_unique<IOSGallery>(parent,std::move(complete));}
#endif
