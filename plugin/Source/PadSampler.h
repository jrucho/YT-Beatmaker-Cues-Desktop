#pragma once
#include <juce_audio_formats/juce_audio_formats.h>
#include <array>
#include <atomic>
#include <mutex>
#include <vector>
#include <cmath>
#include <functional>

/** Resident one-shot pads. Loading, ownership and reclamation stay off the audio
 * thread; fixed voices and hazard pointers make MIDI triggers allocation-free. */
class PadSampler final {
public:
    static constexpr int slots=160, previewSlot=slots, storageSlots=slots+1, polyphony=32;
    static constexpr size_t memoryLimit=128*1024*1024;
    struct Clip {
        juce::AudioBuffer<float> audio;
        double rate=44100;
        juce::String name,path;
        std::array<float,256> peaks{};
        size_t bytes() const {return (size_t)audio.getNumSamples()*audio.getNumChannels()*sizeof(float);}
    };
    struct Assignment {int slot;std::unique_ptr<Clip> clip;double start=0;int ticket=-1;};
    bool assigned(int slot) const {return slot>=0&&slot<storageSlots&&occupied[(size_t)slot].load();}
    int reserve(int slot) {return ++tickets[(size_t)slot];}
    static std::unique_ptr<Clip> prepare(std::unique_ptr<juce::AudioFormatReader> reader,const juce::String& path,const juce::String& name) {
        if(!reader||!std::isfinite(reader->sampleRate)||reader->sampleRate<=0||reader->lengthInSamples<2)throw std::runtime_error("Cannot decode this sample");
        const int channels=juce::jlimit(1,2,(int)reader->numChannels);
        if(reader->lengthInSamples>(juce::int64)(memoryLimit/(channels*sizeof(float))))throw std::runtime_error("Sample exceeds the 128 MiB pad-memory budget; trim it before importing");
        auto clip=std::make_unique<Clip>();clip->rate=reader->sampleRate;clip->name=name;clip->path=path;
        clip->audio.setSize(channels,(int)reader->lengthInSamples);
        if(!reader->read(&clip->audio,0,clip->audio.getNumSamples(),0,true,channels>1))throw std::runtime_error("Could not read the complete sample");
        for(int c=0;c<channels;++c)for(int i=0;i<clip->audio.getNumSamples();++i){if(!std::isfinite(clip->audio.getSample(c,i)))clip->audio.setSample(c,i,0);
             const auto bin=(size_t)((juce::int64)i*256/clip->audio.getNumSamples());clip->peaks[bin]=juce::jmax(clip->peaks[bin],std::abs(clip->audio.getSample(c,i)));}
        return clip;
    }
    bool load(int slot,std::unique_ptr<juce::AudioFormatReader> reader,const juce::String& path,const juce::String& name,int ticket,double start=0) {
        std::vector<Assignment> batch;batch.push_back({slot,prepare(std::move(reader),path,name),start,ticket});return assign(std::move(batch));
    }
    bool assign(std::vector<Assignment> batch,const std::function<void(const juce::var&)>& beforePublish={}) {
        std::lock_guard<std::mutex> lock(mutex);
        std::array<bool,storageSlots> replacing{};size_t bytes=0;
        for(const auto& item:batch){if(item.slot<0||item.slot>=storageSlots||replacing[(size_t)item.slot])throw std::runtime_error("Invalid sample assignment");
            if(item.ticket>=0&&item.ticket!=tickets[(size_t)item.slot].load())return false;
            replacing[(size_t)item.slot]=true;if(item.clip)bytes+=item.clip->bytes();}
        collect();
        for(const auto& old:retained){bool keep=inUse(old.get());for(int slot=0;slot<storageSlots&&!keep;++slot)if(!replacing[(size_t)slot]&&published[(size_t)slot].load()==old.get())keep=true;if(keep)bytes+=old->bytes();}
        if(bytes>memoryLimit)throw std::runtime_error("Pad samples exceed the 128 MiB memory budget; remove or shorten a sample");
        auto next=descriptors;retained.reserve(retained.size()+batch.size());
        for(const auto& item:batch){const auto slot=(size_t)item.slot;const auto* pointer=item.clip.get();next[slot]=pointer?descriptor(item.slot,pointer->path,pointer->name,pointer->audio.getNumSamples()/pointer->rate,true,{}):juce::var{};
            if(pointer){auto* fields=next[slot].getDynamicObject();const double startAt=std::isfinite(item.start)?juce::jlimit(0.0,(pointer->audio.getNumSamples()-1)/pointer->rate,item.start):0;fields->setProperty("start",startAt);juce::Array<juce::var> overview;for(const auto peak:pointer->peaks)overview.add(peak);fields->setProperty("peaks",overview);}}
        if(beforePublish){juce::Array<juce::var> snapshot;for(int slot=0;slot<slots;++slot)if(next[(size_t)slot].isObject())snapshot.add(next[(size_t)slot]);beforePublish(juce::var(snapshot));}
        for(auto& item:batch){const auto slot=(size_t)item.slot;++tickets[slot];auto* pointer=item.clip.get();const double startAt=pointer&&std::isfinite(item.start)?juce::jlimit(0.0,(pointer->audio.getNumSamples()-1)/pointer->rate,item.start):0;
            if(pointer)retained.push_back(std::move(item.clip));starts[slot].store(startAt);published[slot].store(pointer);occupied[slot].store(pointer!=nullptr);
            descriptors[slot]=next[slot];}
        ++revision;collect();return true;
    }
    void clear(int slot) {
        std::lock_guard<std::mutex> lock(mutex);++tickets[(size_t)slot];published[(size_t)slot].store(nullptr);occupied[(size_t)slot].store(false);starts[(size_t)slot].store(0);descriptors[(size_t)slot]=juce::var();++revision;collect();
    }
    void setStart(int slot,double seconds){
        if(slot<0||slot>=slots||!std::isfinite(seconds))throw std::runtime_error("Invalid sample start");
        std::lock_guard<std::mutex> lock(mutex);const auto* clip=published[(size_t)slot].load();
        if(!clip)throw std::runtime_error("Sample is not ready");
        const double value=juce::jlimit(0.0,(clip->audio.getNumSamples()-1)/clip->rate,seconds);
        starts[(size_t)slot].store(value);descriptors[(size_t)slot].getDynamicObject()->setProperty("start",value);++revision;
    }
    // Edit-thread permutation: move existing PCM/starts without re-decoding or
    // replacing files. Render voices retain their normal hazard-pointer fades.
    void reassign(const std::array<int,slots>& source){
        std::lock_guard<std::mutex> lock(mutex);
        std::array<Clip*,slots> clips{};std::array<double,slots> offsets{};std::array<bool,slots> assigned{};std::array<juce::var,slots> saved;
        for(int slot=0;slot<slots;++slot){const auto i=(size_t)slot;clips[i]=published[i].load();offsets[i]=starts[i].load();assigned[i]=occupied[i].load();saved[i]=descriptors[i].clone();
            if(source[i]!=slot&&assigned[i]&&!clips[i]&&saved[i]["error"].toString().isEmpty())throw std::runtime_error("Wait for pad samples to finish loading");}
        for(int slot=0;slot<slots;++slot){const auto i=(size_t)slot,from=(size_t)source[i];if(from==i)continue;
            ++tickets[i];starts[i].store(offsets[from]);published[i].store(clips[from]);occupied[i].store(assigned[from]);descriptors[i]=saved[from];
            if(auto* fields=descriptors[i].getDynamicObject()){fields->setProperty("bank",juce::String::charToString((juce::juce_wchar)('A'+slot/16)));fields->setProperty("pad",slot%16+1);}}
        ++revision;collect();
    }
    juce::var waveform(int slot,double from,double to,int bins) const {
        std::lock_guard<std::mutex> lock(mutex);const auto* clip=slot>=0&&slot<slots?published[(size_t)slot].load():nullptr;
        if(!clip)throw std::runtime_error("Sample is not ready");
        const double duration=clip->audio.getNumSamples()/clip->rate;from=juce::jlimit(0.0,duration,from);to=juce::jlimit(from,duration,to);
        const int first=(int)(from*clip->rate),last=juce::jmin(clip->audio.getNumSamples(),(int)std::ceil(to*clip->rate));
        std::vector<float> values((size_t)bins,0);
        for(int i=first;i<last;++i){const auto bin=(size_t)juce::jmin(bins-1,(int)((juce::int64)(i-first)*bins/juce::jmax(1,last-first)));
            for(int c=0;c<clip->audio.getNumChannels();++c)values[bin]=juce::jmax(values[bin],std::abs(clip->audio.getSample(c,i)));}
        juce::Array<juce::var> peaks;for(float value:values)peaks.add(value);
        auto* result=new juce::DynamicObject;result->setProperty("peaks",peaks);result->setProperty("from",from);result->setProperty("to",to);result->setProperty("duration",duration);result->setProperty("path",clip->path);return juce::var(result);
    }
    int pending(int slot,const juce::String& path,const juce::String& name) {
        std::lock_guard<std::mutex> lock(mutex);const int ticket=reserve(slot);
        published[(size_t)slot].store(nullptr);occupied[(size_t)slot].store(true);descriptors[(size_t)slot]=descriptor(slot,path,name,0,false,{});++revision;return ticket;
    }
    void failed(int slot,int ticket,const juce::String& error) {
        std::lock_guard<std::mutex> lock(mutex);if(ticket!=tickets[(size_t)slot].load())return;
        if(auto* value=descriptors[(size_t)slot].getDynamicObject())value->setProperty("error",error);++revision;
    }
    juce::var snapshot() const {
        std::lock_guard<std::mutex> lock(mutex);juce::Array<juce::var> pads;
        for(int slot=0;slot<slots;++slot)if(descriptors[(size_t)slot].isObject())pads.add(descriptors[(size_t)slot].clone());return pads;
    }
    double tailSeconds() const {
        std::lock_guard<std::mutex> lock(mutex);double tail=0;for(const auto& value:descriptors)tail=juce::jmax(tail,(double)value["duration"]);return tail;
    }
    // Audio thread only. Even pending/missing assignments consume the pad hit,
    // so a temporarily unavailable sample can never accidentally create a cue.
    bool trigger(int slot,float velocity,double previewStart=-1) {
        if(!assigned(slot))return false;
        int index=0;
        for(int i=0;i<polyphony;++i){if(!voices[(size_t)i].clip){index=i;break;}if(voices[(size_t)i].serial<voices[(size_t)index].serial)index=i;}
        auto& voice=voices[(size_t)index];Clip* clip=nullptr;
        do{clip=published[(size_t)slot].load();hazards[(size_t)index].store(clip);}while(clip!=published[(size_t)slot].load());
        const auto tail=voice.last;
        voice={};voice.clip=clip;voice.slot=slot;voice.gain=juce::jlimit(0.0f,1.0f,velocity);voice.serial=++serial;
        if(clip)voice.position=juce::jlimit(0.0,(double)clip->audio.getNumSamples()-1,(previewStart>=0?previewStart:starts[(size_t)slot].load())*clip->rate);
        voice.tail=tail;voice.crossfade=32;
        return true;
    }
    void stopAll() {for(auto& voice:voices)if(voice.clip)voice.release=32;}
    void audition(int slot,double start) {for(auto& voice:voices)if(voice.clip&&voice.slot==slot)voice.release=32;trigger(slot,1.0f,start);}
    std::array<float,2> frame(double outputRate) {
        std::array<float,2> output{};
        for(int index=0;index<polyphony;++index){auto& voice=voices[(size_t)index];auto* clip=voice.clip;if(!clip)continue;
            if(published[(size_t)voice.slot].load()!=clip&&voice.release<0)voice.release=32;
            const int length=clip->audio.getNumSamples(),at=juce::jmin(length-1,(int)voice.position),next=juce::jmin(at+1,length-1);
            const float fraction=(float)(voice.position-at);const double step=clip->rate/outputRate;
            const float fade=juce::jmin(1.0f,(float)(voice.age+1)/32.0f,(float)((length-voice.position)/(step*32)))*(voice.release<0?1.0f:voice.release/32.0f);
            for(int c=0;c<2;++c){const auto* data=clip->audio.getReadPointer(juce::jmin(c,clip->audio.getNumChannels()-1));
                const float sample=(data[at]+fraction*(data[next]-data[at]))*voice.gain*fade+(voice.crossfade>0?voice.tail[(size_t)c]*voice.crossfade/32.0f:0.0f);
                voice.last[(size_t)c]=sample;output[(size_t)c]+=sample;
            }
            if(voice.crossfade>0)--voice.crossfade;if(voice.release>0)--voice.release;
            voice.position+=step;++voice.age;
            if(voice.position>=length||voice.release==0){voice={};hazards[(size_t)index].store(nullptr);}
        }
        return output;
    }
    std::atomic<int> revision{0};
private:
    struct Voice {Clip* clip=nullptr;int slot=0,age=0,release=-1,crossfade=0;double position=0;float gain=1;juce::uint64 serial=0;std::array<float,2> last{},tail{};};
    static juce::var descriptor(int slot,const juce::String& path,const juce::String& name,double duration,bool ready,const juce::String& error) {
        auto* value=new juce::DynamicObject;value->setProperty("bank",juce::String::charToString((juce::juce_wchar)('A'+slot/16)));value->setProperty("pad",slot%16+1);
        value->setProperty("path",path);value->setProperty("name",name);value->setProperty("duration",duration);value->setProperty("start",0.0);value->setProperty("ready",ready);value->setProperty("error",error);return juce::var(value);
    }
    bool inUse(const Clip* clip) const {for(const auto& hazard:hazards)if(hazard.load()==clip)return true;return false;}
    void collect() {
        retained.erase(std::remove_if(retained.begin(),retained.end(),[this](const auto& clip){
            if(inUse(clip.get()))return false;for(const auto& slot:published)if(slot.load()==clip.get())return false;return true;
        }),retained.end());
    }
    mutable std::mutex mutex;
    std::array<std::atomic<Clip*>,storageSlots> published{};
    std::array<std::atomic<Clip*>,polyphony> hazards{};
    std::array<std::atomic<bool>,storageSlots> occupied{};
    std::array<std::atomic<double>,storageSlots> starts{};
    std::array<std::atomic<int>,storageSlots> tickets{};
    std::array<juce::var,storageSlots> descriptors;
    std::vector<std::unique_ptr<Clip>> retained;
    std::array<Voice,polyphony> voices;
    juce::uint64 serial=0;
};
