#pragma once
#include "FxPrimitives.h"
#include "EffectKernels.h"
#include <atomic>
#include <string_view>
#include <limits>
#include <cstdint>

namespace beatmaker::dsp {
enum class Effect {none,twelveBit,bitDecimator,bitCrash,centerCancel,delay,tapeEcho,echoBreak,oneShotDelay,freezeLooper,isolator,equalizer,subsonic,filterDrive,distortion,overdrive,fuzz,autopan,tremoloPan,ringMod,chorus,flanger,pitch,octave,chromPitchShift,pitchFine,duckComp,compressor,resonator,wah};
inline constexpr std::string_view effectNames[]={"none","twelveBit","bitDecimator","bitCrash","centerCancel","delay","tapeEcho","echoBreak","oneShotDelay","freezeLooper","isolator","equalizer","subsonic","filterDrive","distortion","overdrive","fuzz","autopan","tremoloPan","ringMod","chorus","flanger","pitch","octave","chromPitchShift","pitchFine","duckComp","compressor","resonator","wah"};
inline constexpr int effectCount=sizeof(effectNames)/sizeof(effectNames[0]);
inline int effectIndex(std::string_view name){for(int i=0;i<effectCount;++i)if(effectNames[i]==name)return i;return -1;}
inline bool levelled(Effect effect){
    switch(effect){
        case Effect::delay:case Effect::tapeEcho:case Effect::isolator:case Effect::equalizer:case Effect::subsonic:case Effect::filterDrive:
        case Effect::distortion:case Effect::overdrive:case Effect::fuzz:case Effect::tremoloPan:case Effect::ringMod:case Effect::chorus:
        case Effect::pitch:case Effect::octave:case Effect::chromPitchShift:case Effect::pitchFine:case Effect::compressor:case Effect::wah:return true;
        default:return false;
    }
}
struct FxState {
    bool enabled=false,padActive=true,multi=false,held=false;
    double x=0.5,y=0.5;
    std::array<Effect,4> effects{Effect::none,Effect::none,Effect::none,Effect::none};
};
// Single reader; callers serialize producers. Ownership swaps keep the audio
// reader's front buffer immutable, even during rapid parameter changes.
class FxStateExchange {
public:
    static_assert(std::atomic<unsigned>::is_always_lock_free,"FX control exchange must be lock-free");
    void publish(const FxState& state){values[back]=state;back=middle.exchange(back|4)&3;}
    bool consume(FxState& state){if(!(middle.load()&4))return false;front=middle.exchange(front)&3;state=values[front];return true;}
private:
    std::array<FxState,3> values{};
    std::atomic<unsigned> middle{1};unsigned front=0,back=2;
};
class FxSlot {
public:
    void prepare(double rate){sampleRate=rate;delay.prepare(rate);compressor.prepare(rate);reset();}
    void reset(){delay.reset();for(auto& filter:filters)filter.reset();compressor.reset();phase=0;}
    void configure(Effect type,double X,double Y,bool held){
        if(type!=effect){reset();effect=type;}
        x=X;y=Y;hold=held;
        if(type==Effect::isolator){filters[0].configure(Filter::highpass,(float)(20+200*x),sampleRate);filters[1].configure(Filter::lowpass,(float)(5000+15000*y),sampleRate);}
        if(type==Effect::equalizer){filters[0].configure(Filter::lowShelf,350,sampleRate,1,(float)(10*(x-0.5)));filters[1].configure(Filter::peaking,1000,sampleRate);filters[2].configure(Filter::highShelf,6000,sampleRate,1,(float)(10*(y-0.5)));}
        if(type==Effect::subsonic)filters[0].configure(Filter::lowpass,(float)(40+120*x),sampleRate);
        if(type==Effect::filterDrive)filters[0].configure(Filter::lowpass,(float)(300+15000*y),sampleRate);
        if(type==Effect::resonator)for(int i=0;i<3;++i)filters[(size_t)i].configure(Filter::bandpass,(float)((i+1)*400*(0.5+y)),sampleRate,10);
        if(type==Effect::duckComp)compressor.configure((float)(-60+30*x),30,12,0.003f,(float)(0.05+0.45*y));
        else compressor.configure(-12,10,4,0.01f,0.1f);
        double amount=0;
        if(type==Effect::filterDrive)amount=1+5*x;
        if(type==Effect::distortion)amount=1+2*x*5;
        if(type==Effect::overdrive)amount=1+4*x*5;
        if(type==Effect::fuzz)amount=1+8*x*5;
        if(amount)for(size_t i=0;i<curve.size();++i){const double v=i*2.0/curve.size()-1;curve[i]=(float)((1+amount)*v/(1+amount*std::abs(v)));}
    }
    Stereo process(Stereo input){
        for(auto& value:input)if(!std::isfinite(value))value=0;
        Stereo result=input;double frequency=0;
        const double wave=std::sin(2*pi*phase);
        switch(effect){
            case Effect::none:break;
            case Effect::twelveBit:for(auto& v:result)v=quantize(v,12);break;
            case Effect::bitDecimator:case Effect::bitCrash:for(auto& v:result)v=quantize(v,decimatorBits(x));break;
            case Effect::centerCancel:result={centerCancel(input[0],0,(float)x),centerCancel(input[1],1,(float)x)};break;
            case Effect::delay:case Effect::tapeEcho:case Effect::echoBreak:result=delay.process(input,(float)(0.05+0.45*y)*sampleRate,(float)x,true);break;
            case Effect::oneShotDelay:result=delay.process(input,(float)(0.05+0.45*y)*sampleRate,0,false);for(auto& v:result)v*=(float)x;break;
            case Effect::freezeLooper:result=delay.process(input,(float)(0.1+0.9*y)*sampleRate,hold?1:0,true);break;
            case Effect::chorus:frequency=(float)(0.2+5*y);result=delay.process(input,std::max(0.0,0.03+wave*(float)(0.002+0.02*x))*sampleRate,0,false);break;
            case Effect::flanger:frequency=(float)(0.1+5*y);result=delay.process(input,std::max(0.0,wave*(float)(0.001+0.009*x))*sampleRate,(float)(0.1+0.8*x),true);break;
            case Effect::pitch:case Effect::octave:case Effect::chromPitchShift:case Effect::pitchFine:frequency=(float)(0.5+5*y);result=delay.process(input,std::max(0.0,wave*(float)(0.002*x))*sampleRate,0,false);break;
            case Effect::isolator:result=filters[1].process(filters[0].process(input));break;
            case Effect::equalizer:result=filters[2].process(filters[1].process(filters[0].process(input)));break;
            case Effect::subsonic:result=filters[0].process(input);break;
            case Effect::filterDrive:result=filters[0].process(input);[[fallthrough]];
            case Effect::distortion:case Effect::overdrive:case Effect::fuzz:for(auto& v:result)v=shape(v);break;
            case Effect::autopan:frequency=(float)(0.5+8*y);result=stereoPan(input,wave*(float)x);break;
            case Effect::tremoloPan:frequency=(float)(0.5+10*y);result=stereoPan(input,wave*(float)x);break;
            case Effect::ringMod:frequency=(float)(50+1000*y);for(auto& v:result)v*=(float)(x+wave);break;
            case Effect::resonator:{result={};for(auto& filter:filters){const auto band=filter.process(input);for(size_t c=0;c<2;++c)result[c]+=band[c];}for(auto& v:result)v*=(float)x;break;}
            case Effect::wah:frequency=(float)(0.5+5*y);filters[0].configure(Filter::bandpass,std::max(0.0,350+wave*(float)(200+2000*x)),sampleRate);result=filters[0].process(input);break;
            case Effect::compressor:case Effect::duckComp:break;
        }
        phase+=frequency/sampleRate;phase-=std::floor(phase);
        if(levelled(effect)||effect==Effect::duckComp)result=compressor.process(result);
        return result;
    }
private:
    float shape(float value) const {const double pos=std::clamp(((double)value+1)*0.5*(curve.size()-1),0.0,(double)curve.size()-1);const size_t first=(size_t)pos,next=std::min(first+1,curve.size()-1);return (float)(curve[first]+(pos-first)*(curve[next]-curve[first]));}
    Effect effect=Effect::none;double sampleRate=44100,x=0.5,y=0.5,phase=0;bool hold=false;
    Delay delay;Dynamics compressor;std::array<Biquad,3> filters;std::array<float,1024> curve{};
};
class FxGraph {
public:
    void prepare(double rate){if(!std::isfinite(rate)||rate<2000||rate>768000)throw std::invalid_argument("Unsupported FX sample rate");sampleRate=rate;for(auto& slot:slots)slot.prepare(rate);master.prepare(rate);weights={};anchors={};anchorTimes={};clock=0;eventCount=0;state={};}
    void configure(const FxState& next){
        for(size_t i=0;i<4;++i)slots[i].configure(next.effects[i],next.x,next.y,next.held);
        if(next.enabled){
            if(!state.enabled){anchors={};anchorTimes.fill(clock);eventCount=0;}
            if(next.multi){
                const auto end=clock+(uint64_t)std::max(1,(int)std::lround(0.04*sampleRate));
                if(!state.multi||!state.enabled)schedule({0.25f,0.25f,0.25f,0.25f},end,true,15);
                schedule({(float)((1-next.x)*(1-next.y)),(float)(next.x*(1-next.y)),(float)((1-next.x)*next.y),(float)(next.x*next.y)},end,true,15);
            }else schedule({1,0,0,0},clock,false,state.multi||!state.enabled?15:1);
        }
        if(!next.enabled&&state.enabled){for(auto& slot:slots)slot.reset();master.reset();weights={};anchors={};eventCount=0;}
        state=next;
    }
    Stereo process(Stereo input,bool levelMaster=true){
        if(!state.enabled)return input;
        while(eventCount&&events[0].frame<=clock){const auto event=events[0];for(size_t i=0;i<4;++i)if(event.mask&(1u<<i)){anchors[i]=event.target[i];anchorTimes[i]=event.frame;}for(size_t i=1;i<eventCount;++i)events[i-1]=events[i];--eventCount;}
        weights=anchors;
        for(size_t i=0;i<4;++i)for(size_t e=0;e<eventCount;++e)if(events[e].mask&(1u<<i)){const auto& event=events[e];if(event.linear&&event.frame>anchorTimes[i])weights[i]=(float)(anchors[i]+((double)event.target[i]-anchors[i])*(double)(clock-anchorTimes[i])/(event.frame-anchorTimes[i]));break;}
        Stereo result{};
        for(size_t i=0;i<4;++i){const auto value=slots[i].process(state.padActive?input:Stereo{});for(size_t c=0;c<2;++c)result[c]+=weights[i]*value[c];}
        ++clock;
        const auto mixed=state.padActive?result:input;return levelMaster?master.process(mixed):mixed;
    }
    bool enabled() const{return state.enabled;}
    static int latency(const FxState& state,double rate){if(!state.enabled)return 0;bool second=false;if(state.padActive)for(size_t i=0;i<(state.multi?4:1);++i)second=second||levelled(state.effects[i])||state.effects[i]==Effect::duckComp;return (int)std::min(1023u,(unsigned)(0.006f*(float)rate))*(second?2:1);}
    static double tail(const FxState& state,double rate=44100){
        if(!state.enabled)return 0.003;
        double seconds=1.625;if(!state.padActive)return seconds;
        for(size_t i=0;i<(state.multi?4:1);++i){const auto type=state.effects[i];float feedback=0;double time=0;
            if(type==Effect::delay||type==Effect::tapeEcho||type==Effect::echoBreak){feedback=(float)state.x;time=0.05+0.45*state.y;}
            if(type==Effect::flanger){feedback=(float)(0.1+0.8*state.x);time=0.01;}
            if(type==Effect::freezeLooper){feedback=state.held?1:0;time=0.1+0.9*state.y;}
            if(feedback>=1)return std::numeric_limits<double>::infinity();
            if(time>0)seconds=std::max(seconds,(time+128/rate)*(feedback>0?std::ceil(std::log(1e-5)/std::log(feedback)):1)+0.012);
        }return seconds;
    }
private:
    struct WeightEvent {uint64_t frame=0;std::array<float,4> target{};bool linear=false;unsigned mask=15;};
    void schedule(std::array<float,4> target,uint64_t frame,bool linear,unsigned mask){
        if(eventCount==events.size())--eventCount;
        size_t pos=eventCount;while(pos&&events[pos-1].frame>frame){events[pos]=events[pos-1];--pos;}events[pos]={frame,target,linear,mask};++eventCount;
    }
    double sampleRate=44100;FxState state{};std::array<FxSlot,4> slots;Dynamics master;
    std::array<float,4> weights{},anchors{};std::array<uint64_t,4> anchorTimes{};uint64_t clock=0;
    std::array<WeightEvent,256> events{};size_t eventCount=0;
};
}
