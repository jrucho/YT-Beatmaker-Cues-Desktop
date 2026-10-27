#pragma once
#include <cmath>

// Platform-independent kernels. No JUCE, browser, allocation or file/bridge IO.
// Keep these semantics aligned with the original worklets before routing a UI
// effect through a native backend.
namespace beatmaker::dsp {
inline float quantize(float input,int bits) noexcept {
    if(!std::isfinite(input))return 0;
    bits=bits<1?1:bits>24?24:bits;
    const double step=1.0/((1u<<bits)-1u);
    // JavaScript Math.round rounds negative half ties toward +infinity, unlike
    // std::round. Preserve its negative zero as well.
    const double rounded=std::floor((double)input/step+0.5);
    return rounded==0?std::copysign(0.0f,input):(float)(rounded*step);
}
inline int decimatorBits(double amount) noexcept {
    if(!std::isfinite(amount))amount=0;
    amount=amount<0?0:amount>1?1:amount;
    return 4+(int)std::floor(8*(1-amount)+0.5);
}
inline float centerCancel(float input,int channel,float amount) noexcept {
    // The legacy graph preserves L and inverts R; its name does not imply a
    // mono subtraction bus. Reproduce the existing stereo routing exactly.
    return (channel==1?-input:input)*amount;
}
enum class Kernel {none,bitDecimator,bitCrash,twelveBit,centerCancel};
inline float process(Kernel kind,float input,int channel,int bits,float amount) noexcept {
    switch(kind){
        case Kernel::bitDecimator:case Kernel::bitCrash:return quantize(input,bits);
        case Kernel::twelveBit:return quantize(input,12);
        case Kernel::centerCancel:return centerCancel(input,channel,amount);
        default:return input;
    }
}
}
