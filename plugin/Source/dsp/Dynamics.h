#pragma once
// Adapted from WebKit's DynamicsCompressorKernel (Google, 2011).
// See WebKit-LICENSE.txt for the full BSD notices and pinned upstream revision.
#include <algorithm>
#include <array>
#include <cmath>

namespace beatmaker::dsp {
using Stereo=std::array<float,2>;
constexpr double pi=3.1415926535897932384626433832795;
inline float toDb(float x){return 20*std::log10(x);}
inline float fromDb(float x){return std::pow(10.0f,0.05f*x);}
class Dynamics {
public:
    void prepare(double rate){sampleRate=(float)rate;delayFrames=std::min(1023u,(unsigned)(0.006f*sampleRate));reset();configure(-12,10,4,0.01f,0.1f);}
    void reset(){for(auto& channel:delay)channel.fill(0);readIndex=0;writeIndex=delayFrames;detector=0;gain=1;maxAttack=-1;division=0;}
    unsigned latency() const{return delayFrames;}
    void configure(float threshold,float knee,float ratio,float attack,float release){
        if(threshold!=dbThreshold||knee!=dbKnee||ratio!=compressionRatio){
            dbThreshold=threshold;linearThreshold=fromDb(threshold);dbKnee=knee;compressionRatio=ratio;slope=1/ratio;
            float lo=0.1f,hi=10000,k=5;const float x=fromDb(threshold+knee);
            for(int i=0;i<15;++i){const float x2=x*1.001;const float m=(toDb(kneeCurve(x2,k))-toDb(kneeCurve(x,k)))/(toDb(x2)-toDb(x));if(m<slope)hi=k;else lo=k;k=std::sqrt(lo*hi);}
            curveK=k;kneeThresholdDb=threshold+knee;kneeThreshold=fromDb(kneeThresholdDb);yKneeDb=toDb(kneeCurve(kneeThreshold,k));
            makeup=std::pow(1/saturate(1),0.6f);
        }
        attackFrames=std::max(0.001f,attack)*sampleRate;satReleaseFrames=0.0025f*sampleRate;
        const float frames=std::max(0.00001f,release)*sampleRate;
        const float y1=frames*0.09f,y2=frames*0.16f,y3=frames*0.42f,y4=frames*0.98f;
        polynomial={0.9999999999999998f*y1+1.8432219684323923e-16f*y2-1.9373394351676423e-16f*y3+8.824516011816245e-18f*y4,
            -1.5788320352845888f*y1+2.3305837032074286f*y2-0.9141194204840429f*y3+0.1623677525612032f*y4,
            0.5334142869106424f*y1-1.272736789213631f*y2+0.9258856042207512f*y3-0.18656310191776226f*y4,
            0.08783463138207234f*y1-0.1694162967925622f*y2+0.08588057951595272f*y3-0.00429891410546283f*y4,
            -0.042416883008123074f*y1+0.1115693827987602f*y2-0.09764676325265872f*y3+0.028494263462021576f*y4};
    }
    Stereo process(Stereo input){
        if(division==0)beginDivision();
        for(int c=0;c<2;++c){if(!std::isfinite(input[(size_t)c]))input[(size_t)c]=0;delay[(size_t)c][writeIndex]=input[(size_t)c];}
        const float magnitude=std::max(std::abs(input[0]),std::abs(input[1]));
        const float attenuation=magnitude<=0.0001f?1:saturate(magnitude)/magnitude;
        const float releaseRate=fromDb(std::max(2.0f,-toDb(attenuation))/satReleaseFrames)-1;
        detector+=(attenuation-detector)*(attenuation>detector?releaseRate:1);detector=std::min(1.0f,detector);if(!std::isfinite(detector))detector=1;
        if(envelopeRate<1)gain+=(desired-gain)*envelopeRate;else gain=std::min(1.0f,gain*envelopeRate);
        const float total=makeup*std::sin(0.5f*(float)pi*gain);
        Stereo result{delay[0][readIndex]*total,delay[1][readIndex]*total};
        readIndex=(readIndex+1)&1023;writeIndex=(writeIndex+1)&1023;division=(division+1)&31;
        return result;
    }
private:
    float kneeCurve(float x,float k) const{return x<linearThreshold?x:linearThreshold+(1-std::exp(-k*(x-linearThreshold)))/k;}
    float saturate(float x) const{return x<kneeThreshold?kneeCurve(x,curveK):fromDb(yKneeDb+slope*(toDb(x)-kneeThresholdDb));}
    void beginDivision(){
        if(!std::isfinite(detector))detector=1;
        desired=std::asin(detector)/(0.5f*(float)pi);
        float difference=toDb(gain/desired);
        if(desired>gain){
            maxAttack=-1;if(!std::isfinite(difference))difference=-1;
            const float x=0.25f*(std::clamp(difference,-12.0f,0.0f)+12),x2=x*x,x3=x2*x,x4=x2*x2;
            const float frames=polynomial[0]+polynomial[1]*x+polynomial[2]*x2+polynomial[3]*x3+polynomial[4]*x4;
            envelopeRate=fromDb(5/frames);
        }else{
            if(!std::isfinite(difference))difference=1;
            if(maxAttack==-1||maxAttack<difference)maxAttack=difference;
            envelopeRate=1-std::pow(0.25f/std::max(0.5f,maxAttack),1/attackFrames);
        }
    }
    float sampleRate=44100,dbThreshold=999,dbKnee=999,compressionRatio=-1,linearThreshold=0,slope=1;
    float kneeThreshold=1,kneeThresholdDb=0,yKneeDb=0,curveK=1,makeup=1,attackFrames=441,satReleaseFrames=110;
    float detector=0,gain=1,maxAttack=-1,desired=0,envelopeRate=0;
    std::array<float,5> polynomial{};
    std::array<std::array<float,1024>,2> delay{};
    unsigned delayFrames=256,readIndex=0,writeIndex=256,division=0;
};
}
