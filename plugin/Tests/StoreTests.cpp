#include "LibraryStore.h"
#include <iostream>
#include <stdexcept>

void check(bool value,const char* text){if(!value)throw std::runtime_error(text);}
juce::var parse(const char* text){return juce::JSON::parse(text);}
int main(int argc,char** argv){
    try{
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
        directory.getChildFile("library-v1.json").replaceWithText("{corrupt");
        check(juce::JSON::parse(reopened.readLibrary())["playlists"].size()==60,"Backup recovery failed");
        std::cout<<"PASS: atomic durable saves, cold reopen, field/track merge, 60 multiprocess writes, missing references and corrupt-file recovery\n";
        return 0;
    }catch(const std::exception& error){std::cerr<<"FAIL: "<<error.what()<<"\n";return 1;}
}
