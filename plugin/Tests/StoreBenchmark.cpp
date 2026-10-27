#include "LibraryStore.h"
#include <iostream>

int main(int argc,char** argv){
    const int count=argc>1?juce::jlimit(1,5000,juce::String(argv[1]).getIntValue()):500;
    const auto folder=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("beatmaker-library-benchmark",{});folder.createDirectory();
    struct Cleanup{juce::File folder;~Cleanup(){folder.deleteRecursively();}}cleanup{folder};
    try{
        juce::Array<juce::var> tracks;
        for(int index=0;index<count;++index){auto* track=new juce::DynamicObject;const auto id="bench"+juce::String(index).paddedLeft('0',6);
            track->setProperty("id",id);track->setProperty("title","Large playlist benchmark track "+juce::String(index));track->setProperty("artist","Benchmark artist");track->setProperty("duration",180);
            track->setProperty("thumb","https://i.ytimg.com/vi/"+id+"/mqdefault.jpg");track->setProperty("art","https://i.ytimg.com/vi/"+id+"/hq720.jpg");track->setProperty("kind","song");tracks.add(juce::var(track));}
        auto* playlist=new juce::DynamicObject;playlist->setProperty("id","benchmark-playlist");playlist->setProperty("name","Before");playlist->setProperty("tracks",tracks);
        auto* library=new juce::DynamicObject;library->setProperty("favorites",juce::Array<juce::var>{});library->setProperty("history",juce::Array<juce::var>{});library->setProperty("playlists",juce::Array<juce::var>{juce::var(playlist)});
        LibraryStore writer(folder);writer.commitLibrary(writer.readLibrary(),juce::JSON::toString(juce::var(library)));
        LibraryStore reader(folder);const auto started=juce::Time::getMillisecondCounterHiRes();
        for(int iteration=0;iteration<100;++iteration)reader.readLibrary();
        const auto elapsed=juce::Time::getMillisecondCounterHiRes()-started;
        if(reader.documentParseCount()!=1)throw std::runtime_error("Unchanged library was repeatedly parsed");
        const auto base=writer.readLibrary();auto edit=juce::JSON::parse(base);edit["playlists"][0].getDynamicObject()->setProperty("name","After_");writer.commitLibrary(base,juce::JSON::toString(edit));
        if(juce::JSON::parse(reader.readLibrary())["playlists"][0]["name"].toString()!="After_"||reader.documentParseCount()!=2)throw std::runtime_error("Cached library did not observe an external edit");
        std::cout<<"{\"tracks\":"<<count<<",\"unchangedReads\":100,\"fullDocumentParses\":1,\"elapsedMs\":"<<elapsed<<",\"externalEditInvalidated\":true}\n";
        return 0;
    }catch(const std::exception& error){std::cerr<<error.what()<<"\n";return 1;}
}
