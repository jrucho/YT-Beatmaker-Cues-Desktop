#include "WebEditor.h"
#import <Cocoa/Cocoa.h>
#include <iostream>

namespace {
NSView* webView(juce::Component& component){
    auto* view=(NSView*)juce::AccessibilityHandler::getNativeChildForComponent(component);
    if([view isKindOfClass:NSClassFromString(@"WKWebView")])return view;
    for(auto* child:component.getChildren())if(auto* found=webView(*child))return found;
    return nil;
}
void sendPointer(NSView* web,double x,double y,bool down){
    auto* window=[web window];const auto bounds=[web bounds];
    const NSPoint local=NSMakePoint(bounds.origin.x+x,[web isFlipped]?bounds.origin.y+y:bounds.origin.y+bounds.size.height-y);
    auto* event=[NSEvent mouseEventWithType:down?NSEventTypeLeftMouseDown:NSEventTypeLeftMouseUp location:[web convertPoint:local toView:nil]
        modifierFlags:0 timestamp:[[NSProcessInfo processInfo] systemUptime] windowNumber:[window windowNumber] context:nil eventNumber:1 clickCount:1 pressure:down?1:0];
    [NSApp sendEvent:event];
}
}

void showNativeWebIntegration(MobileWebEditor& editor){
    auto* web=webView(editor);if(!web)return;[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];if(![NSApp isRunning])[NSApp finishLaunching];[[web window] makeKeyAndOrderFront:nil];[NSApp activateIgnoringOtherApps:YES];[[web window] display];
}
void pumpNativeWebIntegration(){while(auto* event=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate distantPast] inMode:NSDefaultRunLoopMode dequeue:YES])[NSApp sendEvent:event];[NSApp updateWindows];}

bool checkNativePadInputRouting(CueProcessor& processor,MobileWebEditor& editor){
    editor.setSize(760,760);
    bool passed=true;juce::AudioBuffer<float> output(2,128);juce::MidiBuffer midi;
    const auto check=[&](bool condition,const char* message){if(!condition){passed=false;std::cerr<<"FAIL: "<<message<<"\n";}};
    const auto pump=[&](int milliseconds){const auto end=juce::Time::getMillisecondCounterHiRes()+milliseconds;while(juce::Time::getMillisecondCounterHiRes()<end){CFRunLoopRunInMode(kCFRunLoopDefaultMode,.005,true);while(auto* event=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate distantPast] inMode:NSDefaultRunLoopMode dequeue:YES])[NSApp sendEvent:event];[NSApp updateWindows];processor.processBlock(output,midi);}};
    const auto evaluate=[&](const juce::String& script){juce::var result;bool done=false;editor.evaluate(script,[&](auto value){if(value.getResult())result=*value.getResult();done=true;});for(int i=0;i<100&&!done;++i)pump(20);return result;};
    const auto diagnostics=[&]{evaluate("window.__padDiagnostics=null;window.__pluginInvoke('padTouchDiagnostics').then(value=>window.__padDiagnostics=value);true");for(int i=0;i<100;++i){pump(10);const auto value=evaluate("JSON.stringify(window.__padDiagnostics)").toString();if(value!="null"&&!value.isEmpty())return juce::JSON::parse(value);}return juce::var{};};
    auto* web=webView(editor);if(!web){check(false,"Native pad fixture did not find its own WKWebView");return false;}
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];if(![NSApp isRunning])[NSApp finishLaunching];[[web window] setFrameOrigin:NSMakePoint(30,30)];[[web window] makeKeyAndOrderFront:nil];[NSApp activateIgnoringOtherApps:YES];[[web window] display];pump(150);
    evaluate("window.__pluginStores.cues.getState().setBank('A');window.__pluginStores.cues.getState().setCue(1,.125);window.__pointerEvents=[];document.addEventListener('pointerdown',event=>window.__pointerEvents.push({epoch:performance.timeOrigin+event.timeStamp,pad:event.target.closest('.cue-pad')?.getAttribute('aria-label')}),true);true");pump(250);
    const auto point=juce::JSON::parse(evaluate("JSON.stringify((()=>{const r=document.querySelector('.cue-pad').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})())").toString());
    const double x=point["x"],y=point["y"];
    check((bool)diagnostics()["supported"],"Native mouse observer is unavailable");
    check((int)diagnostics()["mappedPads"]>0,"Visible native pointer fixture did not publish a prepared map");
    const auto before=processor.padStates[0].load()>>1;const int accepted=processor.nativePadInputAccepted.load(),claimed=diagnostics()["claimed"];
    sendPointer(web,x,y,true);
    check(processor.nativePadInputAccepted.load()==accepted+1,"Cocoa mouse-down did not queue before JavaScript delivery");
    processor.processBlock(output,midi);
    check((processor.padStates[0].load()>>1)==before+1,"Cocoa input did not reach the audio consumer");
    sendPointer(web,x,y,false);pump(250);
    const auto after=diagnostics();
    check((processor.padStates[0].load()>>1)==before+1&&(int)after["claimed"]==claimed+1,"Normal WebKit pointer delivery duplicated or failed to claim its native hit");
    const auto stallBefore=processor.padStates[0].load()>>1;const int stallAccepted=processor.nativePadInputAccepted.load(),stallClaimed=after["claimed"];
    evaluate("setTimeout(()=>{window.__stallStart=Date.now();const until=performance.now()+450;while(performance.now()<until){}window.__stallEnd=Date.now();},25);true");pump(80);
    const double pressed=juce::Time::currentTimeMillis();sendPointer(web,x,y,true);processor.processBlock(output,midi);
    check(processor.nativePadInputAccepted.load()==stallAccepted+1&&(processor.padStates[0].load()>>1)==stallBefore+1,"Stalled renderer delayed native cue execution");
    sendPointer(web,x,y,false);pump(600);
    const auto stall=juce::JSON::parse(evaluate("JSON.stringify({start:window.__stallStart,end:window.__stallEnd})").toString());
    check(pressed>=(double)stall["start"]&&pressed<(double)stall["end"],"Renderer-stall press did not occur within the actual JS stall");
    const auto reconciled=diagnostics();
    check((processor.padStates[0].load()>>1)==stallBefore+1&&(int)reconciled["claimed"]==stallClaimed+1,"Delayed WebKit input duplicated or failed to claim the native event");
    // Both views deliberately share one native peer. A root-window search would
    // choose the first WKWebView for both routers and fire both processors.
    CueProcessor other;other.prepareToPlay(48000,128);
    const auto fixture=juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a");
    processor.importPadSample(0,0,fixture);other.importPadSample(0,0,fixture);
    juce::Component container;juce::WebBrowserComponent left,right;
    container.addAndMakeVisible(left);container.addAndMakeVisible(right);container.setSize(440,300);left.setBounds(0,0,220,300);right.setBounds(220,0,220,300);
    NativePadInput leftInput(processor,left),rightInput(other,right);
    container.addToDesktop(juce::ComponentPeer::windowIsTemporary);container.setVisible(true);left.goToURL("about:blank");right.goToURL("about:blank");
    for(int i=0;i<100&&(!webView(left)||!webView(right));++i)pump(20);leftInput.poll();rightInput.poll();
    auto map=juce::JSON::parse(R"({"sourceId":0,"generation":-1,"trackRevision":-1,"layoutRevision":0,"bank":0,"width":220,"height":300,"dpr":1,"enabled":true,"pads":[{"pad":0,"sample":true,"to":0,"x":0.1,"y":0.1,"w":0.8,"h":0.8}]})");leftInput.configure(map);rightInput.configure(map);
    auto* leftWeb=webView(left);auto* rightWeb=webView(right);
    check(leftWeb&&rightWeb&&leftWeb!=rightWeb&&leftInput.supported()&&rightInput.supported(),"Sibling browser fixture is not ready");
    if(leftWeb&&rightWeb){
        [[leftWeb window] makeKeyAndOrderFront:nil];const int first=processor.nativePadInputAccepted.load(),second=other.nativePadInputAccepted.load();
        sendPointer(leftWeb,110,150,true);sendPointer(leftWeb,110,150,false);
        check(processor.nativePadInputAccepted.load()==first+1&&other.nativePadInputAccepted.load()==second,"Left browser triggered another plug-in instance");
        sendPointer(rightWeb,110,150,true);sendPointer(rightWeb,110,150,false);
        check(processor.nativePadInputAccepted.load()==first+1&&other.nativePadInputAccepted.load()==second+1,"Right browser was misrouted to a sibling instance");
    }
    processor.removePadSample(0,0);pump(100);
    if(passed)std::cout<<"PASS: real Cocoa/WKWebView queues cue before JS, reconciles exactly once through a 450 ms renderer stall, and isolates sibling plug-in browsers sharing one native window\n";
    return passed;
}
