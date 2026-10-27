#include <juce_core/juce_core.h>
#include "dsp/FxGraph.h"
#include <fstream>
#include <iostream>
#include <cstring>
#include <stdexcept>
#include <thread>

static void check(bool ok,const char* message){if(!ok)throw std::runtime_error(message);}
int main(int argc,char** argv){
    try{
        using namespace beatmaker::dsp;
        if(argc==4&&juce::String(argv[1])=="--render"){
            const auto request=juce::JSON::parse(juce::File(argv[2]).loadFileAsString());
            const double rate=request["sampleRate"],x=request["x"],y=request["y"];const bool held=request["held"];
            FxState state;state.enabled=true;state.x=x;state.y=y;state.held=held;state.multi=(bool)request["multi"];state.padActive=!request.hasProperty("padActive")||(bool)request["padActive"];
            for(int i=0;i<4;++i){const auto name=request["effects"][i].toString().toStdString();const int kind=effectIndex(name);check(kind>=0,"Unsupported reference effect");state.effects[(size_t)i]=(Effect)kind;}
            FxGraph graph;graph.prepare(rate);graph.configure(state);FxSlot slot;slot.prepare(rate);slot.configure(state.effects[0],x,y,held);
            const bool single=request["mode"].toString()=="slot";
            const auto left=request["input"][0],right=request["input"][1];check(left.isArray()&&right.isArray()&&left.size()==right.size(),"Invalid stereo reference input");
            std::ofstream output(juce::File(argv[3]).getFullPathName().toStdString(),std::ios::binary);
            int updateIndex=0;const auto updates=request["updates"];
            for(int i=0;i<left.size();++i){
                if(updates.isArray()&&updateIndex<updates.size()&&(int)updates[updateIndex]["frame"]==i){const auto update=updates[updateIndex++];if(update.hasProperty("x"))state.x=(double)update["x"];if(update.hasProperty("y"))state.y=(double)update["y"];if(update.hasProperty("multi"))state.multi=(bool)update["multi"];if(update.hasProperty("padActive"))state.padActive=(bool)update["padActive"];graph.configure(state);slot.configure(state.effects[0],state.x,state.y,state.held);}
                Stereo frame{};for(int c=0;c<2;++c){const auto bits=(juce::uint32)(juce::int64)(c==0?left[i]:right[i]);std::memcpy(&frame[(size_t)c],&bits,4);}const auto result=single?slot.process(frame):graph.process(frame,!(bool)request["skipMaster"]);output.write((const char*)result.data(),sizeof(result));
            }
            check(output.good(),"Cannot write native FX reference output");return 0;
        }
        Delay delay;delay.prepare(48000);
        for(int n=0;n<1000;++n){const auto out=delay.process(n==0?Stereo{1,-0.5f}:Stereo{},240.5,0,false);const float expected=n==240||n==241?0.5f:0;check(out[0]==expected&&out[1]==-0.5f*expected,"Fractional stereo delay impulse is wrong");}
        delay.reset();for(int n=0;n<600;++n){const auto out=delay.process(n==0?Stereo{1,0}:Stereo{},128,0.5,true);if(n==128)check(out[0]==1,"Feedback delay first echo is wrong");if(n==384)check(out[0]==0.5f,"Feedback delay quantum/decay is wrong");}
        delay.reset();check(delay.process({},128,0.5,true)[0]==0,"Delay reset exposed old ring-buffer data");
        FxGraph graph;graph.prepare(48000);const Stereo dry{0.25f,-0.5f};check(graph.process(dry)==dry,"Disabled graph must bypass exactly");
        FxState state;state.enabled=true;state.effects[0]=Effect::delay;check(FxGraph::latency(state,48000)==576,"Nested leveler look-ahead was not reported");
        state.effects[0]=Effect::none;check(FxGraph::latency(state,48000)==288,"Master leveler look-ahead was not reported");
        FxStateExchange exchange;for(int i=0;i<100;++i){state.x=i/100.0;exchange.publish(state);}FxState latest;check(exchange.consume(latest)&&latest.x==0.99&&!exchange.consume(latest),"Control snapshots did not retain the latest update");
        {
            FxStateExchange controls;std::atomic<bool> done{false};
            std::thread producer([&]{for(int i=0;i<100000;++i){FxState update;update.x=i;update.y=-i;update.multi=i%2;controls.publish(update);}done.store(true);});
            bool coherent=true;while(!done.load()){FxState value;if(controls.consume(value))coherent=coherent&&value.x==-value.y&&value.multi==((int)value.x%2!=0);}
            producer.join();check(coherent,"Concurrent UI/audio snapshots were torn");
        }
        for(int kind=0;kind<effectCount;++kind){FxSlot effect;effect.prepare(48000);effect.configure((Effect)kind,0.7,0.3,true);double energy=0;for(int i=0;i<32768;++i){const auto frame=effect.process(i==0?Stereo{1,-0.5}:Stereo{});for(const float v:frame){check(std::isfinite(v),"Effect produced nonfinite output");energy+=v*v;}}check(std::isfinite(energy),"Effect energy is invalid");}
        std::cout<<"PASS: portable FX stages, fractional/feedback delay, bounded reset, latency, coherent controls and finite output for "<<effectCount<<" effect identifiers\n";return 0;
    }catch(const std::exception& error){std::cerr<<"FAIL: "<<error.what()<<"\n";return 1;}
}
