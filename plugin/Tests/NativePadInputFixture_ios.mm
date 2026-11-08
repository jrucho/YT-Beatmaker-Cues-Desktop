// Simulator-only integration of the real UIKit observer, WKWebView and engine.
// Injected UITouch objects are not a measurement of hardware touch latency.
#include "WebEditor.h"
#import <UIKit/UIKit.h>
#import <UIKit/UIGestureRecognizerSubclass.h>
#import <WebKit/WebKit.h>
#include <iostream>

@interface BeatmakerFixtureTouch : UITouch {
@public UIView* target;CGPoint point;NSTimeInterval time;
}
@end
@implementation BeatmakerFixtureTouch
-(UIView*)view{return target;}
-(NSTimeInterval)timestamp{return time;}
-(CGPoint)locationInView:(UIView*)view{return [target convertPoint:point toView:view];}
@end

namespace {
WKWebView* webView(juce::Component& component){
    id view=(id)juce::AccessibilityHandler::getNativeChildForComponent(component);
    if([view isKindOfClass:[WKWebView class]])return (WKWebView*)view;
    for(auto* child:component.getChildren())if(auto* found=webView(*child))return found;
    return nil;
}
class InputFixture final:public juce::JUCEApplication,private juce::Timer {
public:
    const juce::String getApplicationName() override{return "Beatmaker Input Tests";}
    const juce::String getApplicationVersion() override{return "1.0.6";}
    void initialise(const juce::String&) override {
        const auto root=juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("NativeInputFixture");root.createDirectory();
        setenv("BEATMAKER_PLUGIN_DATA_DIR",root.getFullPathName().toRawUTF8(),1);setenv("BEATMAKER_AUDIO_CACHE_DIR",root.getChildFile("AudioCache").getFullPathName().toRawUTF8(),1);setenv("BEATMAKER_SHARED_LIBRARY_DIR","",1);
        processor=std::make_unique<CueProcessor>();processor->prepareToPlay(48000,128);
        editor=std::make_unique<MobileWebEditor>(*processor,true);
        window=std::make_unique<juce::DocumentWindow>(getApplicationName(),juce::Colours::black,0);
        window->setContentNonOwned(editor.get(),false);window->setUsingNativeTitleBar(true);window->setFullScreen(true);window->setVisible(true);
        startTimer(1500);
    }
    void shutdown() override {window.reset();editor.reset();processor.reset();}
private:
    std::unique_ptr<CueProcessor> processor;std::unique_ptr<MobileWebEditor> editor;std::unique_ptr<juce::DocumentWindow> window;
    juce::AudioBuffer<float> output{2,128};juce::MidiBuffer midi;bool passed=true;
    void pump(int milliseconds){const auto end=juce::Time::getMillisecondCounterHiRes()+milliseconds;while(juce::Time::getMillisecondCounterHiRes()<end){CFRunLoopRunInMode(kCFRunLoopDefaultMode,.005,true);processor->processBlock(output,midi);}}
    juce::var evaluate(const juce::String& script){juce::var result;bool done=false;editor->evaluate(script,[&](auto value){if(value.getResult())result=*value.getResult();done=true;});for(int i=0;i<100&&!done;++i)pump(20);return result;}
    juce::var diagnostics(){evaluate("window.__padDiagnostics=null;window.__pluginInvoke('padTouchDiagnostics').then(value=>window.__padDiagnostics=value);true");for(int i=0;i<100;++i){pump(10);const auto value=evaluate("JSON.stringify(window.__padDiagnostics)").toString();if(value!="null"&&!value.isEmpty())return juce::JSON::parse(value);}return {};}
    void check(bool value,const char* message){if(!value){passed=false;std::cerr<<"FAIL: "<<message<<"\n";}}
    void pointer(UIGestureRecognizer* observer,WKWebView* web,const juce::var& point,int pad){
        auto* touch=[BeatmakerFixtureTouch new];touch->target=web;touch->point=CGPointMake((double)point["x"],(double)point["y"]);touch->time=[[NSProcessInfo processInfo] systemUptime];
        const double epoch=juce::Time::currentTimeMillis();const auto before=processor->padStates[(size_t)pad-1].load()>>1;const int accepted=processor->nativePadInputAccepted.load();
        [observer touchesBegan:[NSSet setWithObject:touch] withEvent:nil];processor->processBlock(output,midi);
        check(processor->nativePadInputAccepted.load()==accepted+1&&(processor->padStates[(size_t)pad-1].load()>>1)==before+1,"UIKit touch did not queue/render before JavaScript");
        evaluate("(()=>{const button=document.querySelectorAll('.cue-pad')["+juce::String(pad-1)+"];for(const type of ['pointerdown','pointerup']){const event=new PointerEvent(type,{pointerId:1,pointerType:'touch',button:0,bubbles:true});Object.defineProperty(event,'timeStamp',{value:"+juce::String(epoch,3)+"-performance.timeOrigin});button.dispatchEvent(event);}return true;})()");pump(150);
        [observer touchesEnded:[NSSet setWithObject:touch] withEvent:nil];[touch release];
        check((processor->padStates[(size_t)pad-1].load()>>1)==before+1,"UIKit/WebKit reconciliation duplicated the native hit");
    }
    void timerCallback() override {
        stopTimer();
        for(int i=0;i<100&&!(bool)evaluate("Boolean(window.__pluginStores&&document.querySelector('a[href=\"/cues\"]'))");++i)pump(50);
        const auto file=juce::File(juce::String::fromUTF8([[[NSBundle mainBundle] pathForResource:@"tone" ofType:@"m4a"] UTF8String]));const auto track=processor->importLocalFile(file);
        evaluate("window.__pluginStores.player.setState({repeat:'one'});window.__pluginStores.player.getState().playList(["+juce::JSON::toString(track)+"]);document.querySelector('a[href=\"/cues\"]')?.click();true");
        for(int i=0;i<100&&!(bool)evaluate("Boolean(window.__musikeAudioEl?.readyState>0&&document.querySelector('.cue-pad'))");++i)pump(50);
        evaluate("window.__pluginStores.cues.getState().setCue(1,.125);true");pump(250);
        auto* web=webView(*editor);UIGestureRecognizer* observer=nil;
        for(UIGestureRecognizer* candidate in [web gestureRecognizers])if([candidate isKindOfClass:NSClassFromString(@"BeatmakerPadTouchObserver")])observer=candidate;
        check(web&&observer,"UIKit observer is not attached to the correct WKWebView");
        const auto state=diagnostics();check((bool)state["supported"]&&(int)state["mappedPads"]==1,"UIKit native map is not ready");
        if(observer){
            check(!observer.cancelsTouchesInView&&!observer.delaysTouchesBegan&&!observer.delaysTouchesEnded,"UIKit observer delays/consumes ordinary WebKit touches");
            const auto point=juce::JSON::parse(evaluate("JSON.stringify((()=>{const r=document.querySelector('.cue-pad').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})())").toString());
            pointer(observer,web,point,1);
            check((int)diagnostics()["claimed"]==1,"UIKit event epoch did not match the WebKit receipt");
            processor->importPadSample(0,0,file);evaluate("window.__musikeAudioEl.removeAttribute('src');true");pump(300);
            pointer(observer,web,point,1);check((int)diagnostics()["claimed"]==2,"Sample-only UIKit input did not claim its native receipt");
            evaluate("document.querySelector('button[aria-label=\"Settings\"]')?.click();true");pump(150);
            check((int)diagnostics()["mappedPads"]==0,"Modal dialog did not clear the UIKit input regions");
        }
        std::cout<<(passed?"PASS":"FAIL")<<": iOS simulator UIKit observer/WKWebView/native audio, one-time cue/sample receipts, non-cancelling gesture and modal exclusion (injected touch, hardware latency not measured)\n"<<std::flush;
        std::exit(passed?0:1);
    }
};
}
START_JUCE_APPLICATION(InputFixture)
