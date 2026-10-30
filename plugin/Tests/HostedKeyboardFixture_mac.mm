#include "WebEditor.h"
#import <Cocoa/Cocoa.h>
#include <iostream>

@interface BeatmakerKeyboardHostFixture : NSView {
@public std::function<void(bool,unsigned short)>* callback;
}
@end
@implementation BeatmakerKeyboardHostFixture
-(BOOL)acceptsFirstResponder{return YES;}
-(void)keyDown:(NSEvent*)event{if(callback)(*callback)(true,[event keyCode]);}
-(void)keyUp:(NSEvent*)event{if(callback)(*callback)(false,[event keyCode]);}
@end

namespace {
NSView* findBrowser(NSView* view){
    if([view isKindOfClass:NSClassFromString(@"WKWebView")])return view;
    for(NSView* child in [view subviews])if(auto* found=findBrowser(child))return found;
    return nil;
}
}
bool checkHostedKeyboardRouting(){
    juce::AudioProcessor::setTypeOfNextNewPlugin(juce::AudioProcessor::wrapperType_VST3);
    CueProcessor processor;processor.prepareToPlay(48000,128);
    juce::AudioProcessor::setTypeOfNextNewPlugin(juce::AudioProcessor::wrapperType_Undefined);
    auto sample=std::make_unique<CueProcessor::Sample>();sample->path="demo:";sample->rate=48000;sample->audio.setSize(2,48000*4);
    for(int c=0;c<2;++c)for(int i=0;i<sample->audio.getNumSamples();++i)sample->audio.setSample(c,i,.25f);
    processor.installSampleForTest(std::move(sample));
    auto ownedEditor=std::make_unique<MobileWebEditor>(processor,true);auto& editor=*ownedEditor;
    auto* window=[[NSWindow alloc] initWithContentRect:NSMakeRect(20,20,editor.getWidth(),editor.getHeight()) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    auto* host=[[BeatmakerKeyboardHostFixture alloc] initWithFrame:NSMakeRect(0,0,editor.getWidth(),editor.getHeight())];
    [window setContentView:host];
    int downs=0,ups=0;juce::MidiBuffer midi;juce::AudioBuffer<float> output(2,128);
    std::function<void(bool,unsigned short)> callback=[&](bool down,unsigned short code){
        if(down)++downs;else ++ups;
        if(code==0)midi.addEvent(down?juce::MidiMessage::noteOn(1,48,(juce::uint8)127):juce::MidiMessage::noteOff(1,48),31);
    };
    host->callback=&callback;
    const auto pump=[&](int milliseconds){const auto deadline=juce::Time::getMillisecondCounter()+milliseconds;while(juce::Time::getMillisecondCounter()<deadline){CFRunLoopRunInMode(kCFRunLoopDefaultMode,.005,true);processor.processBlock(output,midi);}};
    const auto evaluate=[&](juce::String script){juce::var result;bool done=false;editor.evaluate(script,[&](auto value){if(value.getResult())result=*value.getResult();done=true;});for(int i=0;i<100&&!done;++i)pump(20);return result;};
    editor.addToDesktop(juce::ComponentPeer::windowIsTemporary,host);editor.setVisible(true);
    [window makeKeyAndOrderFront:nil];pump(100);
    const auto openCues=[&]{
        // Reparenting a WKWebView can finish its document reload asynchronously.
        // Wait for the new React view and the native focus-state acknowledgement.
        for(int i=0;i<100;++i){
            evaluate("(()=>{if(!document.querySelector('.cue-pad-grid'))document.querySelector('a[href=\"/cues\"]')?.click();if(window.__pluginInvoke)window.__pluginInvoke('keyboardDiagnostics').then(state=>window.__keyPadsReady=state.padsActive);return true;})()");
            pump(50);
            if((bool)evaluate("Boolean(document.querySelector('.cue-pad-grid')&&window.__keyPadsReady)")){pump(150);if((bool)evaluate("Boolean(document.querySelector('.cue-pad-grid')&&window.__keyPadsReady)"))return;}
        }
    };
    openCues();
    evaluate("window.__pluginStores.cues.getState().setTrack('keyfixture0');window.__pluginStores.cues.getState().setCue(1,.125);true");pump(100);
    auto* browser=findBrowser((NSView*)editor.getPeer()->getNativeHandle());
    bool passed=browser!=nil;
    const auto check=[&](bool condition,const char* message){if(!condition){passed=false;std::cerr<<"FAIL: "<<message<<" (host down="<<downs<<", up="<<ups<<")\n";}};
    const auto send=[&](bool down,unsigned short code,NSString* characters,bool repeat=false){
        auto* event=[NSEvent keyEventWithType:down?NSEventTypeKeyDown:NSEventTypeKeyUp location:NSZeroPoint modifierFlags:0 timestamp:[[NSProcessInfo processInfo] systemUptime]
            windowNumber:[window windowNumber] context:nil characters:characters charactersIgnoringModifiers:characters isARepeat:repeat keyCode:code];
        [NSApp sendEvent:event];
    };
    evaluate("document.activeElement?.blur();true");pump(50);
    [window makeFirstResponder:browser];
    processor.syncWebCues(juce::JSON::parse("{\"trackId\":\"keyfixture0\",\"bank\":\"A\",\"preset\":\"sp404mkii-a\",\"cues\":{\"A\":{\"1\":0.125}}}"));
    processor.submit({CueProcessor::Action::pause});processor.processBlock(output,midi);
    const auto before=processor.padStates[0].load()>>1;
    send(true,0,@"a");processor.processBlock(output,midi);
    check(downs==1,"Focused WebView did not forward exactly one computer-MIDI key-down");
    check((processor.padStates[0].load()>>1)==before+1,"Host key-down did not produce exactly one native MIDI pad hit");
    check(output.getMagnitude(0,0,31)==0&&output.getMagnitude(0,32,96)>.0001f,"Forwarded host MIDI lost its sample offset/audio response");
    for(int i=0;i<4;++i)send(true,0,@"a",true);
    send(false,0,@"a");processor.processBlock(output,midi);
    check(downs==1&&ups==1,"Auto-repeat or key release duplicated host MIDI events");
    const auto padBefore=processor.padStates[0].load()>>1;
    send(true,18,@"1");send(true,18,@"1",true);send(false,18,@"1");processor.processBlock(output,midi);pump(30);
    check((processor.padStates[0].load()>>1)==padBefore+1&&downs==1&&ups==1,"Number key hit both the native pad/browser/host paths");
    send(true,0,@"a");
    [[NSNotificationCenter defaultCenter] postNotificationName:NSWindowDidResignKeyNotification object:window];
    send(false,0,@"a");
    check(downs==2&&ups==2,"Focus loss did not release the forwarded key exactly once");
    midi.clear();
    evaluate("(()=>{const input=document.createElement('input');input.id='keyboard-routing-input';document.body.append(input);input.focus();return true;})()");pump(100);
    evaluate("window.__pluginInvoke('keyboardDiagnostics').then(state=>window.__keyboardEditing=state.editing);true");pump(50);
    check((bool)evaluate("window.__keyboardEditing===true"),"Native router did not observe text-entry focus");
    send(true,0,@"a");send(false,0,@"a");pump(100);
    check(downs==2&&ups==2,"Typing in an input leaked a MIDI note to the host");
    evaluate("document.getElementById('keyboard-routing-input').remove();true");pump(50);
    browser=findBrowser((NSView*)editor.getPeer()->getNativeHandle());[window makeFirstResponder:browser];
    send(true,0,@"a");ownedEditor.reset();
    check(downs==3&&ups==3,"Closing the editor did not release its outstanding host note");
    host->callback=nullptr;[window orderOut:nil];[window close];[host release];[window release];
    if(passed)std::cout<<"PASS: real Cocoa hosted focus routes one MIDI down/up pair, preserves MIDI sample offset, suppresses repeat/double paths, releases on focus loss, restores number pads and protects text entry\n";
    return passed;
}
