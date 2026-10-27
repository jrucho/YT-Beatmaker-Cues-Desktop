#pragma once
#include <chrono>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#ifdef _WIN32
 #ifndef NOMINMAX
  #define NOMINMAX
 #endif
 #include <windows.h>
#else
 #include <cerrno>
 #include <fcntl.h>
 #include <unistd.h>
#endif

// Shared protocol for native stores and Electron's tiny lock-holder child.
// The persistent file is never unlinked: kernel locks are released on crashes.
class LibraryFileLock final {
public:
    explicit LibraryFileLock(std::string path):name(std::move(path)),mutex(mutexFor(name)){}
    LibraryFileLock(const LibraryFileLock&)=delete;
    LibraryFileLock& operator=(const LibraryFileLock&)=delete;
    ~LibraryFileLock(){exit();}
    bool enter(int timeoutMs=5000){
        if(held)return false;
        const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(timeoutMs);
        if(!mutex->try_lock_until(deadline))return false;
       #ifdef _WIN32
        const int length=MultiByteToWideChar(CP_UTF8,0,name.c_str(),-1,nullptr,0);
        std::wstring wide((size_t)length,L'\0');MultiByteToWideChar(CP_UTF8,0,name.c_str(),-1,wide.data(),length);
        handle=CreateFileW(wide.c_str(),GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
        if(handle==INVALID_HANDLE_VALUE){mutex->unlock();return false;}
       #else
        handle=::open(name.c_str(),O_CREAT|O_RDWR,0600);
        if(handle<0){mutex->unlock();return false;}
       #endif
        do{
           #ifdef _WIN32
            OVERLAPPED overlapped{};
            if(LockFileEx(handle,LOCKFILE_EXCLUSIVE_LOCK|LOCKFILE_FAIL_IMMEDIATELY,0,1,0,&overlapped)){held=true;return true;}
            if(GetLastError()!=ERROR_LOCK_VIOLATION)break;
           #else
            struct flock request{};request.l_type=F_WRLCK;request.l_whence=SEEK_SET;request.l_len=1;
            if(::fcntl(handle,F_SETLK,&request)==0){held=true;return true;}
            if(errno!=EAGAIN&&errno!=EACCES&&errno!=EINTR)break;
           #endif
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }while(std::chrono::steady_clock::now()<deadline);
        closeHandle();mutex->unlock();return false;
    }
    void exit(){if(held){closeHandle();held=false;mutex->unlock();}}
private:
    static std::shared_ptr<std::timed_mutex> mutexFor(const std::string& path){
        static std::mutex guard;static std::map<std::string,std::weak_ptr<std::timed_mutex>> locks;
        std::lock_guard<std::mutex> lock(guard);
        for(auto it=locks.begin();it!=locks.end();)if(it->second.expired())it=locks.erase(it);else ++it;
        auto& weak=locks[path];auto result=weak.lock();if(!result){result=std::make_shared<std::timed_mutex>();weak=result;}return result;
    }
    void closeHandle(){
       #ifdef _WIN32
        if(handle!=INVALID_HANDLE_VALUE){CloseHandle(handle);handle=INVALID_HANDLE_VALUE;}
       #else
        if(handle>=0){::close(handle);handle=-1;}
       #endif
    }
    std::string name;
    std::shared_ptr<std::timed_mutex> mutex;
    bool held=false;
   #ifdef _WIN32
    HANDLE handle=INVALID_HANDLE_VALUE;
   #else
    int handle=-1;
   #endif
};
