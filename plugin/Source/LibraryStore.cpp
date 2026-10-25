#include "LibraryStore.h"
#include <stdexcept>

namespace {
juce::var emptyLibrary() {
    auto* result=new juce::DynamicObject;
    for(const auto* key:{"favorites","playlists","history"})result->setProperty(key,juce::Array<juce::var>{});
    return juce::var(result);
}
bool validLibrary(const juce::var& value) {
    return value.isObject()&&value["favorites"].isArray()&&value["playlists"].isArray()&&value["history"].isArray();
}
bool equal(const juce::var& a,const juce::var& b){return juce::JSON::toString(a,true)==juce::JSON::toString(b,true);}
juce::var member(const juce::var& list,const juce::String& id){if(const auto* items=list.getArray())for(const auto& item:*items)if(item["id"].toString()==id)return item;return {};}
juce::var copy(const juce::var& value){return value.clone();}
struct Lock {
    juce::InterProcessLock& lock;
    explicit Lock(juce::InterProcessLock& value):lock(value){if(!lock.enter(5000))throw std::runtime_error("Library is busy; retry the edit");}
    ~Lock(){lock.exit();}
};
}

juce::File LibraryStore::defaultDirectory(){
    const auto overridePath=juce::SystemStats::getEnvironmentVariable("BEATMAKER_PLUGIN_DATA_DIR",{});
    return overridePath.isNotEmpty()?juce::File(overridePath):juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile(
       #if BEATMAKER_DESKTOP_BETA
        "Beatmaker Cues/DesktopBetaLibrary"
       #else
        "Beatmaker Cues/PluginLibrary"
       #endif
    );
}
LibraryStore::LibraryStore(juce::File directory):folder(directory),file(folder.getChildFile("library-v1.json")),backup(folder.getChildFile("library-v1.backup.json")),
    processLock("beatmaker-library-"+juce::String::toHexString(directory.getFullPathName().hashCode64())){}

juce::var LibraryStore::readDocument(){
    for(const auto& candidate:{file,backup}){
        if(!candidate.existsAsFile())continue;
        const auto parsed=juce::JSON::parse(candidate.loadFileAsString());
        if(parsed.isObject()&&(int)parsed["schema"]==1&&validLibrary(parsed["library"]))return parsed;
    }
    if(file.existsAsFile()||backup.existsAsFile())throw std::runtime_error("Library data is damaged; original files were retained for recovery");
    auto* document=new juce::DynamicObject;
    document->setProperty("schema",1);document->setProperty("revision",(juce::int64)0);
    document->setProperty("library",emptyLibrary());document->setProperty("preferences",juce::var(new juce::DynamicObject));
    return juce::var(document);
}
void LibraryStore::writeDocument(const juce::var& data){
    if(!folder.createDirectory())throw std::runtime_error("Cannot create library directory");
    if(file.existsAsFile()){
        const auto previous=juce::JSON::parse(file.loadFileAsString());
        if(previous.isObject()&&validLibrary(previous["library"])){
            juce::TemporaryFile temp(backup);
            if(!temp.getFile().replaceWithText(juce::JSON::toString(previous))||!temp.overwriteTargetFileWithTemporary())throw std::runtime_error("Cannot back up library");
        }else{
            if(!file.copyFileTo(folder.getNonexistentChildFile("library-corrupt-"+juce::String(juce::Time::currentTimeMillis()),".json")))throw std::runtime_error("Cannot retain damaged library for recovery");
        }
    }
    juce::TemporaryFile temp(file);
    {auto output=temp.getFile().createOutputStream();if(!output)throw std::runtime_error("Cannot write library");
        const auto text=juce::JSON::toString(data);if(!output->writeText(text,false,false,nullptr))throw std::runtime_error("Library write failed");output->flush();if(output->getStatus().failed())throw std::runtime_error("Library flush failed");}
    if(!temp.overwriteTargetFileWithTemporary())throw std::runtime_error("Cannot replace library atomically");
}

juce::var LibraryStore::merge(const juce::var& base,const juce::var& edited,const juce::var& latest){
    if(equal(base,edited))return copy(latest);
    if(base.isArray()&&edited.isArray()&&latest.isArray()){
        juce::Array<juce::var> result;
        // Apply this edit's ordering/removals, retain concurrent entries unknown to its baseline.
        for(const auto& item:*edited.getArray()){
            const auto id=item["id"].toString();
            if(id.isEmpty()){result.add(copy(item));continue;}
            const auto before=member(base,id),now=member(latest,id);
            if(!before.isVoid()&&now.isVoid()&&equal(before,item))continue; // Respect another editor's deletion.
            result.add(before.isVoid()?copy(item):merge(before,item,now.isVoid()?before:now));
        }
        for(const auto& item:*latest.getArray()){
            const auto id=item["id"].toString();
            if(id.isNotEmpty()&&member(base,id).isVoid()&&member(edited,id).isVoid())result.add(copy(item));
        }
        return juce::var(result);
    }
    if(base.isObject()&&edited.isObject()&&latest.isObject()){
        auto result=copy(latest);auto* fields=result.getDynamicObject();
        for(const auto& field:base.getDynamicObject()->getProperties())if(!edited.hasProperty(field.name))fields->removeProperty(field.name);
        for(const auto& field:edited.getDynamicObject()->getProperties()){
            if(!base.hasProperty(field.name))fields->setProperty(field.name,copy(field.value));
            else fields->setProperty(field.name,merge(base[field.name],field.value,latest[field.name]));
        }
        return result;
    }
    return copy(edited);
}

juce::String LibraryStore::readLibrary(){const juce::ScopedLock local(localLock);Lock lock(processLock);return juce::JSON::toString(readDocument()["library"]);}
juce::String LibraryStore::commitLibrary(const juce::String& baseline,const juce::String& next){
    const juce::ScopedLock local(localLock);Lock lock(processLock);
    auto base=juce::JSON::parse(baseline),edited=juce::JSON::parse(next);
    if(!validLibrary(edited))throw std::runtime_error("Invalid library edit");
    if(!validLibrary(base))base=emptyLibrary();
    auto document=readDocument();auto merged=merge(base,edited,document["library"]);
    document.getDynamicObject()->setProperty("library",merged);
    document.getDynamicObject()->setProperty("revision",(juce::int64)document["revision"]+1);
    writeDocument(document);return juce::JSON::toString(merged);
}
juce::String LibraryStore::readPreferences(const juce::String& session){
    if(session.isEmpty()||!session.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"))throw std::runtime_error("Invalid session ID");
    const juce::ScopedLock local(localLock);Lock lock(processLock);const auto document=readDocument();
    lastDefaults=juce::JSON::toString(document["preferences"]);
    const auto savedFile=folder.getChildFile("Sessions/"+session+".json");
    bool damaged=false;
    for(const auto& candidate:{savedFile,savedFile.getSiblingFile(savedFile.getFileName()+".backup")})if(candidate.existsAsFile()){
        const auto saved=juce::JSON::parse(candidate.loadFileAsString());if(saved.isObject())return juce::JSON::toString(saved);damaged=true;
    }
    if(damaged)throw std::runtime_error("Session settings need recovery; existing files have been retained");
    const auto legacy=document["sessions"][juce::Identifier(session)];
    return legacy.isObject()?juce::JSON::toString(legacy):lastDefaults;
}
void LibraryStore::writePreferences(const juce::String& value,const juce::String& session){
    const auto preferences=juce::JSON::parse(value);if(!preferences.isObject())return;
    if(session.isEmpty()||!session.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"))throw std::runtime_error("Invalid session ID");
    const juce::ScopedLock local(localLock);Lock lock(processLock);
    const auto savedFile=folder.getChildFile("Sessions/"+session+".json");
    if(!savedFile.getParentDirectory().createDirectory())throw std::runtime_error("Cannot create session storage");
    if(savedFile.existsAsFile()){
        const auto previous=savedFile.loadFileAsString();if(previous==value)return;
        if(juce::JSON::parse(previous).isObject()){
            const auto backupFile=savedFile.getSiblingFile(savedFile.getFileName()+".backup");juce::TemporaryFile temp(backupFile);
            if(!temp.getFile().replaceWithText(previous)||!temp.overwriteTargetFileWithTemporary())throw std::runtime_error("Cannot back up session settings");
        }else{
            if(!savedFile.copyFileTo(savedFile.getParentDirectory().getNonexistentChildFile("session-corrupt-"+juce::String(juce::Time::currentTimeMillis()),".json")))throw std::runtime_error("Cannot retain damaged session for recovery");
        }
    }
    juce::TemporaryFile sessionTemp(savedFile);
    {auto output=sessionTemp.getFile().createOutputStream();if(!output||!output->writeText(value,false,false,nullptr))throw std::runtime_error("Cannot save session settings");output->flush();if(output->getStatus().failed())throw std::runtime_error("Cannot flush session settings");}
    if(!sessionTemp.overwriteTargetFileWithTemporary())throw std::runtime_error("Cannot replace session settings atomically");
    auto defaults=preferences.clone();
    for(const auto* key:{"musike:player","musike:cues:v1","musike:loops","musike:cue-bank"})defaults.getDynamicObject()->removeProperty(key);
    const auto encoded=juce::JSON::toString(defaults);
    if(lastDefaults!=encoded){auto document=readDocument();document.getDynamicObject()->setProperty("preferences",defaults);writeDocument(document);lastDefaults=encoded;}
}
void LibraryStore::migrate(const juce::String& legacyUi){
    const auto legacy=juce::JSON::parse(legacyUi);if(!legacy.isObject())return;
    const auto saved=juce::JSON::parse(legacy["plugin-file:library.json"].toString());
    if(!validLibrary(saved))return;
    const juce::ScopedLock local(localLock);Lock lock(processLock);
    const auto imports=folder.getChildFile("LegacyImports");if(!imports.createDirectory())throw std::runtime_error("Cannot retain legacy library data");
    const auto encoded=juce::JSON::toString(saved);
    const auto archive=imports.getChildFile("library-"+juce::String::toHexString(encoded.hashCode64())+".json");
    if(!archive.existsAsFile()){
        auto* backupData=new juce::DynamicObject;backupData->setProperty("format","musike-backup");backupData->setProperty("version",1);backupData->setProperty("library",saved);
        if(!archive.replaceWithText(juce::JSON::toString(juce::var(backupData))))throw std::runtime_error("Cannot archive legacy library data");
    }
    auto document=readDocument();
    if((juce::int64)document["revision"]!=0)return;
    if(validLibrary(saved))document.getDynamicObject()->setProperty("library",saved);
    auto preferences=copy(legacy);preferences.getDynamicObject()->removeProperty("plugin-file:library.json");preferences.getDynamicObject()->removeProperty("plugin-file:library.tmp.json");
    document.getDynamicObject()->setProperty("preferences",preferences);
    document.getDynamicObject()->setProperty("revision",(juce::int64)1);writeDocument(document);
}

void LibraryStore::registerMedia(const juce::String& id,const juce::var& metadata){
    const juce::ScopedLock local(localLock);Lock lock(processLock);auto document=readDocument();
    auto entries=document["media"].isObject()?document["media"].clone():juce::var(new juce::DynamicObject);
    entries.getDynamicObject()->setProperty(juce::Identifier(id),metadata);
    document.getDynamicObject()->setProperty("media",entries);writeDocument(document);
}
juce::var LibraryStore::media(const juce::String& id){const juce::ScopedLock local(localLock);Lock lock(processLock);return readDocument()["media"][juce::Identifier(id)].clone();}
