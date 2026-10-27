#pragma once
#include "Dynamics.h"
#include <vector>
#include <stdexcept>

namespace beatmaker::dsp {
class Delay {
public:
    void prepare(double rate){buffer.resize((size_t)std::ceil(rate)+2);reset();}
    void reset(){head=0;valid=0;feedbackHead=0;for(auto& frame:feedbackHistory)frame={};}
    Stereo process(Stereo input,double frames,float feedback,bool cyclic){
        frames=std::clamp((double)(float)frames,0.0,(double)buffer.size()-2);
        // The original Web Audio feedback connection contributes one render
        // quantum. The DelayNode itself may still have zero delay (flanger).
        if(cyclic)for(size_t c=0;c<2;++c)input[c]+=feedback*feedbackHistory[feedbackHead][c];
        const int first=(int)frames;const float fraction=(float)(frames-first);
        const auto at=[&](int age){if(age==0)return input;if((size_t)age>valid)return Stereo{};return buffer[(head+buffer.size()-(size_t)age)%buffer.size()];};
        const auto a=at(first),b=at(first+1);Stereo result{};
        for(int c=0;c<2;++c){result[(size_t)c]=a[(size_t)c]+fraction*(b[(size_t)c]-a[(size_t)c]);buffer[head][(size_t)c]=input[(size_t)c];}
        if(cyclic){feedbackHistory[feedbackHead]=result;feedbackHead=(feedbackHead+1)&127;}
        head=(head+1)%buffer.size();valid=std::min(valid+1,buffer.size()-1);return result;
    }
private:
    std::vector<Stereo> buffer;
    size_t head=0,valid=0;
    std::array<Stereo,128> feedbackHistory{};unsigned feedbackHead=0;
};
enum class Filter {lowpass,highpass,bandpass,lowShelf,highShelf,peaking};
class Biquad {
public:
    void reset(){x1={};x2={};y1={};y2={};}
    void configure(Filter type,double frequency,double rate,double q=1,double gain=0){
        const double f=std::clamp(frequency/(rate*0.5),0.0,1.0);
        if(f==0||f==1){
            double value=1;
            if(type==Filter::lowpass)value=f==1?1:0;
            if(type==Filter::highpass)value=f==0?1:0;
            if(type==Filter::bandpass)value=0;
            if(type==Filter::lowShelf&&f==1)value=std::pow(10.0,gain/20);
            if(type==Filter::highShelf&&f==0)value=std::pow(10.0,gain/20);
            coefficients(value,0,0,1,0,0);return;
        }
        const double w=pi*f,s=std::sin(w),c=std::cos(w),A=std::pow(10.0,gain/40);
        double alpha=s/(2*std::max(1e-12,q));
        if(type==Filter::lowpass||type==Filter::highpass)alpha=s/(2*std::pow(10.0,0.05*q));
        switch(type){
            case Filter::lowpass:coefficients((1-c)/2,1-c,(1-c)/2,1+alpha,-2*c,1-alpha);break;
            case Filter::highpass:coefficients((1+c)/2,-1-c,(1+c)/2,1+alpha,-2*c,1-alpha);break;
            case Filter::bandpass:coefficients(alpha,0,-alpha,1+alpha,-2*c,1-alpha);break;
            case Filter::peaking:coefficients(1+alpha*A,-2*c,1-alpha*A,1+alpha/A,-2*c,1-alpha/A);break;
            case Filter::lowShelf:{const double k=std::sqrt(2*A)*s;coefficients(A*(A+1-(A-1)*c+k),2*A*(A-1-(A+1)*c),A*(A+1-(A-1)*c-k),A+1+(A-1)*c+k,-2*(A-1+(A+1)*c),A+1+(A-1)*c-k);break;}
            case Filter::highShelf:{const double k=std::sqrt(2*A)*s;coefficients(A*(A+1+(A-1)*c+k),-2*A*(A-1+(A+1)*c),A*(A+1+(A-1)*c-k),A+1-(A-1)*c+k,2*(A-1-(A+1)*c),A+1-(A-1)*c-k);break;}
        }
    }
    Stereo process(Stereo input){
        Stereo result{};
        for(size_t c=0;c<2;++c){const double value=b0*input[c]+b1*x1[c]+b2*x2[c]-a1*y1[c]-a2*y2[c];x2[c]=x1[c];x1[c]=input[c];y2[c]=y1[c];y1[c]=value;result[c]=(float)value;}
        return result;
    }
private:
    void coefficients(double B0,double B1,double B2,double A0,double A1,double A2){b0=B0/A0;b1=B1/A0;b2=B2/A0;a1=A1/A0;a2=A2/A0;}
    double b0=1,b1=0,b2=0,a1=0,a2=0;
    std::array<double,2> x1{},x2{},y1{},y2{};
};
inline Stereo stereoPan(Stereo input,double pan){
    pan=std::clamp(pan,-1.0,1.0);
    if(pan<=0){const double theta=(pan+1)*pi/2;return {(float)(input[0]+input[1]*std::cos(theta)),(float)(input[1]*std::sin(theta))};}
    const double theta=pan*pi/2;return {(float)(input[0]*std::cos(theta)),(float)(input[1]+input[0]*std::sin(theta))};
}
}
