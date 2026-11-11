#include "LibraryStore.h"
#include "MonitorRouteGuard.h"
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
        {
            MonitorRouteGuard monitor;const juce::StringArray none,sp404{"SP404-input"},cardOut{"SP404-output"},other{"Other-card"};
            check(!monitor.update(sp404,cardOut,true),"Monitoring became active without being requested");
            monitor.configure(true,sp404,cardOut);check(monitor.update(sp404,cardOut,true),"Connected interface monitoring did not enable");
            const auto saved=monitor.route();
            check(!monitor.update(none,none,true)&&monitor.requested(),"Disconnected interface fell back to live microphone/speaker monitoring");
            check(!monitor.update(other,other,true),"A different interface consumed the pending monitor restore");
            check(!monitor.update(sp404,none,true)&&!monitor.update(sp404,cardOut,false),"Monitoring resumed before both route ends/input callbacks were ready");
            check(monitor.update(sp404,cardOut,true),"Reconnecting the original interface did not restore monitoring");
            MonitorRouteGuard restarted;restarted.restore(true,saved);check(!restarted.update(none,none,true)&&restarted.update(sp404,cardOut,true),"Saved monitor ownership did not survive a restart");
            monitor.configure(false,none,none);check(!monitor.update(sp404,cardOut,true)&&!monitor.requested(),"Manual monitor Off did not cancel automatic restore");
            monitor.configure(true,none,none);check(monitor.update(none,none,true)&&monitor.update(sp404,none,true)&&!monitor.update(none,none,true),"Automatic monitoring did not bind a newly connected input before fallback");
            monitor.configure(false,none,none);monitor.configure(true,other,none);check(monitor.update(other,none,true),"An explicit new monitoring choice did not replace route ownership");
        }
        {
            const auto localDirectory=directory.getChildFile("renaming");LibraryStore local(localDirectory);
            auto track=parse(R"({"id":"loc00000001","title":"Original take","duration":12,"kind":"song"})");
            const auto originalFile=local.mediaDirectory().getChildFile("original.wav");originalFile.getParentDirectory().createDirectory();originalFile.replaceWithText("retained original audio bytes");track.getDynamicObject()->setProperty("path",originalFile.getFullPathName());local.registerMedia("loc00000001",track);
            auto library=parse(R"({"favorites":[],"history":[],"playlists":[{"id":"imports","tracks":[]},{"id":"set","tracks":[]}]})");
            library["favorites"].getArray()->add(track.clone());library["history"].getArray()->add(track.clone());for(auto& playlist:*library["playlists"].getArray())playlist["tracks"].getArray()->add(track.clone());local.commitLibrary(local.readLibrary(),juce::JSON::toString(library));
            const auto stale=local.readLibrary(),beforeBytes=originalFile.loadFileAsString();const auto result=local.renameLocalMedia("loc00000001",juce::String::fromUTF8("  Take 02 – drums  "));
            const auto title=juce::String::fromUTF8("Take 02 – drums");check(result["previousTitle"].toString()=="Original take"&&result["track"]["title"].toString()==title,"Local rename did not return the trimmed name/previous title");
            const auto changed=juce::JSON::parse(result["library"].toString());check(changed["favorites"][0]["title"].toString()==title&&changed["history"][0]["title"].toString()==title,"Local rename missed favorites/history");for(const auto& playlist:*changed["playlists"].getArray())check(playlist["tracks"][0]["title"].toString()==title,"Local rename missed a playlist occurrence");
            auto edited=juce::JSON::parse(stale);edited["history"].getArray()->add(track.clone());const auto reconciled=juce::JSON::parse(local.commitLibrary(stale,juce::JSON::toString(edited)));for(const auto& entry:*reconciled["history"].getArray())check(entry["title"].toString()==title,"Stale history restored the original imported title");
            LibraryStore cold(localDirectory);check(cold.media("loc00000001")["title"].toString()==title&&cold.media("loc00000001")["path"].toString()==originalFile.getFullPathName()&&originalFile.loadFileAsString()==beforeBytes,"Rename changed retained audio/identity or failed cold restore");
            bool rejected=false;try{local.renameLocalMedia("loc00000001","   ");}catch(...){rejected=true;}check(rejected,"Blank imported-song title was accepted");rejected=false;try{local.renameLocalMedia("remote00001","Title");}catch(...){rejected=true;}check(rejected,"Remote track was accepted by managed-audio rename");
        }
        directory.getChildFile("library-v1.json").replaceWithText("{corrupt");
        check(juce::JSON::parse(reopened.readLibrary())["playlists"].size()==60,"Backup recovery failed");
        std::cout<<"PASS: atomic durable saves, cold reopen, field/track merge, 60 multiprocess writes, missing references, corrupt-file recovery and monitor disconnect/reconnect ownership\n";
        return 0;
    }catch(const std::exception& error){std::cerr<<"FAIL: "<<error.what()<<"\n";return 1;}
}
