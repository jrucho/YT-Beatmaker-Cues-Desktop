// Exercise the actual patched JUCE shutdown with deterministic waitpid results.
#include <cerrno>
#include <csignal>
#include <cstddef>
#include <cstdlib>
#include <iostream>
#include <sys/wait.h>
#include <utility>
#include <vector>

namespace {
constexpr pid_t childPid=42;
struct Wait{int options;pid_t result;int error=0,status=0;};
std::vector<Wait> waits;
std::size_t nextWait;
int expectedSignals,signalError,signals,sleeps;
const char* testName;

void check(bool ok,const char* message){
    if(!ok){std::cerr<<"FAIL: "<<testName<<": "<<message<<"\n";std::exit(1);}
}

struct Thread{
    static void sleep(int milliseconds){
        check(milliseconds==100&&++sleeps<=15,"unbounded wait for the browser helper");
    }
};

struct Browser{
    pid_t childProcess=childPid;
    const void* xembed=this;

    static pid_t waitpid(pid_t pid,int* status,int options){
        check(pid==childPid&&nextWait<waits.size(),"waited again after the helper exited");
        const auto& wait=waits[nextWait++];
        check(options==wait.options,"unexpected waitpid mode");
        if(status!=nullptr)*status=wait.status;
        errno=wait.error;
        return wait.result;
    }

    static int kill(pid_t pid,int signal){
        check(pid==childPid&&signal==SIGKILL&&++signals<=expectedSignals,"unexpected signal to the helper");
        errno=signalError;
        return signalError==0?0:-1;
    }

#include "LinuxWebViewChildShutdown.h"
};

void test(const char* name,std::vector<Wait> replies,int sleepCount,int signalCount=0,int error=0){
    testName=name;
    waits=std::move(replies);nextWait=0;
    signals=0;sleeps=0;expectedSignals=signalCount;signalError=error;
    Browser browser;
    browser.killChild();
    browser.killChild(); // A completed shutdown is a no-op when called again.
    check(browser.childProcess==0&&browser.xembed==nullptr,"browser helper was not cleared");
    check(nextWait==waits.size()&&signals==signalCount&&sleeps==sleepCount,"shutdown did not follow the expected path");
    std::cout<<"PASS: "<<name<<"\n";
}
}

int main(){
    test("normally exiting WebKit helper",{{WNOHANG,0},{WNOHANG,childPid}},1);
    test("signal-terminated WebKit helper",{{WNOHANG,childPid,0,SIGTERM}},0);
    test("WebKit helper already reaped by the host",{{WNOHANG,-1,ECHILD}},0);
    test("interrupted wait before exit",{{WNOHANG,-1,EINTR},{WNOHANG,childPid}},0);

    std::vector<Wait> stuck(16,{WNOHANG,0});
    auto interrupted=stuck;
    interrupted.push_back({0,-1,EINTR});
    interrupted.push_back({0,childPid,0,SIGKILL});
    test("unresponsive WebKit helper is stopped and reaped once",std::move(interrupted),15,1);
    stuck.push_back({0,-1,ECHILD});
    test("WebKit helper exits during forced shutdown",std::move(stuck),15,1,ESRCH);
}
