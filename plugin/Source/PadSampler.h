#pragma once
#include <juce_audio_formats/juce_audio_formats.h>
#include <array>
#include <atomic>
#include <mutex>
#include <vector>
#include <cmath>

/** Resident one-shot pads. Loading, ownership and reclamation stay off the audio
 * thread; fixed voices and hazard pointers make MIDI triggers allocation-free. */
class PadSampler final {
public:
    static constexpr int slots=160, polyphony=32;
    static constexpr size_t memoryLimit=128*1024*1024;
    struct Clip {
        juce::AudioBuffer<float> audio;
        double rate=44100;
        juce::String name,path;
        size_t bytes() const {return (size_t)audio.getNumSamples()*audio.getNumChannels()*sizeof(float);}
    };
    bool assigned(int slot) const {return slot>=0&&slot<slots&&occupied[(size_t)slot].load();}
    int reserve(int slot) {return ++tickets[(size_t)slot];}
    void load(int slot,std::unique_ptr<juce::AudioFormatReader> reader,const juce::String& path,const juce::String& name,int ticket) {
        if(!reader||!std::isfinite(reader->sampleRate)||reader->sampleRate<=0||reader->lengthInSamples<2)throw std::runtime_error("Cannot decode this sample");
        const int channels=juce::jlimit(1,2,(int)reader->numChannels);
        if(reader->lengthInSamples>(juce::int64)(memoryLimit/(channels*sizeof(float))))throw std::runtime_error("Sample exceeds the 128 MiB pad-memory budget; trim it before importing");
        auto clip=std::make_unique<Clip>();clip->rate=reader->sampleRate;clip->name=name;clip->path=path;
        clip->audio.setSize(channels,(int)reader->lengthInSamples);
        if(!reader->read(&clip->audio,0,clip->audio.getNumSamples(),0,true,channels>1))throw std::runtime_error("Could not read the complete sample");
        for(int c=0;c<channels;++c)for(int i=0;i<clip->audio.getNumSamples();++i)if(!std::isfinite(clip->audio.getSample(c,i)))clip->audio.setSample(c,i,0);
        std::lock_guard<std::mutex> lock(mutex);
        if(ticket!=tickets[(size_t)slot].load())return;
        collect();size_t bytes=clip->bytes();
        const auto* replacing=published[(size_t)slot].load();
        for(const auto& old:retained)if(old.get()!=replacing||inUse(old.get()))bytes+=old->bytes();
        if(bytes>memoryLimit)throw std::runtime_error("Pad samples exceed the 128 MiB memory budget; remove or shorten a sample");
        auto* pointer=clip.get();retained.push_back(std::move(clip));published[(size_t)slot].store(pointer);occupied[(size_t)slot].store(true);
        descriptors[(size_t)slot]=descriptor(slot,path,name,pointer->audio.getNumSamples()/pointer->rate,true,{});
        ++revision;collect();
    }
    void clear(int slot) {
        std::lock_guard<std::mutex> lock(mutex);++tickets[(size_t)slot];published[(size_t)slot].store(nullptr);occupied[(size_t)slot].store(false);descriptors[(size_t)slot]=juce::var();++revision;collect();
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
        for(const auto& value:descriptors)if(value.isObject())pads.add(value.clone());return pads;
    }
    double tailSeconds() const {
        std::lock_guard<std::mutex> lock(mutex);double tail=0;for(const auto& value:descriptors)tail=juce::jmax(tail,(double)value["duration"]);return tail;
    }
    // Audio thread only. Even pending/missing assignments consume the pad hit,
    // so a temporarily unavailable sample can never accidentally create a cue.
    bool trigger(int slot,float velocity) {
        if(!assigned(slot))return false;
        int index=0;
        for(int i=0;i<polyphony;++i){if(!voices[(size_t)i].clip){index=i;break;}if(voices[(size_t)i].serial<voices[(size_t)index].serial)index=i;}
        auto& voice=voices[(size_t)index];Clip* clip=nullptr;
        do{clip=published[(size_t)slot].load();hazards[(size_t)index].store(clip);}while(clip!=published[(size_t)slot].load());
        const auto tail=voice.last;
        voice={};voice.clip=clip;voice.slot=slot;voice.gain=juce::jlimit(0.0f,1.0f,velocity);voice.serial=++serial;
        voice.tail=tail;voice.crossfade=32;
        return true;
    }
    void stopAll() {for(auto& voice:voices)if(voice.clip)voice.release=32;}
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
        value->setProperty("path",path);value->setProperty("name",name);value->setProperty("duration",duration);value->setProperty("ready",ready);value->setProperty("error",error);return juce::var(value);
    }
    bool inUse(const Clip* clip) const {for(const auto& hazard:hazards)if(hazard.load()==clip)return true;return false;}
    void collect() {
        retained.erase(std::remove_if(retained.begin(),retained.end(),[this](const auto& clip){
            if(inUse(clip.get()))return false;for(const auto& slot:published)if(slot.load()==clip.get())return false;return true;
        }),retained.end());
    }
    mutable std::mutex mutex;
    std::array<std::atomic<Clip*>,slots> published{};
    std::array<std::atomic<Clip*>,polyphony> hazards{};
    std::array<std::atomic<bool>,slots> occupied{};
    std::array<std::atomic<int>,slots> tickets{};
    std::array<juce::var,slots> descriptors;
    std::vector<std::unique_ptr<Clip>> retained;
    std::array<Voice,polyphony> voices;
    juce::uint64 serial=0;
};
