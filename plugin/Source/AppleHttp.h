#pragma once
#include <juce_core/juce_core.h>
struct AppleHttpResult {
    int status=0;
    juce::StringPairArray headers;
    juce::MemoryBlock data;
};
AppleHttpResult appleHttp(const juce::String& url,const juce::String& method,const juce::String& headers,const juce::String& body,int timeoutSeconds,std::function<bool()> shouldCancel = {});
