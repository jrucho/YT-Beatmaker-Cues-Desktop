#include "../../plugin/Source/FileLock.h"
#include <iostream>
int hold(const std::string& path){
    LibraryFileLock lock(path);
    if(!lock.enter())return 3;
    std::cout<<"locked\n"<<std::flush;
    char byte;while(std::cin.get(byte)){}
    return 0;
}
#ifdef _WIN32
int wmain(int argc,wchar_t** argv){
    if(argc!=2)return 2;
    const int size=WideCharToMultiByte(CP_UTF8,0,argv[1],-1,nullptr,0,nullptr,nullptr);
    std::string path((size_t)size,'\0');WideCharToMultiByte(CP_UTF8,0,argv[1],-1,path.data(),size,nullptr,nullptr);path.pop_back();return hold(path);
}
#else
int main(int argc,char** argv){
    if(argc!=2)return 2;
    return hold(argv[1]);
}
#endif
