// Exercise JUCE's actual Linux pipe framing without GTK, a display or a DAW.
// CMake extracts CommandReceiver from the patched dependency, not a test copy.
#include <juce_core/juce_core.h>
#include <cerrno>
#include <cstring>
#include <iostream>
#include <limits>
#include <vector>
#include <fcntl.h>
#include <unistd.h>

namespace {
std::vector<char> wire;
size_t writeLimit=std::numeric_limits<size_t>::max(),readLimit=17,readPosition=0;
bool interruptWrite=false;
int writeCalls=0;

ssize_t transportWrite(int,const void* data,size_t size){
    ++writeCalls;
    if(std::exchange(interruptWrite,false)){errno=EINTR;return -1;}
    const auto count=std::min(size,writeLimit);
    const auto* bytes=static_cast<const char*>(data);
    wire.insert(wire.end(),bytes,bytes+count);
    return static_cast<ssize_t>(count);
}
ssize_t transportRead(int,void* data,size_t size){
    if(readPosition==wire.size()){errno=EAGAIN;return -1;}
    const auto count=std::min({size,readLimit,wire.size()-readPosition});
    std::memcpy(data,wire.data()+readPosition,count);readPosition+=count;
    return static_cast<ssize_t>(count);
}
}

#define write transportWrite
#define read transportRead
namespace juce {
#include "LinuxWebViewCommandReceiver.h"
}
#undef read
#undef write

namespace {
struct Responder final:juce::CommandReceiver::Responder{
    int messages=0,errors=0;
    juce::String command;
    juce::var payload;
    void handleCommand(const juce::String& cmd,const juce::var& value)override{++messages;command=cmd;payload=value;}
    void receiverHadError()override{++errors;}
};

bool check(const char* name,const juce::String& text,size_t limit,bool interrupt){
    wire.clear();readPosition=0;writeLimit=limit;interruptWrite=interrupt;writeCalls=0;
    juce::CommandReceiver::sendCommand(-1,"invokeCallback",text);
    if(wire.size()<sizeof(size_t)){std::cerr<<"FAIL: "<<name<<": missing header\n";return false;}
    size_t announced=0;std::memcpy(&announced,wire.data(),sizeof(announced));
    if(announced!=wire.size()-sizeof(size_t)){std::cerr<<"FAIL: "<<name<<": short frame\n";return false;}
    juce::var frame;
    if(!juce::JSON::parse(juce::String::fromUTF8(wire.data()+sizeof(size_t),static_cast<int>(announced)),frame)
       ||frame["params"].toString()!=text){
        std::cerr<<"FAIL: "<<name<<": UTF-8/JSON payload corrupted\n";return false;
    }
    int channels[2];
    if(pipe(channels)!=0){std::cerr<<"FAIL: pipe\n";return false;}
    Responder responder;
    {
        juce::CommandReceiver receiver(&responder,channels[0]);
        receiver.tryNextRead();
    }
    close(channels[0]);close(channels[1]);
    if(responder.messages!=1||responder.errors!=0||responder.command!="invokeCallback"||responder.payload.toString()!=text){
        std::cerr<<"FAIL: "<<name<<": fragmented receive failed\n";return false;
    }
    std::cout<<"PASS: "<<name<<" ("<<announced<<" bytes, "<<writeCalls<<" writes)\n";
    return true;
}
}

int main(){
    const auto unicode=juce::String::fromUTF8("日本語 · 🎵 ' \" \\");
    bool passed=true;
    passed=check("ASCII baseline","library snapshot",std::numeric_limits<size_t>::max(),false)&&passed;
    passed=check("Unicode frame",unicode,std::numeric_limits<size_t>::max(),false)&&passed;
    passed=check("short writes","complete every byte",7,false)&&passed;
    passed=check("interrupted short writes",unicode,7,true)&&passed;
    passed=check("large Unicode library",juce::String::repeatedString(unicode,16384),4093,true)&&passed;
    return passed?0:1;
}
