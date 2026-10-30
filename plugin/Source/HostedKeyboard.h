#pragma once
#include <juce_gui_basics/juce_gui_basics.h>
#include <memory>
class CueProcessor;

/** Desktop host key routing, independent of asynchronous browser key handling. */
class HostedKeyboard {
public:
    virtual ~HostedKeyboard()=default;
    virtual void setUiState(bool editing,bool padsActive)=0;
    virtual juce::var diagnostics() const=0;
};
#if JUCE_MAC
std::unique_ptr<HostedKeyboard> createHostedKeyboard(CueProcessor&,juce::Component&);
#else
inline std::unique_ptr<HostedKeyboard> createHostedKeyboard(CueProcessor&,juce::Component&){return {};}
#endif
