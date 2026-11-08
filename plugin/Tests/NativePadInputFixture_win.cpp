#ifndef _WIN32_WINNT
 #define _WIN32_WINNT 0x0a00
#endif
#include "WebEditor.h"
#include <windows.h>
#include <iostream>

namespace {
HWND browserWindow(juce::Component& component){
    if(auto* native=juce::AccessibilityHandler::getNativeChildForComponent(component))return (HWND)native;
    for(auto* child:component.getChildren())if(auto native=browserWindow(*child))return native;
    return nullptr;
}
bool click(HWND browser,double x,double y,double cssWidth,double cssHeight){
    const auto previous=SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    RECT bounds{};GetClientRect(browser,&bounds);POINT point{(LONG)(x*(bounds.right-bounds.left)/cssWidth),(LONG)(y*(bounds.bottom-bounds.top)/cssHeight)};ClientToScreen(browser,&point);
    SetCursorPos(point.x,point.y);INPUT events[2]{};events[0].type=events[1].type=INPUT_MOUSE;events[0].mi.dwFlags=MOUSEEVENTF_LEFTDOWN;events[1].mi.dwFlags=MOUSEEVENTF_LEFTUP;
    const bool sent=SendInput(2,events,sizeof(INPUT))==2;if(previous)SetThreadDpiAwarenessContext(previous);return sent;
}
}
bool checkNativePadInputRouting(CueProcessor& processor,MobileWebEditor& editor){
    editor.setSize(760,760);auto native=browserWindow(editor);if(!native){std::cerr<<"FAIL: Native pointer fixture could not find its WebView2\n";return false;}
    auto top=GetAncestor(native,GA_ROOT);ShowWindow(top,SW_SHOW);SetForegroundWindow(top);
    juce::AudioBuffer<float> output(2,128);juce::MidiBuffer midi;bool passed=true;
    const auto check=[&](bool condition,const char* message){if(!condition){passed=false;std::cerr<<"FAIL: "<<message<<"\n";}};
    const auto pump=[&](int milliseconds){const auto end=juce::Time::getMillisecondCounterHiRes()+milliseconds;while(juce::Time::getMillisecondCounterHiRes()<end){juce::MessageManager::getInstance()->runDispatchLoopUntil(1);processor.processBlock(output,midi);}};
    const auto evaluate=[&](const juce::String& script){juce::var result;bool done=false;editor.evaluate(script,[&](auto value){if(value.getResult())result=*value.getResult();done=true;});for(int i=0;i<100&&!done;++i)pump(20);return result;};
    const auto diagnostics=[&]{evaluate("window.__padDiagnostics=null;window.__pluginInvoke('padTouchDiagnostics').then(value=>window.__padDiagnostics=value);true");for(int i=0;i<100;++i){pump(10);const auto value=evaluate("JSON.stringify(window.__padDiagnostics)").toString();if(value!="null"&&!value.isEmpty())return juce::JSON::parse(value);}return juce::var{};};
    pump(200);evaluate("window.__pluginStores.cues.getState().setBank('A');window.__pluginStores.cues.getState().setCue(1,.125);true");pump(250);
    const auto point=juce::JSON::parse(evaluate("JSON.stringify((()=>{const r=document.querySelector('.cue-pad').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth,height:innerHeight};})())").toString());
    const auto state=diagnostics();check((bool)state["supported"]&&(int)state["mappedPads"]>0,"Native WebView2 observer/map is not ready");
    const auto before=processor.padStates[0].load()>>1;const int accepted=processor.nativePadInputAccepted.load(),claimed=state["claimed"];
    check(click(native,point["x"],point["y"],point["width"],point["height"]),"SendInput did not inject a Windows pointer event");pump(250);
    const auto after=diagnostics();
    check(processor.nativePadInputAccepted.load()==accepted+1&&(processor.padStates[0].load()>>1)==before+1&&(int)after["claimed"]==claimed+1,"Windows native mouse and WebView2 did not reconcile exactly one hit");
    const auto stallBefore=processor.padStates[0].load()>>1;const int stallAccepted=processor.nativePadInputAccepted.load(),stallClaimed=after["claimed"];
    evaluate("setTimeout(()=>{window.__stallStart=Date.now();const until=performance.now()+450;while(performance.now()<until){}window.__stallEnd=Date.now();},25);true");pump(80);
    const double pressed=juce::Time::currentTimeMillis();click(native,point["x"],point["y"],point["width"],point["height"]);pump(40);
    check(processor.nativePadInputAccepted.load()==stallAccepted+1&&(processor.padStates[0].load()>>1)==stallBefore+1,"Stalled WebView2 delayed native cue execution");pump(600);
    const auto stall=juce::JSON::parse(evaluate("JSON.stringify({start:window.__stallStart,end:window.__stallEnd})").toString());
    check(pressed>=(double)stall["start"]&&pressed<(double)stall["end"],"Windows pointer did not arrive within the renderer stall");const auto reconciled=diagnostics();
    check((processor.padStates[0].load()>>1)==stallBefore+1&&(int)reconciled["claimed"]==stallClaimed+1,"Delayed WebView2 pointer event duplicated or lost its native receipt");
    if(passed)std::cout<<"PASS: real Windows SendInput/WebView2 native pointer and one-hit reconciliation through a 450 ms renderer stall\n";
    return passed;
}
