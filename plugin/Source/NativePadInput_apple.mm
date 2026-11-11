#include "NativePadInput.h"
#include <unordered_set>
#import <WebKit/WebKit.h>
#if JUCE_IOS
 #import <UIKit/UIKit.h>
 #import <UIKit/UIGestureRecognizerSubclass.h>
#else
 #import <Cocoa/Cocoa.h>
#endif

namespace {
WKWebView* findWebView(juce::Component& browser){
    // Resolve only this browser's embedded view, never a sibling plug-in's
    // WKWebView elsewhere in the host window.
    id view=(id)juce::AccessibilityHandler::getNativeChildForComponent(browser);
    if([view isKindOfClass:[WKWebView class]])return (WKWebView*)view;
    for(auto* child:browser.getChildren())if(auto* found=findWebView(*child))return found;
    return nil;
}
}

#if JUCE_IOS
struct ApplePadTouchState {
    std::shared_ptr<PadInputRouter> router;
    juce::Component::SafePointer<juce::Component> browser;
    WKWebView* web=nil;
    std::unordered_set<UITouch*> active;
    bool enabled=true,pageScrollLocked=false;
    void began(UITouch* touch){
        if(!active.insert(touch).second)return;
        if(!enabled||!web||!browser||!browser->isShowing()||UIAccessibilityIsVoiceOverRunning())return;
        if(![[touch view] isDescendantOfView:web]||std::abs([[web scrollView] zoomScale]-1.0)>.01)return;
        if(pageScrollLocked){auto* scroll=[web scrollView];const auto offset=scroll.contentOffset;const auto insets=scroll.adjustedContentInset;
            if(std::abs(offset.x+insets.left)>2.5||std::abs(offset.y+insets.top)>2.5)return;}
        const auto point=[touch locationInView:web];const auto bounds=[web bounds];
        const double age=juce::jmax(0.0,([[NSProcessInfo processInfo] systemUptime]-[touch timestamp])*1000);
        router->pointerDown(point.x-bounds.origin.x,point.y-bounds.origin.y,bounds.size.width,bounds.size.height,false,juce::Time::currentTimeMillis()-age,age,(uint64_t)(uintptr_t)touch);
    }
};
@interface BeatmakerPadTouchObserver : UIGestureRecognizer <UIGestureRecognizerDelegate> {
@public std::weak_ptr<ApplePadTouchState> routing;
}
@end
@implementation BeatmakerPadTouchObserver
-(instancetype)init {
    if((self=[super initWithTarget:nil action:nil])){
        self.cancelsTouchesInView=NO;self.delaysTouchesBegan=NO;self.delaysTouchesEnded=NO;
        self.requiresExclusiveTouchType=NO;self.delegate=self;
    }return self;
}
-(BOOL)canPreventGestureRecognizer:(UIGestureRecognizer*)other {(void)other;return NO;}
-(BOOL)canBePreventedByGestureRecognizer:(UIGestureRecognizer*)other {(void)other;return NO;}
-(BOOL)gestureRecognizer:(UIGestureRecognizer*)first shouldRecognizeSimultaneouslyWithGestureRecognizer:(UIGestureRecognizer*)second {(void)first;(void)second;return YES;}
-(void)touchesBegan:(NSSet<UITouch*>*)touches withEvent:(UIEvent*)event {
    (void)event;if(auto state=routing.lock())for(UITouch* touch in touches)state->began(touch);
}
-(void)touchesMoved:(NSSet<UITouch*>*)touches withEvent:(UIEvent*)event {(void)touches;(void)event;}
-(void)touchesEnded:(NSSet<UITouch*>*)touches withEvent:(UIEvent*)event {
    (void)event;if(auto state=routing.lock()){for(UITouch* touch in touches){state->router->pointerUp((uint64_t)(uintptr_t)touch);state->active.erase(touch);}if(state->active.empty())self.state=UIGestureRecognizerStateFailed;}
}
-(void)touchesCancelled:(NSSet<UITouch*>*)touches withEvent:(UIEvent*)event {[self touchesEnded:touches withEvent:event];}
 -(void)reset {[super reset];if(auto state=routing.lock()){for(auto* touch:state->active)state->router->pointerUp((uint64_t)(uintptr_t)touch);state->active.clear();}}
@end

namespace {
class AppleNativePadInput final:public NativePadInputMonitor {
public:
    AppleNativePadInput(std::shared_ptr<PadInputRouter> router,juce::Component& browser):state(std::make_shared<ApplePadTouchState>()){
        state->router=std::move(router);state->browser=&browser;
        observer=[[BeatmakerPadTouchObserver alloc] init];observer->routing=state;poll();
    }
    ~AppleNativePadInput() override {state->enabled=false;detach();[observer release];}
    void poll() override {
        auto* found=state->browser?findWebView(*state->browser):nil;
        if(found==state->web){updateScrolling();return;}
        detach();state->web=[found retain];if(found){[found addGestureRecognizer:observer];updateScrolling();}
    }
    void setPageScrollLocked(bool value) override {wantScrollLock=value;state->pageScrollLocked=value;updateScrolling();}
    bool ready() const override {return state->web!=nil;}
private:
    void updateScrolling(){
        if(!state->web)return;
        auto* scroll=[state->web scrollView];
        if(wantScrollLock){
            if(!scrollLocked){savedBounce=scroll.bounces;savedVertical=scroll.alwaysBounceVertical;savedHorizontal=scroll.alwaysBounceHorizontal;}
            if(scroll.bounces)scroll.bounces=NO;if(scroll.alwaysBounceVertical)scroll.alwaysBounceVertical=NO;if(scroll.alwaysBounceHorizontal)scroll.alwaysBounceHorizontal=NO;
        }else if(scrollLocked){scroll.bounces=savedBounce;scroll.alwaysBounceVertical=savedVertical;scroll.alwaysBounceHorizontal=savedHorizontal;}
        scrollLocked=wantScrollLock;
    }
    void detach(){for(auto* touch:state->active)state->router->pointerUp((uint64_t)(uintptr_t)touch);state->active.clear();if(state->web){const bool desired=wantScrollLock;wantScrollLock=false;updateScrolling();wantScrollLock=desired;[state->web removeGestureRecognizer:observer];[state->web release];state->web=nil;}}
    bool wantScrollLock=false,scrollLocked=false;BOOL savedBounce=YES,savedVertical=NO,savedHorizontal=NO;
    std::shared_ptr<ApplePadTouchState> state;
    BeatmakerPadTouchObserver* observer=nil;
};
}
#else
namespace {
struct MacPadTouchState {
    std::shared_ptr<PadInputRouter> router;
    juce::Component::SafePointer<juce::Component> browser;
    bool enabled=true;
    void down(NSEvent* event){
        if(!enabled||!browser||!browser->isShowing()||([event modifierFlags]&(NSEventModifierFlagControl|NSEventModifierFlagCommand|NSEventModifierFlagOption)))return;
        auto* web=findWebView(*browser);
        if(!web||[event window]!=[web window])return;
        auto* content=[[event window] contentView];auto* parent=[content superview];
        const auto hitPoint=parent?[parent convertPoint:[event locationInWindow] fromView:nil]:[event locationInWindow];
        auto* hit=[content hitTest:hitPoint];
        if(hit!=web&&![hit isDescendantOf:web])return;
        const auto point=[web convertPoint:[event locationInWindow] fromView:nil];const auto bounds=[web bounds];
        const double x=point.x-bounds.origin.x,y=[web isFlipped]?point.y-bounds.origin.y:bounds.size.height-(point.y-bounds.origin.y);
        const double age=juce::jmax(0.0,([[NSProcessInfo processInfo] systemUptime]-[event timestamp])*1000);
        router->pointerDown(x,y,bounds.size.width,bounds.size.height,false,juce::Time::currentTimeMillis()-age,age);
    }
};
class AppleNativePadInput final:public NativePadInputMonitor {
public:
    AppleNativePadInput(std::shared_ptr<PadInputRouter> router,juce::Component& browser):state(std::make_shared<MacPadTouchState>()){
        state->router=std::move(router);state->browser=&browser;std::weak_ptr<MacPadTouchState> weak=state;
        monitor=[[NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown|NSEventMaskLeftMouseUp handler:^NSEvent*(NSEvent* event){if(auto current=weak.lock()){if(event.type==NSEventTypeLeftMouseUp)current->router->pointerUp(0);else current->down(event);}return event;}] retain];
        resign=[[NSNotificationCenter defaultCenter] addObserverForName:NSApplicationDidResignActiveNotification object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification*){if(auto current=weak.lock())current->router->cancelTouches();}];
    }
    ~AppleNativePadInput() override {state->enabled=false;state->router->cancelTouches();if(resign)[[NSNotificationCenter defaultCenter] removeObserver:resign];if(monitor){[NSEvent removeMonitor:monitor];[monitor release];}}
    bool ready() const override {return monitor&&state->browser&&findWebView(*state->browser);}
private:std::shared_ptr<MacPadTouchState> state;id monitor=nil,resign=nil;
};
}
#endif
std::unique_ptr<NativePadInputMonitor> createNativePadInputMonitor(std::shared_ptr<PadInputRouter> router,juce::Component& browser){return std::make_unique<AppleNativePadInput>(std::move(router),browser);}
