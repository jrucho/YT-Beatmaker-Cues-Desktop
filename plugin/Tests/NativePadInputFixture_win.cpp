#ifndef _WIN32_WINNT
 #define _WIN32_WINNT 0x0a00
#endif
#include "WebEditor.h"
#include <windows.h>
#include <chrono>
#include <future>
#include <iostream>

namespace {
HWND browserWindow(juce::Component& component){
    if(auto* native=juce::AccessibilityHandler::getNativeChildForComponent(component))return (HWND)native;
    for(auto* child:component.getChildren())if(auto native=browserWindow(*child))return native;
    return nullptr;
}
struct InjectedClick{
    bool sent=false,inWebView=false;
    double pressed=0;
    juce::String targetClass;
};
InjectedClick click(HWND browser,double x,double y,double cssWidth,double cssHeight){
    const auto previous=SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    InjectedClick result;
    RECT bounds{};
    if(cssWidth>0&&cssHeight>0&&GetClientRect(browser,&bounds)){
        POINT point{(LONG)(x*(bounds.right-bounds.left)/cssWidth),(LONG)(y*(bounds.bottom-bounds.top)/cssHeight)};
        if(ClientToScreen(browser,&point)&&SetCursorPos(point.x,point.y)){
            const auto target=WindowFromPoint(point);
            result.inWebView=target!=nullptr&&(target==browser||IsChild(browser,target));
            wchar_t name[128]{};
            if(target)GetClassNameW(target,name,128);
            result.targetClass=juce::String(name);
            INPUT events[2]{};events[0].type=events[1].type=INPUT_MOUSE;
            events[0].mi.dwFlags=MOUSEEVENTF_LEFTDOWN;events[1].mi.dwFlags=MOUSEEVENTF_LEFTUP;
            result.pressed=juce::Time::currentTimeMillis();
            result.sent=SendInput(2,events,sizeof(INPUT))==2;
        }
    }
    if(previous)SetThreadDpiAwarenessContext(previous);
    return result;
}
}
bool checkNativePadInputRouting(CueProcessor& processor,MobileWebEditor& editor){
    editor.setSize(760,760);auto native=browserWindow(editor);if(!native){std::cerr<<"FAIL: Native pointer fixture could not find its WebView2\n";return false;}
    auto top=GetAncestor(native,GA_ROOT);ShowWindow(top,SW_SHOW);SetForegroundWindow(top);
    juce::AudioBuffer<float> output(2,128);juce::MidiBuffer midi;bool passed=true;
    const auto check=[&](bool condition,const char* message){if(!condition){passed=false;std::cerr<<"FAIL: "<<message<<"\n";}};
    const auto pump=[&](int milliseconds){const auto end=juce::Time::getMillisecondCounterHiRes()+milliseconds;while(juce::Time::getMillisecondCounterHiRes()<end){juce::MessageManager::getInstance()->runDispatchLoopUntil(1);processor.processBlock(output,midi);}};
    const auto clickPad=[&](const juce::var& point){
        // Windows delivers WH_MOUSE_LL to the thread that installed the hook.
        // Inject off that thread and continue to pump real UI/audio callbacks.
        auto injected=std::async(std::launch::async,click,native,
            (double)point["x"],(double)point["y"],(double)point["width"],(double)point["height"]);
        while(injected.wait_for(std::chrono::milliseconds(0))!=std::future_status::ready)pump(1);
        return injected.get();
    };
    const auto evaluate=[&](const juce::String& script){juce::var result;bool done=false;editor.evaluate(script,[&](auto value){if(value.getResult())result=*value.getResult();done=true;});for(int i=0;i<100&&!done;++i)pump(20);return result;};
    const auto diagnostics=[&]{evaluate("window.__padDiagnostics=null;window.__pluginInvoke('padTouchDiagnostics').then(value=>window.__padDiagnostics=value);true");for(int i=0;i<100;++i){pump(10);const auto value=evaluate("JSON.stringify(window.__padDiagnostics)").toString();if(value!="null"&&!value.isEmpty())return juce::JSON::parse(value);}return juce::var{};};
    pump(200);evaluate("window.__pluginStores.cues.getState().setBank('A');window.__pluginStores.cues.getState().setCue(1,.125);true");pump(250);
    juce::var point,state;
    const auto layoutReady=[&]{
        return (bool)point["hit"]&&(bool)state["supported"]&&(bool)state["mapEnabled"]&&(int)state["mappedPads"]>0
            &&(int)state["viewportWidth"]==(int)point["width"]&&(int)state["viewportHeight"]==(int)point["height"]
            &&(int)state["mapLayoutRevision"]==(int)state["layoutRevision"]
            &&(int)state["mapSourceId"]==(int)state["sourceId"]&&(int)state["mapGeneration"]==(int)state["audioGeneration"]
            &&(int)state["mapTrackRevision"]==(int)state["trackRevision"]&&(bool)state["ready"]&&!processor.nativeAdvancing.load();
    };
    const auto layoutDeadline=juce::Time::getMillisecondCounterHiRes()+2500;
    do {
        point=juce::JSON::parse(evaluate("JSON.stringify((()=>{const pad=document.querySelector('.cue-pad'),r=pad.getBoundingClientRect();"
            "const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,width:innerWidth,height:innerHeight,hit:pad.contains(document.elementFromPoint(x,y))};})())").toString());
        state=diagnostics();
        if(layoutReady())break;
        pump(40);
    }while(juce::Time::getMillisecondCounterHiRes()<layoutDeadline);
    if(!layoutReady()){
        std::cerr<<"FAIL: Native WebView2 pointer map did not match the latest layout: point="
            <<juce::JSON::toString(point,true)<<" native="<<juce::JSON::toString(state,true)<<"\n";
        return false;
    }
    const auto before=processor.padStates[0].load()>>1;const int accepted=processor.nativePadInputAccepted.load(),claimed=state["claimed"];
    const auto first=clickPad(point);
    check(first.sent,"SendInput did not inject a Windows pointer event");
    // Wait for the asynchronous WebView receipt, but demand exactly one native hit.
    const auto receiptDeadline=juce::Time::getMillisecondCounterHiRes()+2000;
    do {pump(25);}while(processor.nativePadInputAccepted.load()==accepted
        &&(processor.padStates[0].load()>>1)==before&&juce::Time::getMillisecondCounterHiRes()<receiptDeadline);
    while(juce::Time::getMillisecondCounterHiRes()<receiptDeadline){
        if((int)diagnostics()["claimed"]!=claimed)break;
        pump(40);
    }
    pump(150); // Give a delayed duplicate enough time to reach the engine.
    const auto after=diagnostics();
    if(processor.nativePadInputAccepted.load()!=accepted+1||(processor.padStates[0].load()>>1)!=before+1||(int)after["claimed"]!=claimed+1){
        std::cerr<<"FAIL: Windows native mouse and WebView2 did not reconcile exactly one hit: accepted delta="
            <<processor.nativePadInputAccepted.load()-accepted<<" rendered pad delta="<<(processor.padStates[0].load()>>1)-before
            <<" claimed delta="<<(int)after["claimed"]-claimed<<" HWND class="<<first.targetClass<<" inside WebView="<<first.inWebView
            <<" point="<<juce::JSON::toString(point,true)
            <<" state="<<juce::JSON::toString(after,true)<<"\n";
        return false;
    }
    const auto stallBefore=processor.padStates[0].load()>>1;const int stallAccepted=processor.nativePadInputAccepted.load(),stallClaimed=after["claimed"];
    evaluate("setTimeout(()=>{window.__stallStart=Date.now();const until=performance.now()+450;while(performance.now()<until){}window.__stallEnd=Date.now();},25);true");pump(80);
    const auto stalled=clickPad(point);pump(40);
    check(stalled.sent,"SendInput did not inject a Windows pointer event during the renderer stall");
    check(processor.nativePadInputAccepted.load()==stallAccepted+1&&(processor.padStates[0].load()>>1)==stallBefore+1,"Stalled WebView2 delayed native cue execution");pump(600);
    const auto stall=juce::JSON::parse(evaluate("JSON.stringify({start:window.__stallStart,end:window.__stallEnd})").toString());
    check(stalled.pressed>=(double)stall["start"]&&stalled.pressed<(double)stall["end"],"Windows pointer did not arrive within the renderer stall");const auto reconciled=diagnostics();
    check((processor.padStates[0].load()>>1)==stallBefore+1&&(int)reconciled["claimed"]==stallClaimed+1,"Delayed WebView2 pointer event duplicated or lost its native receipt");
    if(passed)std::cout<<"PASS: real Windows SendInput/WebView2 native pointer and one-hit reconciliation through a 450 ms renderer stall\n";
    return passed;
}
