#ifndef _WIN32_WINNT
 #define _WIN32_WINNT 0x0a00
#endif
#include "NativePadInput.h"
#include <windows.h>
#include <algorithm>

namespace {
HWND nativeBrowser(juce::Component& browser){
    if(auto* view=juce::AccessibilityHandler::getNativeChildForComponent(browser))return (HWND)view;
    for(auto* child:browser.getChildren())if(auto view=nativeBrowser(*child))return view;
    return nullptr;
}
struct WindowsPadTouchState {
    std::shared_ptr<PadInputRouter> router;
    juce::Component::SafePointer<juce::Component> browser;
    bool enabled=true;
    bool down(HWND target,POINT screen,DWORD timestamp){
        if(!enabled||!browser||!browser->isShowing())return false;
        if(GetAsyncKeyState(VK_CONTROL)<0||GetAsyncKeyState(VK_MENU)<0||GetAsyncKeyState(VK_LWIN)<0||GetAsyncKeyState(VK_RWIN)<0)return false;
        const auto root=nativeBrowser(*browser);
        if(!root||!target||(target!=root&&!IsChild(root,target)))return false;
        wchar_t name[128]{};GetClassNameW(target,name,128);
        if(juce::String(name).indexOfIgnoreCase("Chrome_")<0)return false;
        RECT bounds{};GetClientRect(root,&bounds);POINT point=screen;ScreenToClient(root,&point);
        const double age=(DWORD)(GetTickCount()-timestamp);
        return router->pointerDown(point.x,point.y,bounds.right-bounds.left,bounds.bottom-bounds.top,true,juce::Time::currentTimeMillis()-age,age);
    }
};
struct Registry {
    HHOOK mouse=nullptr,messages=nullptr;
    DWORD lastInputTime=0;POINT lastInputPoint{};bool hasInput=false;
    std::vector<std::weak_ptr<WindowsPadTouchState>> states;
    ~Registry(){if(mouse)UnhookWindowsHookEx(mouse);if(messages)UnhookWindowsHookEx(messages);}
};
thread_local Registry registry;
bool dispatch(HWND target,POINT point,DWORD time){
    if(registry.hasInput&&time==registry.lastInputTime&&point.x==registry.lastInputPoint.x&&point.y==registry.lastInputPoint.y)return false;
    bool accepted=false;
    for(auto it=registry.states.begin();it!=registry.states.end();){if(auto state=it->lock()){accepted=state->down(target,point,time)||accepted;++it;}else it=registry.states.erase(it);}
    if(accepted){registry.hasInput=true;registry.lastInputTime=time;registry.lastInputPoint=point;}
    return accepted;
}
struct DpiScope {
    DPI_AWARENESS_CONTEXT previous=SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    ~DpiScope(){if(previous)SetThreadDpiAwarenessContext(previous);}
};
LRESULT CALLBACK mouseHook(int code,WPARAM action,LPARAM value){
    if(code==HC_ACTION&&action==WM_LBUTTONDOWN){
        const auto& event=*(const MSLLHOOKSTRUCT*)value;
        // Also observe the OS's promoted touch mouse-down: WebView2 may own
        // pointer messages on its renderer thread. Original events still pass.
        DpiScope dpi;dispatch(WindowFromPoint(event.pt),event.pt,event.time);
    }
    return CallNextHookEx(nullptr,code,action,value);
}
LRESULT CALLBACK messageHook(int code,WPARAM action,LPARAM value){
    if(code>=0&&action==PM_REMOVE){
        const auto& message=*(const MSG*)value;
        if(message.message==WM_POINTERDOWN){
            POINTER_INFO info{};
            if(GetPointerInfo(GET_POINTERID_WPARAM(message.wParam),&info)){DpiScope dpi;dispatch(message.hwnd,info.ptPixelLocation,info.dwTime);}
        }else if(message.message==WM_LBUTTONDOWN){
            DpiScope dpi;dispatch(message.hwnd,message.pt,message.time);
        }
    }
    return CallNextHookEx(nullptr,code,action,value);
}
class WindowsNativePadInput final:public NativePadInputMonitor {
public:
    WindowsNativePadInput(std::shared_ptr<PadInputRouter> router,juce::Component& browser):state(std::make_shared<WindowsPadTouchState>()){
        state->router=std::move(router);state->browser=&browser;registry.states.push_back(state);
        if(!registry.mouse){HMODULE module=nullptr;GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,(LPCWSTR)&mouseHook,&module);registry.mouse=SetWindowsHookExW(WH_MOUSE_LL,mouseHook,module,0);}
        if(!registry.messages)registry.messages=SetWindowsHookExW(WH_GETMESSAGE,messageHook,nullptr,GetCurrentThreadId());
    }
    ~WindowsNativePadInput() override {
        state->enabled=false;state.reset();
        registry.states.erase(std::remove_if(registry.states.begin(),registry.states.end(),[](const auto& value){return value.expired();}),registry.states.end());
        if(registry.states.empty()){if(registry.mouse)UnhookWindowsHookEx(registry.mouse);if(registry.messages)UnhookWindowsHookEx(registry.messages);registry.mouse=nullptr;registry.messages=nullptr;}
    }
    bool ready() const override {return (registry.mouse||registry.messages)&&state->browser&&nativeBrowser(*state->browser);}
private:std::shared_ptr<WindowsPadTouchState> state;
};
}
std::unique_ptr<NativePadInputMonitor> createNativePadInputMonitor(std::shared_ptr<PadInputRouter> router,juce::Component& browser){return std::make_unique<WindowsNativePadInput>(std::move(router),browser);}
