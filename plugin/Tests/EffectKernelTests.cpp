#include <juce_core/juce_core.h>
#include "dsp/EffectKernels.h"
#include <iostream>
#include <cstring>
#include <limits>
#include <stdexcept>

static void check(bool ok,const char* text){if(!ok)throw std::runtime_error(text);}
int main(int argc,char** argv){
    try{
        using namespace beatmaker::dsp;
        check(quantize(-1.5f,1)==-1&&quantize(1.5f,1)==2,"JavaScript negative half-tie rounding differs");
        check(std::signbit(quantize(-0.5f,1))&&quantize(-0.5f,1)==0,"JavaScript negative zero differs");
        check(quantize(std::numeric_limits<float>::quiet_NaN(),12)==0,"Nonfinite audio must be contained");
        check(centerCancel(0.5f,0,0.25f)==0.125f&&centerCancel(0.5f,1,0.25f)==-0.125f,"Center-cancel stereo routing differs");
        check(decimatorBits(0)==12&&decimatorBits(1)==4&&decimatorBits(0.5)==8,"Legacy X-to-bit-depth mapping differs");
        int comparisons=0;
        if(argc==2){
            const auto fixture=juce::JSON::parse(juce::File(argv[1]).loadFileAsString());
            check(fixture.isArray(),"Missing reference fixtures");
            for(const auto& item:*fixture.getArray()){
                const auto kind=item["kind"].toString();const double amount=item["amount"];
                const auto type=kind=="twelveBit"?Kernel::twelveBit:kind=="bitCrash"?Kernel::bitCrash:Kernel::bitDecimator;
                const auto input=item["input"],expected=item["expected"];check(input.isArray()&&expected.isArray()&&input.size()==expected.size(),"Invalid reference vectors");
                for(int i=0;i<input.size();++i){
                    const auto bits=(juce::uint32)(juce::int64)input[i];float value=0;std::memcpy(&value,&bits,sizeof(value));
                    const float output=process(type,value,0,decimatorBits(amount),1);juce::uint32 actual=0;std::memcpy(&actual,&output,sizeof(output));
                    if(actual!=(juce::uint32)(juce::int64)expected[i]){std::cerr<<kind<<" amount="<<amount<<" sample="<<i<<" input="<<value<<" actual bits="<<actual<<" expected="<<expected[i].toString()<<"\n";throw std::runtime_error("Native output differs from the original AudioWorklet");}
                    ++comparisons;
                }
            }
        }
        std::cout<<"PASS: portable quantizer/phase kernels; "<<comparisons<<" bit-exact original-worklet comparisons\n";return 0;
    }catch(const std::exception& error){std::cerr<<"FAIL: "<<error.what()<<"\n";return 1;}
}
