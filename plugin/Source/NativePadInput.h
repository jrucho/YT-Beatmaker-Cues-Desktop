#pragma once
#include "Processor.h"
#include <deque>
#include <unordered_map>

// Native view input and WebView messages share the UI thread. Only the existing
// lock-free command consumer runs on the render thread.
class PadInputRouter final {
public:
    explicit PadInputRouter(CueProcessor& value):engine(value){}
    void setSource(int id,const juce::String& track);
    void invalidateLayout();
    void configure(const juce::var&);
    juce::var claim(const juce::var&);
    juce::var state(bool supported) const;
    juce::var diagnostics(bool supported) const;
    bool pointerDown(double x,double y,double width,double height,bool physicalPixels,double eventEpochMs,double ageMs,uint64_t gesture=0);
    void pointerUp(uint64_t gesture);
    void cancelTouches();
private:
    struct Bounds {
        double x=0,y=0,w=0,h=0;
        bool contains(double px,double py) const {return w>0&&h>0&&px>=x&&py>=y&&px<x+w&&py<y+h;}
    };
    struct Region:Bounds {int pad=-1;double to=0;bool sample=false,looper=false;};
    struct Map {
        int source=-1,generation=-1,trackRevision=-1,layoutRevision=-1,bank=-1;
        double width=0,height=0,dpr=1;bool enabled=false;
        std::vector<Region> pads;std::vector<Bounds> blocked;
    };
    struct Receipt {int source,bank,pad,generation,trackRevision;bool sample,looper;double to,origin,eventEpoch,at;};
    CueProcessor& engine;
    Map map;
    std::deque<Receipt> receipts;
    struct HeldLoop {int bank,pad,generation;};std::unordered_map<uint64_t,HeldLoop> loopTouches;
    int sourceId=0,layoutRevision=0,accepted=0,claimed=0;
    mutable int observedGeneration=-1,observedTrackRevision=-1;
    mutable juce::String trackId;
};

class NativePadInputMonitor {
public:
    virtual ~NativePadInputMonitor()=default;
    virtual void poll(){}
    virtual void setPageScrollLocked(bool){}
    virtual bool ready() const=0;
};
std::unique_ptr<NativePadInputMonitor> createNativePadInputMonitor(std::shared_ptr<PadInputRouter>,juce::Component& browser);

class NativePadInput final {
public:
    NativePadInput(CueProcessor&,juce::Component& browser);
    ~NativePadInput();
    void poll(){if(monitor)monitor->poll();}
    void setPageScrollLocked(bool value){if(monitor)monitor->setPageScrollLocked(value);}
    bool supported() const {return monitor&&monitor->ready();}
    void setSource(int source,const juce::String& track){router->setSource(source,track);}
    void invalidateLayout(){router->invalidateLayout();}
    void configure(const juce::var& value){router->configure(value);}
    juce::var claim(const juce::var& value){return router->claim(value);}
    juce::var state() const {return router->state(supported());}
    juce::var diagnostics() const {return router->diagnostics(supported());}
private:
    std::shared_ptr<PadInputRouter> router;
    std::unique_ptr<NativePadInputMonitor> monitor;
};
