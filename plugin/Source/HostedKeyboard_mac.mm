#include "HostedKeyboard.h"
#include "Processor.h"
#import <Cocoa/Cocoa.h>
#include <array>
#include <utility>

namespace {
int padForKey(unsigned short code,bool shift){
    int number=-1;
    switch(code){
        case 29:case 82:number=0;break;case 18:case 83:number=1;break;
        case 19:case 84:number=2;break;case 20:case 85:number=3;break;
        case 21:case 86:number=4;break;case 23:case 87:number=5;break;
        case 22:case 88:number=6;break;case 26:case 89:number=7;break;
        case 28:case 91:number=8;break;case 25:case 92:number=9;break;
        default:return -1;
    }
    return shift&&number>=1&&number<=6?number+9:number==0?9:number-1;
}
struct RoutingState {
    explicit RoutingState(CueProcessor& processor,juce::Component& component):engine(processor),owner(&component){}
    ~RoutingState(){stop();}
    enum class Destination{none,pad,host};
    struct Held {Destination destination=Destination::none;NSView* target=nil;NSEvent* down=nil;};
    CueProcessor& engine;
    juce::Component::SafePointer<juce::Component> owner;
    std::array<Held,128> held{};
    id monitor=nil,resignApp=nil,resignWindow=nil;
    bool enabled=true,editing=false,padsActive=false,forwarding=false;
    int forwardedDown=0,forwardedUp=0,padDown=0,suppressedRepeats=0;

    NSView* root() const {auto* peer=owner?owner->getPeer():nullptr;return peer?(NSView*)peer->getNativeHandle():nil;}
    bool inside(NSEvent* event) const {
        auto* view=root();auto* window=[event window];if(!window)window=[NSApp keyWindow];
        auto* responder=[window firstResponder];
        return view&&window==[view window]&&[responder isKindOfClass:[NSView class]]&&((NSView*)responder==view||[(NSView*)responder isDescendantOf:view]);
    }
    void send(NSView* target,NSEvent* event,bool down){
        auto* window=[[target window] retain];if(!window)return;
        auto* previous=[[window firstResponder] retain];
        const bool wasForwarding=std::exchange(forwarding,true);
        @try {
            [window makeFirstResponder:target];
            if(down)[target keyDown:event];else[target keyUp:event];
        } @finally {
            if([window firstResponder]==target&&[previous isKindOfClass:[NSView class]]&&[(NSView*)previous window]==window)[window makeFirstResponder:previous];
            forwarding=wasForwarding;[previous release];[window release];
        }
    }
    void release(unsigned short code,NSEvent* event=nullptr){
        auto item=std::exchange(held[(size_t)code],Held{});
        if(item.destination==Destination::host){
            if(!event)event=[NSEvent keyEventWithType:NSEventTypeKeyUp location:[item.down locationInWindow] modifierFlags:[item.down modifierFlags]
                timestamp:[[NSProcessInfo processInfo] systemUptime] windowNumber:[item.down windowNumber] context:nil
                characters:[item.down characters] charactersIgnoringModifiers:[item.down charactersIgnoringModifiers] isARepeat:NO keyCode:code];
            ++forwardedUp;send(item.target,event,false);
        }
        [item.target release];[item.down release];
    }
    void flush(){for(unsigned short code=0;code<held.size();++code)if(held[(size_t)code].destination!=Destination::none)release(code);}
    void setUiState(bool text,bool pads){if(text&&!editing)flush();editing=text;padsActive=pads;}
    NSEvent* handle(NSEvent* event){
        if(!enabled)return event;
        if(forwarding)return nil;
        const auto code=[event keyCode];if(code>=held.size())return event;
        auto& key=held[(size_t)code];
        if([event type]==NSEventTypeKeyUp){
            if(key.destination==Destination::none)return event;
            release(code,event);return nil;
        }
        if(!inside(event))return event;
        if(key.destination!=Destination::none){++suppressedRepeats;return nil;}
        if(editing)return event;
        const auto flags=[event modifierFlags];
        const int pad=padForKey(code,(flags&NSEventModifierFlagShift)!=0);
        if(padsActive&&pad>=0&&pad<engine.padCount()&&(flags&NSEventModifierFlagOption)==0){
            if([event isARepeat]){++suppressedRepeats;return nil;}
            const bool overwrite=engine.overwrite.load()||(flags&(NSEventModifierFlagCommand|NSEventModifierFlagControl))!=0;
            engine.submit({CueProcessor::Action::pad,engine.selectedBank.load(),pad,0,overwrite});
            key.destination=Destination::pad;++padDown;return nil;
        }
        // Menu shortcuts and normal text/navigation stay in Cocoa/WebKit.
        if((flags&(NSEventModifierFlagCommand|NSEventModifierFlagControl|NSEventModifierFlagOption))!=0)return event;
        NSString* characters=[event charactersIgnoringModifiers];
        const auto character=[characters length]==1?[characters characterAtIndex:0]:0;
        if(!((character>=32&&character<127)||(code>=123&&code<=126)))return event;
        auto* target=[root() superview];if(!target)return event;
        if([event isARepeat]){++suppressedRepeats;return nil;}
        key={Destination::host,[target retain],[event retain]};++forwardedDown;
        // Dispatch once to the host's responder, then consume the original event.
        // No JS-to-MIDI emulation or second WebKit path runs for the same press.
        send(target,event,true);return nil;
    }
    void stop(){
        if(!enabled)return;enabled=false;
        if(monitor){[NSEvent removeMonitor:monitor];[monitor release];monitor=nil;}
        if(resignApp){[[NSNotificationCenter defaultCenter] removeObserver:resignApp];[resignApp release];resignApp=nil;}
        if(resignWindow){[[NSNotificationCenter defaultCenter] removeObserver:resignWindow];[resignWindow release];resignWindow=nil;}
        flush();
    }
};
class MacHostedKeyboard final:public HostedKeyboard {
public:
    MacHostedKeyboard(CueProcessor& engine,juce::Component& owner):state(std::make_shared<RoutingState>(engine,owner)){
        std::weak_ptr<RoutingState> weak=state;
        state->monitor=[[NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown|NSEventMaskKeyUp handler:^NSEvent*(NSEvent* event){
            const auto current=weak.lock();return current?current->handle(event):event;
        }] retain];
        state->resignApp=[[[NSNotificationCenter defaultCenter] addObserverForName:NSApplicationDidResignActiveNotification object:nil queue:nil usingBlock:^(NSNotification*){
            if(const auto current=weak.lock())current->flush();
        }] retain];
        state->resignWindow=[[[NSNotificationCenter defaultCenter] addObserverForName:NSWindowDidResignKeyNotification object:nil queue:nil usingBlock:^(NSNotification* notification){
            if(const auto current=weak.lock())if([notification object]==[current->root() window]&&!current->forwarding)current->flush();
        }] retain];
    }
    ~MacHostedKeyboard() override {state->stop();}
    void setUiState(bool editing,bool padsActive) override {state->setUiState(editing,padsActive);}
    juce::var diagnostics() const override {
        auto* data=new juce::DynamicObject;data->setProperty("forwardedDown",state->forwardedDown);data->setProperty("forwardedUp",state->forwardedUp);
        data->setProperty("padDown",state->padDown);data->setProperty("suppressedRepeats",state->suppressedRepeats);
        data->setProperty("editing",state->editing);data->setProperty("padsActive",state->padsActive);return juce::var(data);
    }
private:std::shared_ptr<RoutingState> state;
};
}
std::unique_ptr<HostedKeyboard> createHostedKeyboard(CueProcessor& engine,juce::Component& owner){return std::make_unique<MacHostedKeyboard>(engine,owner);}
