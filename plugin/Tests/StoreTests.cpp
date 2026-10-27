#include "LibraryStore.h"
#include <iostream>
#include <stdexcept>
#include <thread>

void check(bool value,const char* text){if(!value)throw std::runtime_error(text);}
juce::var parse(const char* text){return juce::JSON::parse(text);}
int main(int argc,char** argv){
    try{
        if(argc==4&&juce::String(argv[1])=="--shared-read"){LibraryStore store{juce::File(argv[2]),juce::File(argv[3])};std::cout<<store.readLibrary();return 0;}
        if(argc==5&&juce::String(argv[1])=="--commit"){LibraryStore store{juce::File(argv[2])};std::cout<<store.commitLibrary(juce::File(argv[3]).loadFileAsString(),juce::File(argv[4]).loadFileAsString());return 0;}
        if(argc==6&&juce::String(argv[1])=="--shared-writer"){
            LibraryStore store{juce::File(argv[2]),juce::File(argv[3])};
            for(int i=0;i<juce::String(argv[5]).getIntValue();++i){
                const auto base=store.readLibrary();auto next=juce::JSON::parse(base);
                auto* item=new juce::DynamicObject;item->setProperty("id",juce::String(argv[4])+juce::String(i));item->setProperty("name","Native playlist");item->setProperty("createdAt",1);item->setProperty("updatedAt",1);item->setProperty("tracks",juce::Array<juce::var>{});
                next["playlists"].getArray()->add(juce::var(item));store.commitLibrary(base,juce::JSON::toString(next));
            }return 0;
        }
        if(argc==5&&juce::String(argv[1])=="--writer"){
            LibraryStore store{juce::File(argv[2])};
            for(int i=0;i<juce::String(argv[4]).getIntValue();++i){
                const auto before=store.readLibrary();auto next=juce::JSON::parse(before);
                auto* item=new juce::DynamicObject;item->setProperty("id",juce::String(argv[3])+juce::String(i));item->setProperty("name","Playlist");item->setProperty("tracks",juce::Array<juce::var>{});
                next["playlists"].getArray()->add(juce::var(item));
                store.commitLibrary(before,juce::JSON::toString(next));
            }
            return 0;
        }
        const auto directory=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("beatmaker-store-test",{});
        directory.createDirectory();
        struct Cleanup{juce::File path;~Cleanup(){path.deleteRecursively();}}cleanup{directory};
        LibraryStore store(directory);
        const auto original=store.readLibrary();
        auto first=parse(R"({"favorites":[],"history":[],"playlists":[{"id":"playlistA","name":"Original","tracks":[]}]})");
        store.commitLibrary(original,juce::JSON::toString(first));
        const auto base=store.readLibrary();
        auto renamed=juce::JSON::parse(base);renamed["playlists"][0].getDynamicObject()->setProperty("name","Renamed");
        auto added=juce::JSON::parse(base);added["playlists"][0]["tracks"].getArray()->add(parse(R"({"id":"track000001","title":"Kept local reference","localPath":"/missing/song.wav"})"));
        store.commitLibrary(base,juce::JSON::toString(renamed));
        const auto merged=juce::JSON::parse(store.commitLibrary(base,juce::JSON::toString(added)));
        check(merged["playlists"][0]["name"].toString()=="Renamed","Concurrent rename lost");
        check(merged["playlists"][0]["tracks"].size()==1,"Concurrent track edit lost");
        check(merged["playlists"][0]["tracks"][0]["localPath"].toString()=="/missing/song.wav","Missing media reference deleted");
        const auto executable=juce::File::getSpecialLocation(juce::File::currentExecutableFile).getFullPathName();
        juce::ChildProcess a,b;
        check(a.start(juce::StringArray{executable,"--writer",directory.getFullPathName(),"a-","30"}),"Writer A failed to start");
        check(b.start(juce::StringArray{executable,"--writer",directory.getFullPathName(),"b-","30"}),"Writer B failed to start");
        check(a.waitForProcessToFinish(30000)&&b.waitForProcessToFinish(30000)&&a.getExitCode()==0&&b.getExitCode()==0,"Concurrent writers failed");
        check(juce::JSON::parse(store.readLibrary())["playlists"].size()==61,"Concurrent playlist additions lost");
        LibraryStore reopened(directory);check(juce::JSON::parse(reopened.readLibrary())["playlists"].size()==61,"Cold reopen lost library");
        {
            const auto threaded=directory.getChildFile("threaded");std::atomic<bool> failed{false};std::array<std::thread,8> writers;
            for(int n=0;n<8;++n)writers[(size_t)n]=std::thread([&,n]{try{LibraryStore own(threaded);for(int i=0;i<6;++i){const auto base=own.readLibrary();auto edit=juce::JSON::parse(base);auto* item=new juce::DynamicObject;item->setProperty("id","thread-"+juce::String(n)+"-"+juce::String(i));item->setProperty("tracks",juce::Array<juce::var>{});edit["playlists"].getArray()->add(juce::var(item));own.commitLibrary(base,juce::JSON::toString(edit));}}catch(const std::exception& error){std::cerr<<"Threaded store: "<<error.what()<<"\n";failed.store(true);}});
            for(auto& thread:writers)thread.join();LibraryStore cold(threaded);
            const auto count=juce::JSON::parse(cold.readLibrary())["playlists"].size();if(count!=48)std::cerr<<"Threaded store count: "<<count<<"\n";
            check(!failed.load()&&count==48,"Same-process store instances lost concurrent edits");
        }
        directory.getChildFile("library-v1.json").replaceWithText("{corrupt");
        check(juce::JSON::parse(reopened.readLibrary())["playlists"].size()==60,"Backup recovery failed");
        std::cout<<"PASS: atomic durable saves, cold reopen, field/track merge, 60 multiprocess writes, missing references and corrupt-file recovery\n";
        return 0;
    }catch(const std::exception& error){std::cerr<<"FAIL: "<<error.what()<<"\n";return 1;}
}
