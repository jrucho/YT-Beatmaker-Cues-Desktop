#pragma once
#include <juce_core/juce_core.h>
#include <array>
#include <atomic>
#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

/** MIDI-style internal pad looper. Scheduling/recording use a fixed event budget
 * and a 48 kHz reference clock; source speed/seek never moves loop time. Snapshot
 * fields/events are atomic, so persistence never takes a render-thread lock. */
class PadLooper final {
public:
    static constexpr int slots=160,maxEvents=1024;
    enum Mode {stopped,recording,playing,overdubbing};
    enum Control {assign,remove,press,release,stop,clear,undo};
    struct Event {int bank,pad,velocity;};
    struct PlainClip {int slot=0,layers=1;bool undone=false;uint32_t length=0;std::vector<uint64_t> events;};
    struct Restore {int generation=0;std::vector<PlainClip> clips;};
    PadLooper():clips(std::make_unique<std::array<Clip,slots>>()){}
    bool assigned(int bank,int pad) const {return bank>=0&&bank<10&&pad>=0&&pad<16&&(*clips)[(size_t)(bank*16+pad)].assigned.load();}
    int currentGeneration() const{return generation.load();}
    int revision() const{return edits.load();}
    void halt(){finishActive();held=-1;lastTap=-1;}
    void publish(std::unique_ptr<Restore> next){auto* pointer=next.get();restores.push_back(std::move(next));pending.store(pointer);const auto* inUse=restoreHazard.load();restores.erase(std::remove_if(restores.begin(),restores.end(),[pointer,inUse](const auto& entry){return entry.get()!=pointer&&entry.get()!=inUse;}),restores.end());}
    void beginBlock(){
        Restore* next;do{next=pending.load();restoreHazard.store(next);}while(next!=pending.load());
        if(next&&next->generation!=generation.load()){
            writing();active.store(-1);mode.store(stopped);held=-1;cursor=0;lastTap=-1;
            for(auto& clip:*clips){clip.assigned.store(false);clip.count.store(0);clip.playCount.store(0);clip.length.store(0);clip.layers.store(0);clip.undone.store(false);}
            for(const auto& saved:next->clips){auto& clip=(*clips)[(size_t)saved.slot];clip.assigned.store(true);clip.length.store(saved.length);clip.layers.store(saved.layers);clip.undone.store(saved.undone);const int count=juce::jmin(maxEvents,(int)saved.events.size());for(int i=0;i<count;++i)clip.events[(size_t)i].store(saved.events[(size_t)i]);clip.count.store(count);clip.playCount.store(count);}
            generation.store(next->generation);changed();
        }restoreHazard.store(nullptr);
    }
    void control(Control action,int bank,int pad){
        const int slot=bank*16+pad;if(bank<0||bank>=10||pad<0||pad>=16)return;
        auto& clip=(*clips)[(size_t)slot];
        if(action==assign){writing();clip.assigned.store(true);changed();return;}
        if(action==remove){erase(slot);writing();clip.assigned.store(false);changed();return;}
        if(!clip.assigned.load())return;
        if(action==release){if(held==slot)held=-1;return;}
        if(action==clear){erase(slot);return;}
        if(action==undo){toggleUndo(slot);return;}
        if(action==stop){finishActive();return;}
        held=slot;holdAt=clock;holdHandled=false;doubleHold=false;
        const bool doubleTap=lastTap==slot&&clock-lastTapAt<=14400&&mode.load()!=recording;
        lastTap=slot;lastTapAt=clock;
        if(doubleTap){doubleHold=true;finishActive();return;}
        if(active.load()!=slot){finishActive();active.store(slot);if(clip.length.load()==0){writing();clip.count.store(0);clip.playCount.store(0);clip.layers.store(1);clip.undone.store(false);startAt=clock;recordStart.store((uint64_t)clock);mode.store(recording);changed();}else startPlaying(slot);return;}
        if(mode.load()==recording){finishRecord(clip);startPlaying(slot);}
        else if(mode.load()==playing){
            writing();overdubBase=clip.count.load();mode.store(overdubbing);changed();
        }else if(mode.load()==overdubbing){finishOverdub(clip,true);mode.store(playing);}
    }
    void capture(int bank,int pad,float gain){
        const int slot=active.load(),state=mode.load();if(slot<0||(state!=recording&&state!=overdubbing))return;
        auto& clip=(*clips)[(size_t)slot];
        if(state==overdubbing&&clip.undone.load()){
            writing();int count=0,nextCursor=0;const int oldCursor=cursor;for(int i=0;i<clip.count.load();++i){const auto word=clip.events[(size_t)i].load();if(layer(word)!=clip.layers.load()){if(i<oldCursor)++nextCursor;clip.events[(size_t)count++].store(word);}}
            clip.count.store(count);clip.playCount.store(count);clip.layers.store(juce::jmax(0,clip.layers.load()-1));clip.undone.store(false);cursor=nextCursor;overdubBase=count;changed();
        }
        const int count=clip.count.load();int total=0;for(const auto& stored:*clips)total+=stored.count.load();if(count>=maxEvents||total>=8192||clip.layers.load()>=31)return;
        const uint32_t offset=state==recording?(uint32_t)juce::jmin(57600000.0,clock-startAt):phase(clip);
        const int number=state==recording?1:clip.layers.load()+1;const auto word=pack(offset,bank,pad,juce::jlimit(1,127,(int)std::lround(gain*127)),number);
        writing();clip.events[(size_t)count].store(word);if(state==overdubbing)bornCycle[(size_t)count]=playedCycle[(size_t)count]=cycle(clip);clip.count.store(count+1);changed();
    }
    template<class Play> void fire(Play&& play){
        if(held>=0&&!holdHandled&&clock-holdAt>=(doubleHold?28800:57600)){holdHandled=true;if(doubleHold){toggleUndo(held);startPlaying(held);}else erase(held);}
        const int slot=active.load(),state=mode.load();if(slot<0||(state!=playing&&state!=overdubbing))return;
        auto& clip=(*clips)[(size_t)slot];const auto length=clip.length.load();if(!length)return;
        const auto pass=cycle(clip);if(pass!=lastCycle){cursor=0;lastCycle=pass;}
        const auto at=phase(clip);const int count=clip.playCount.load();
        while(cursor<count){const int index=cursor;const auto word=clip.events[(size_t)cursor].load();if(offset(word)>at)break;++cursor;if((skipClock==clock&&skipAtClock[(size_t)index])||(clip.undone.load()&&layer(word)==clip.layers.load()))continue;play(Event{(int)((word>>32)&15),(int)((word>>36)&15),(int)((word>>40)&127)});}
        if(state==overdubbing)for(int i=count;i<clip.count.load();++i)if(pass>bornCycle[(size_t)i]&&playedCycle[(size_t)i]!=pass){const auto word=clip.events[(size_t)i].load();if(offset(word)<=at){playedCycle[(size_t)i]=pass;play(Event{(int)((word>>32)&15),(int)((word>>36)&15),(int)((word>>40)&127)});}}
    }
    int segment(int maximum,double rate) const {
        double ticks=maximum*48000.0/rate;
        if(held>=0&&!holdHandled)ticks=juce::jmin(ticks,juce::jmax(0.0,holdAt+(doubleHold?28800:57600)-clock));
        const int slot=active.load(),state=mode.load();if(slot>=0&&(state==playing||state==overdubbing)){
            const auto& clip=(*clips)[(size_t)slot];const auto length=clip.length.load();if(length){const auto at=phaseTicks(clip);const int count=clip.playCount.load();const double next=cursor<count?offset(clip.events[(size_t)cursor].load()):length;ticks=juce::jmin(ticks,juce::jmax(0.0,next-at));}
            if(state==overdubbing&&length){const auto pass=cycle(clip);const auto at=phaseTicks(clip);for(int i=clip.playCount.load();i<clip.count.load();++i)if(pass>bornCycle[(size_t)i]&&playedCycle[(size_t)i]!=pass)ticks=juce::jmin(ticks,juce::jmax(0.0,(double)offset(clip.events[(size_t)i].load())-at));}
        }
        return juce::jlimit(1,maximum,(int)std::ceil(ticks*rate/48000.0-1e-8));
    }
    void advance(int frames,double rate){clock+=frames*48000.0/rate;publishedClock.store((uint64_t)clock);}
    juce::var snapshot(bool withEvents) const {
        for(int attempt=0;attempt<100;++attempt){const auto before=version.load();if(before&1u){juce::Thread::yield();continue;}
            juce::Array<juce::var> result;const int selected=active.load(),state=mode.load();
            for(int slot=0;slot<slots;++slot){const auto& clip=(*clips)[(size_t)slot];if(!clip.assigned.load())continue;const int count=clip.count.load();auto* fields=new juce::DynamicObject;
                fields->setProperty("bank",juce::String::charToString((juce::juce_wchar)('A'+slot/16)));fields->setProperty("pad",slot%16+1);fields->setProperty("mode",selected==slot?state:stopped);
                uint32_t length=clip.length.load();if(selected==slot&&state==recording)length=(uint32_t)juce::jmax((uint64_t)48,publishedClock.load()-recordStart.load());fields->setProperty("length",(juce::int64)length);fields->setProperty("duration",length/48000.0);fields->setProperty("layers",clip.layers.load()+(selected==slot&&state==overdubbing&&count>clip.playCount.load()?1:0));fields->setProperty("undone",clip.undone.load());fields->setProperty("count",count);
                if(withEvents){juce::Array<juce::var> events;for(int i=0;i<count;++i)events.add((juce::int64)clip.events[(size_t)i].load());fields->setProperty("events",events);}
                result.add(juce::var(fields));
            }
            if(before==version.load()){auto* root=new juce::DynamicObject;root->setProperty("generation",generation.load());root->setProperty("revision",edits.load());root->setProperty("pads",result);return juce::var(root);}
        }throw std::runtime_error("Looper snapshot is busy; retry");
    }
    static std::unique_ptr<Restore> restore(const juce::var& data,int generation){
        auto result=std::make_unique<Restore>();result->generation=generation;const auto pads=data["pads"];if(!pads.isArray())return result;int total=0;std::array<bool,slots> used{};
        for(const auto& pad:*pads.getArray()){const auto bank=pad["bank"].toString();const int number=(int)pad["pad"]-1;if(bank.length()!=1||bank[0]<'A'||bank[0]>'J'||number<0||number>=16)throw std::runtime_error("Invalid saved looper pad");const int slot=((int)bank[0]-'A')*16+number;if(used[(size_t)slot])throw std::runtime_error("Duplicate looper pad");used[(size_t)slot]=true;
            PlainClip clip;clip.slot=slot;clip.length=(uint32_t)juce::jlimit((juce::int64)0,(juce::int64)57600000,(juce::int64)pad["length"]);clip.layers=juce::jlimit(0,31,(int)pad["layers"]);clip.undone=(bool)pad["undone"];
            if(const auto* events=pad["events"].getArray())for(const auto& value:*events){if(clip.events.size()>=maxEvents||++total>8192)throw std::runtime_error("Saved loopers exceed the event budget");const auto word=(uint64_t)(juce::int64)value;if(((word>>32)&15)>=10||((word>>40)&127)==0||(word>>52)!=0)throw std::runtime_error("Invalid saved looper event");clip.events.push_back(word);}
            if(clip.length)for(auto& word:clip.events){const auto at=juce::jmin(offset(word),clip.length-1);word=(word&~0xffffffffull)|at;}
            std::stable_sort(clip.events.begin(),clip.events.end(),[](auto a,auto b){return offset(a)<offset(b);});result->clips.push_back(std::move(clip));
        }return result;
    }
private:
    struct Clip {std::atomic<bool> assigned{false},undone{false};std::atomic<int> count{0},playCount{0},layers{0};std::atomic<uint32_t> length{0};std::array<std::atomic<uint64_t>,maxEvents> events{};};
    static uint32_t offset(uint64_t word){return (uint32_t)word;}
    static int layer(uint64_t word){return (int)((word>>47)&31);}
    static uint64_t pack(uint32_t at,int bank,int pad,int velocity,int layer){return at|((uint64_t)bank<<32)|((uint64_t)pad<<36)|((uint64_t)velocity<<40)|((uint64_t)layer<<47);}
    double phaseTicks(const Clip& clip) const {const auto length=clip.length.load();if(!length)return 0;const auto at=std::fmod(juce::jmax(0.0,clock-playAt),(double)length);return at>=length-1e-7?0:at;}
    uint32_t phase(const Clip& clip) const {return (uint32_t)(phaseTicks(clip)+1e-7);}
    uint64_t cycle(const Clip& clip) const {return clip.length.load()?(uint64_t)std::floor((juce::jmax(0.0,clock-playAt)+1e-7)/clip.length.load()):0;}
    void writing(){version.fetch_add(1);}
    void changed(){edits.fetch_add(1);version.fetch_add(1);}
    void sort(Clip& clip,bool merge=false){const int count=clip.count.load(),oldCount=clip.playCount.load(),oldCursor=cursor;const auto pass=cycle(clip);const auto at=phase(clip);for(int i=0;i<count;++i)scratch[(size_t)i]={clip.events[(size_t)i].load(),i,merge&&(i<oldCount?i<oldCursor:playedCycle[(size_t)i]==pass)};
        std::sort(scratch.begin(),scratch.begin()+count,[](const auto& a,const auto& b){return offset(a.word)!=offset(b.word)?offset(a.word)<offset(b.word):a.order<b.order;});for(int i=0;i<count;++i){clip.events[(size_t)i].store(scratch[(size_t)i].word);skipAtClock[(size_t)i]=scratch[(size_t)i].skip;}clip.playCount.store(count);
        if(merge){skipClock=clock;cursor=0;while(cursor<count&&offset(clip.events[(size_t)cursor].load())<at)++cursor;}}
    void finishRecord(Clip& clip){writing();const auto length=(uint32_t)juce::jlimit(48.0,57600000.0,clock-startAt);clip.length.store(length);for(int i=0;i<clip.count.load();++i){const auto word=clip.events[(size_t)i].load();if(offset(word)>=length)clip.events[(size_t)i].store((word&~0xffffffffull)|(length-1));}sort(clip);changed();}
    void finishOverdub(Clip& clip,bool merge=false){writing();if(clip.count.load()>overdubBase)clip.layers.fetch_add(1);sort(clip,merge);changed();}
    void finishActive(){const int slot=active.load();if(slot>=0){auto& clip=(*clips)[(size_t)slot];if(mode.load()==recording)finishRecord(clip);else if(mode.load()==overdubbing)finishOverdub(clip);}mode.store(stopped);active.store(-1);edits.fetch_add(1);}
    void startPlaying(int slot){auto& clip=(*clips)[(size_t)slot];if(!clip.length.load())return;active.store(slot);mode.store(playing);playAt=clock;lastCycle=0;cursor=0;skipClock=-1;edits.fetch_add(1);}
    void erase(int slot){if(active.load()==slot){active.store(-1);mode.store(stopped);}writing();auto& clip=(*clips)[(size_t)slot];clip.count.store(0);clip.playCount.store(0);clip.layers.store(0);clip.length.store(0);clip.undone.store(false);changed();}
    void toggleUndo(int slot){auto& clip=(*clips)[(size_t)slot];if(clip.layers.load()<1)return;writing();clip.undone.store(!clip.undone.load());changed();}
    std::unique_ptr<std::array<Clip,slots>> clips;std::vector<std::unique_ptr<Restore>> restores;std::atomic<Restore*> pending{nullptr},restoreHazard{nullptr};
    std::atomic<uint64_t> version{0},publishedClock{0},recordStart{0};std::atomic<int> generation{0},edits{0},active{-1},mode{stopped};
    struct SortEntry{uint64_t word=0;int order=0;bool skip=false;};std::array<SortEntry,maxEvents> scratch{};std::array<uint64_t,maxEvents> bornCycle{},playedCycle{};std::array<bool,maxEvents> skipAtClock{};
    double clock=0,startAt=0,playAt=0,holdAt=0,lastTapAt=-1e9,skipClock=-1;uint64_t lastCycle=0;int cursor=0,overdubBase=0,held=-1,lastTap=-1;bool holdHandled=false,doubleHold=false;
};
