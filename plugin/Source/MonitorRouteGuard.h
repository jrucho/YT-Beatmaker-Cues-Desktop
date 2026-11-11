#pragma once
#include <juce_core/juce_core.h>

/** Message-thread route ownership; the audio callback reads only the final gate.
 * A disconnected interface must never become live microphone/speaker monitoring.
 */
class MonitorRouteGuard {
public:
    void restore(bool enabled,const juce::var& route){wanted=enabled;inputs=read(route["inputs"]);outputs=read(route["outputs"]);if(!wanted){inputs.clear();outputs.clear();}}
    void configure(bool enabled,const juce::StringArray& in,const juce::StringArray& out,bool rebind=false){
        if(!enabled){wanted=false;inputs.clear();outputs.clear();return;}
        if(!wanted||rebind){inputs=in;outputs=out;}wanted=true;
    }
    bool update(const juce::StringArray& in,const juce::StringArray& out,bool ready){
        if(!wanted||!ready||!containsAll(in,inputs)||!containsAll(out,outputs))return false;
        // An automatic route can acquire an interface after monitoring was enabled.
        if(inputs.isEmpty())inputs=in;if(outputs.isEmpty())outputs=out;return true;
    }
    bool requested() const{return wanted;}
    juce::var route() const{auto* result=new juce::DynamicObject;result->setProperty("inputs",array(inputs));result->setProperty("outputs",array(outputs));return juce::var(result);}
private:
    static bool containsAll(const juce::StringArray& actual,const juce::StringArray& expected){for(const auto& id:expected)if(!actual.contains(id))return false;return true;}
    static juce::StringArray read(const juce::var& value){juce::StringArray result;if(auto* items=value.getArray())for(const auto& item:*items)if(item.isString()&&item.toString().isNotEmpty())result.addIfNotAlreadyThere(item.toString());return result;}
    static juce::var array(const juce::StringArray& values){juce::Array<juce::var> result;for(const auto& value:values)result.add(value);return juce::var(result);}
    bool wanted=false;juce::StringArray inputs,outputs;
};
