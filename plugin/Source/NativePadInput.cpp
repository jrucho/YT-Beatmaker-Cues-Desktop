#include "NativePadInput.h"
#include <cmath>

namespace {
juce::var data(std::initializer_list<std::pair<juce::Identifier,juce::var>> fields){
    auto* object=new juce::DynamicObject;for(const auto& field:fields)object->setProperty(field.first,field.second);return juce::var(object);
}
}

void PadInputRouter::setSource(int id,const juce::String& track){
    sourceId=id;trackId=track;observedGeneration=engine.audioGeneration();observedTrackRevision=engine.nativeTrackRevision.load();
    map={};
}
void PadInputRouter::invalidateLayout(){map={};++layoutRevision;}
void PadInputRouter::configure(const juce::var& value){
    map={};if(!value.isObject())return;
    Map next;next.source=(int)value["sourceId"];next.generation=(int)value["generation"];
    next.trackRevision=(int)value["trackRevision"];next.layoutRevision=(int)value["layoutRevision"];next.bank=(int)value["bank"];
    next.width=(double)value["width"];next.height=(double)value["height"];next.dpr=juce::jmax(0.1,(double)value["dpr"]);next.enabled=(bool)value["enabled"];
    const auto bounds=[](const juce::var& row){return Bounds{(double)row["x"],(double)row["y"],(double)row["w"],(double)row["h"]};};
    if(const auto* pads=value["pads"].getArray())for(const auto& row:*pads){
        if(next.pads.size()>=16)break;Region region;static_cast<Bounds&>(region)=bounds(row);
        region.pad=(int)row["pad"];region.to=(double)row["to"];region.sample=(bool)row["sample"];next.pads.push_back(region);
    }
    if(const auto* holes=value["blocked"].getArray())for(const auto& row:*holes){if(next.blocked.size()>=32)break;next.blocked.push_back(bounds(row));}
    if(next.bank<0||next.bank>=10||!std::isfinite(next.width)||!std::isfinite(next.height)||!std::isfinite(next.dpr)||next.width<=0||next.height<=0)return;
    map=std::move(next);
}
bool PadInputRouter::pointerDown(double x,double y,double width,double height,bool physicalPixels,double eventEpochMs,double ageMs){
    if(!std::isfinite(x)||!std::isfinite(y)||!std::isfinite(width)||!std::isfinite(height)||!std::isfinite(eventEpochMs)||!std::isfinite(ageMs))return false;
    if(!map.enabled||map.source!=sourceId||map.layoutRevision!=layoutRevision||engine.backgroundPlayback.load())return false;
    const double scale=physicalPixels?map.dpr:1;
    if(std::abs(width/scale-map.width)>2.5||std::abs(height/scale-map.height)>2.5||width<=0||height<=0)return false;
    x/=width;y/=height;
    for(const auto& hole:map.blocked)if(hole.contains(x,y))return false;
    for(const auto& pad:map.pads){
        if(pad.pad<0||pad.pad>=engine.padCount()||!pad.contains(x,y))continue;
        if(engine.hasPadSample(map.bank,pad.pad)!=pad.sample)return false;
        if(!pad.sample&&(!engine.ready.load()||engine.nativeAdvancing.load()||map.generation!=engine.audioGeneration()
            ||map.trackRevision!=engine.nativeTrackRevision.load()||!std::isfinite(pad.to)||pad.to<0))return false;
        const double origin=engine.playhead.load();
        CueProcessor::Command command{pad.sample?CueProcessor::Action::pad:CueProcessor::Action::cue,map.bank,pad.pad,pad.to};
        if(!pad.sample)command.sourceGeneration=map.generation;
        if(!engine.submitNativePadInput(command,juce::Time::getMillisecondCounterHiRes()-juce::jlimit(0.0,60000.0,ageMs)))return false;
        while(receipts.size()>=256)receipts.pop_front();
        receipts.push_back({map.source,map.bank,pad.pad,map.generation,map.trackRevision,pad.sample,pad.to,origin,eventEpochMs,juce::Time::getMillisecondCounterHiRes()});
        if(!pad.sample)engine.requestedPlay.store(true);
        ++accepted;return true;
    }
    return false;
}
juce::var PadInputRouter::claim(const juce::var& request){
    const int source=(int)request["sourceId"],bank=(int)request["bank"],pad=(int)request["pad"];
    const bool sample=(bool)request["sample"];const double target=(double)request["to"],epoch=(double)request["eventEpochMs"];
    const auto now=juce::Time::getMillisecondCounterHiRes();
    for(auto it=receipts.begin();it!=receipts.end();){
        if(now-it->at>60000){it=receipts.erase(it);continue;}
        if(it->bank==bank&&it->pad==pad&&std::abs(it->eventEpoch-epoch)<=40){
            const auto receipt=*it;receipts.erase(it);++claimed;
            // The same event may reach React after its source/assignment changed.
            // Consume it as stale rather than replaying the new cue/sample.
            const bool stale=receipt.source!=source||receipt.sample!=sample||(!sample&&(std::abs(receipt.to-target)>=.0001
                ||receipt.generation!=engine.audioGeneration()||receipt.trackRevision!=engine.nativeTrackRevision.load()));
            return data({{"accepted",true},{"stale",stale},{"position",receipt.origin}});
        }
        ++it;
    }
    const bool stale=!sample&&(source!=sourceId||(int)request["generation"]!=engine.audioGeneration()||(int)request["trackRevision"]!=engine.nativeTrackRevision.load());
    return data({{"accepted",false},{"stale",stale}});
}
juce::var PadInputRouter::state(bool supported) const {
    const int generation=engine.audioGeneration(),revision=engine.nativeTrackRevision.load();
    if(generation!=observedGeneration||revision!=observedTrackRevision){
        trackId=engine.nativeSnapshot()["trackId"].toString();observedGeneration=generation;observedTrackRevision=revision;
    }
    return data({{"supported",supported},{"sourceId",sourceId},{"audioGeneration",generation},{"trackRevision",revision},
        {"trackId",trackId},{"layoutRevision",layoutRevision},{"ready",engine.ready.load()}});
}
juce::var PadInputRouter::diagnostics(bool supported) const {
    auto result=state(supported);auto* fields=result.getDynamicObject();
    fields->setProperty("accepted",accepted);fields->setProperty("claimed",claimed);
    fields->setProperty("queued",engine.nativePadInputAccepted.load());fields->setProperty("rendered",engine.nativePadInputRendered.load());
    fields->setProperty("lastInputToRenderMs",engine.nativePadInputRenderMs.load());
    fields->setProperty("mappedPads",(int)map.pads.size());fields->setProperty("mapEnabled",map.enabled);
    fields->setProperty("mapSourceId",map.source);fields->setProperty("mapGeneration",map.generation);fields->setProperty("mapTrackRevision",map.trackRevision);fields->setProperty("mapLayoutRevision",map.layoutRevision);
    fields->setProperty("viewportWidth",map.width);fields->setProperty("viewportHeight",map.height);return result;
}
NativePadInput::NativePadInput(CueProcessor& engine,juce::Component& browser):router(std::make_shared<PadInputRouter>(engine)),monitor(createNativePadInputMonitor(router,browser)){}
NativePadInput::~NativePadInput(){monitor.reset();}

#if !JUCE_MAC && !JUCE_IOS && !JUCE_WINDOWS
std::unique_ptr<NativePadInputMonitor> createNativePadInputMonitor(std::shared_ptr<PadInputRouter>,juce::Component&){return {};}
#endif
