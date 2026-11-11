#include "LibraryStore.h"
#include <stdexcept>
#include <unordered_map>
#if JUCE_IOS
#include "AppleHttp.h"
#endif

namespace {
juce::var emptyLibrary() {
    auto* result=new juce::DynamicObject;
    for(const auto* key:{"favorites","playlists","history"})result->setProperty(key,juce::Array<juce::var>{});
    return juce::var(result);
}
bool validLibrary(const juce::var& value) {
    return value.isObject()&&value["favorites"].isArray()&&value["playlists"].isArray()&&value["history"].isArray();
}
bool equal(const juce::var& a,const juce::var& b){
    if(a.isArray()||b.isArray()){if(!a.isArray()||!b.isArray()||a.size()!=b.size())return false;for(int i=0;i<a.size();++i)if(!equal(a[i],b[i]))return false;return true;}
    if(a.isObject()||b.isObject()){
        const auto* left=a.getDynamicObject();const auto* right=b.getDynamicObject();
        if(!left||!right||left->getProperties().size()!=right->getProperties().size())return false;
        for(const auto& field:left->getProperties())if(!b.hasProperty(field.name)||!equal(field.value,b[field.name]))return false;return true;
    }
    if(a.isBool()!=b.isBool()||a.isString()!=b.isString())return false;
    return a==b;
}
juce::var member(const juce::var& list,const juce::String& id){if(const auto* items=list.getArray())for(const auto& item:*items)if(item["id"].toString()==id)return item;return {};}
juce::var copy(const juce::var& value){return value.clone();}
struct Lock {
    LibraryFileLock& lock;
    explicit Lock(LibraryFileLock& value):lock(value){if(!lock.enter(5000))throw std::runtime_error("Library is busy; retry the edit");}
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
juce::File LibraryStore::defaultSharedDirectory(){
    const auto path=juce::SystemStats::getEnvironmentVariable("BEATMAKER_SHARED_LIBRARY_DIR",{});
    if(path.isNotEmpty())return juce::File(path);
    if(juce::SystemStats::getEnvironmentVariable("BEATMAKER_PLUGIN_DATA_DIR",{}).isNotEmpty())return {};
   #if JUCE_IOS
    return appleSharedLibraryDirectory();
   #elif JUCE_LINUX
    const auto xdg=juce::SystemStats::getEnvironmentVariable("XDG_CONFIG_HOME",{});
    return (xdg.isNotEmpty()?juce::File(xdg):juce::File::getSpecialLocation(juce::File::userHomeDirectory).getChildFile(".config")).getChildFile("Beatmaker Cues/SharedLibrary");
   #else
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("Beatmaker Cues/SharedLibrary");
   #endif
}
LibraryStore::LibraryStore():LibraryStore(defaultDirectory(),defaultSharedDirectory()){}
LibraryStore::LibraryStore(juce::File directory,juce::File shared):folder(directory),file(folder.getChildFile("library-v1.json")),backup(folder.getChildFile("library-v1.backup.json")),
    processLock(directory.getChildFile("library.lock").getFullPathName().toStdString()){
    if(!folder.createDirectory()&&!folder.isDirectory())throw std::runtime_error("Cannot create library directory");
   #if JUCE_IOS
    appleAllowBackgroundFileAccess(folder);
    for(const auto& saved:folder.findChildFiles(juce::File::findFiles,true,"*"))appleAllowBackgroundFileAccess(saved);
   #endif
    if(shared!=juce::File{}&&shared!=directory)sharedStore=std::make_unique<LibraryStore>(shared);
}
void LibraryStore::ensureSharedMigration(){
    if(!sharedStore)return;
    std::call_once(sharedMigration,[this]{
        const auto source="plugin-library:"+migrationSource();
        if(sharedStore->hasImported(source))return;
        juce::var document;
        {const juce::ScopedLock local(localLock);Lock lock(processLock);document=readDocument().clone();}
       #if JUCE_IOS
        if(auto* entries=document["media"].getDynamicObject())for(auto& entry:entries->getProperties()){
            const auto path=entry.value["path"].toString();juce::File original(path);
            if(path.isNotEmpty()&&!original.existsAsFile()){
                const auto relocated=folder.getChildFile("Media/"+original.getFileName());if(relocated.existsAsFile())original=relocated;
            }
            if(path.isNotEmpty()&&original.existsAsFile()&&!original.isAChildOf(sharedStore->mediaDirectory())){
                const auto mediaFolder=sharedStore->mediaDirectory();mediaFolder.createDirectory();
                const auto target=mediaFolder.getChildFile(juce::File::createLegalFileName(entry.name.toString())+original.getFileExtension());
                if(!target.existsAsFile()){
                    juce::TemporaryFile temporary(target);
                    if(!original.copyFileTo(temporary.getFile())||!temporary.overwriteTargetFileWithTemporary())throw std::runtime_error("Cannot copy local audio into the shared container; originals retained");
                }
                entry.value.getDynamicObject()->setProperty("path",target.getFullPathName());
            }
        }
       #endif
        sharedStore->importLegacy(source,document["library"],document["media"]);
    });
}
juce::String LibraryStore::migrationSource() const {
   #if JUCE_IOS
    return "ios:"+appleLibraryIdentity();
   #else
    return file.getFullPathName();
   #endif
}

juce::String LibraryStore::fingerprint() const {
    juce::String result;
    for(const auto& candidate:{file,backup}){
        if(!candidate.existsAsFile()){result+="missing|";continue;}
        juce::uint64 hash=14695981039346656037ULL;char prefix[192];
        if(auto input=candidate.createInputStream()){const auto count=input->read(prefix,sizeof(prefix));for(int index=0;index<count;++index){hash^=(juce::uint8)prefix[index];hash*=1099511628211ULL;}}
        result+=juce::String::toHexString((juce::int64)candidate.getFileIdentifier())+":"+juce::String(candidate.getSize())+":"+juce::String(candidate.getLastModificationTime().toMilliseconds())+":"+juce::String::toHexString((juce::int64)hash)+"|";
    }
    return result;
}
juce::var LibraryStore::readDocument(bool force){
    const auto signature=fingerprint();
    if(!force&&cachedDocument.isObject()&&signature==cachedFingerprint)return cachedDocument;
    for(const auto& candidate:{file,backup}){
        if(!candidate.existsAsFile())continue;
        ++documentParses;
        const auto parsed=juce::JSON::parse(candidate.loadFileAsString());
        if(parsed.isObject()&&(int)parsed["schema"]==1&&validLibrary(parsed["library"])){
            cachedDocument=parsed.clone();cachedFingerprint=signature;cachedLibrary.clear();cachedPrimaryValid=candidate==file;return parsed;
        }
    }
    if(file.existsAsFile()||backup.existsAsFile())throw std::runtime_error("Library data is damaged; original files were retained for recovery");
    auto* document=new juce::DynamicObject;
    document->setProperty("schema",1);document->setProperty("revision",(juce::int64)0);
    document->setProperty("library",emptyLibrary());document->setProperty("preferences",juce::var(new juce::DynamicObject));
    juce::var result(document);cachedDocument=result.clone();cachedFingerprint=signature;cachedLibrary.clear();cachedPrimaryValid=false;return result;
}
void LibraryStore::writeDocument(const juce::var& data){
    if(!folder.createDirectory())throw std::runtime_error("Cannot create library directory");
    if(file.existsAsFile()){
        juce::var previous;
        if(cachedPrimaryValid&&cachedFingerprint==fingerprint())previous=cachedDocument;
        else{++documentParses;previous=juce::JSON::parse(file.loadFileAsString());}
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
    cachedDocument=data.clone();cachedFingerprint=fingerprint();cachedLibrary.clear();cachedPrimaryValid=true;
}

juce::var LibraryStore::merge(const juce::var& base,const juce::var& edited,const juce::var& latest){
    if(equal(base,edited))return copy(latest);
    if(base.isArray()&&edited.isArray()&&latest.isArray()){
        juce::Array<juce::var> result;
        std::unordered_map<std::string,juce::var> beforeById,latestById,editedById;
        const auto index=[](const juce::var& value,auto& target){for(const auto& item:*value.getArray()){const auto id=item["id"].toString();if(id.isNotEmpty())target.emplace(id.toStdString(),item);}};
        index(base,beforeById);index(latest,latestById);index(edited,editedById);
        const auto find=[](const auto& values,const juce::String& id)->juce::var{const auto found=values.find(id.toStdString());return found==values.end()?juce::var{}:found->second;};
        // Apply this edit's ordering/removals, retain concurrent entries unknown to its baseline.
        for(const auto& item:*edited.getArray()){
            const auto id=item["id"].toString();
            if(id.isEmpty()){result.add(copy(item));continue;}
            const auto before=find(beforeById,id),now=find(latestById,id);
            if(!before.isVoid()&&now.isVoid()&&equal(before,item))continue; // Respect another editor's deletion.
            result.add(before.isVoid()?copy(item):merge(before,item,now.isVoid()?before:now));
        }
        for(const auto& item:*latest.getArray()){
            const auto id=item["id"].toString();
            if(id.isNotEmpty()&&!beforeById.count(id.toStdString())&&!editedById.count(id.toStdString()))result.add(copy(item));
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

juce::String LibraryStore::readLibrary(){if(sharedStore){ensureSharedMigration();return sharedStore->readLibrary();}const juce::ScopedLock local(localLock);Lock lock(processLock);const auto document=readDocument();if(cachedLibrary.isEmpty())cachedLibrary=juce::JSON::toString(document["library"]);return cachedLibrary;}
juce::String LibraryStore::version(){if(sharedStore){ensureSharedMigration();return sharedStore->version();}const juce::ScopedLock local(localLock);Lock lock(processLock);return fingerprint();}
juce::var LibraryStore::readSnapshot(){
    if(sharedStore){ensureSharedMigration();return sharedStore->readSnapshot();}
    const juce::ScopedLock local(localLock);Lock lock(processLock);const auto document=readDocument();
    if(cachedLibrary.isEmpty())cachedLibrary=juce::JSON::toString(document["library"]);
    auto* result=new juce::DynamicObject;result->setProperty("json",cachedLibrary);result->setProperty("version",cachedFingerprint);return juce::var(result);
}
juce::String LibraryStore::commitLibrary(const juce::String& baseline,const juce::String& next){
    if(sharedStore){ensureSharedMigration();return sharedStore->commitLibrary(baseline,next);}
    const juce::ScopedLock local(localLock);Lock lock(processLock);
    auto base=juce::JSON::parse(baseline),edited=juce::JSON::parse(next);
    if(!validLibrary(edited))throw std::runtime_error("Invalid library edit");
    if(!validLibrary(base))base=emptyLibrary();
    auto document=readDocument(true);auto merged=merge(base,edited,document["library"]);
    if(const auto* deleted=document["deletedMedia"].getDynamicObject())for(const auto& entry:deleted->getProperties()){
        const auto remove=[&](juce::var list){if(auto* items=list.getArray())for(int i=items->size();--i>=0;)if((*items)[i]["id"].toString()==entry.name.toString())items->remove(i);};
        remove(merged["favorites"]);remove(merged["history"]);for(const auto& playlist:*merged["playlists"].getArray())remove(playlist["tracks"]);
    }
    if(auto* history=merged["history"].getArray())if(history->size()>60)history->removeRange(60,history->size()-60);
    // Older queues/hosts may still submit the original file title after a rename.
    const auto retitle=[&](juce::var list){if(auto* items=list.getArray())for(auto& track:*items){const auto id=track["id"].toString(),title=document["media"][juce::Identifier(id)]["title"].toString();if(id.startsWith("loc")&&title.isNotEmpty()&&track.isObject())track.getDynamicObject()->setProperty("title",title);}};
    retitle(merged["favorites"]);retitle(merged["history"]);for(const auto& playlist:*merged["playlists"].getArray())retitle(playlist["tracks"]);
    document.getDynamicObject()->setProperty("library",merged);
    document.getDynamicObject()->setProperty("revision",(juce::int64)document["revision"]+1);
    writeDocument(document);cachedLibrary=juce::JSON::toString(merged);return cachedLibrary;
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
   #if JUCE_IOS
    appleAllowBackgroundFileAccess(savedFile.getParentDirectory());
   #endif
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
    if(lastDefaults!=encoded){auto document=readDocument(true);document.getDynamicObject()->setProperty("preferences",defaults);writeDocument(document);lastDefaults=encoded;}
}
void LibraryStore::migrate(const juce::String& legacyUi){
    const auto legacy=juce::JSON::parse(legacyUi);if(!legacy.isObject())return;
    const auto saved=juce::JSON::parse(legacy["plugin-file:library.json"].toString());
    if(!validLibrary(saved))return;
    if(sharedStore)sharedStore->importLegacy("legacy-session:"+migrationSource()+":"+juce::String::toHexString(juce::JSON::toString(saved).hashCode64()),saved);
    const juce::ScopedLock local(localLock);Lock lock(processLock);
    const auto imports=folder.getChildFile("LegacyImports");if(!imports.createDirectory())throw std::runtime_error("Cannot retain legacy library data");
    const auto encoded=juce::JSON::toString(saved);
    const auto archive=imports.getChildFile("library-"+juce::String::toHexString(encoded.hashCode64())+".json");
    if(!archive.existsAsFile()){
        auto* backupData=new juce::DynamicObject;backupData->setProperty("format","musike-backup");backupData->setProperty("version",1);backupData->setProperty("library",saved);
        if(!archive.replaceWithText(juce::JSON::toString(juce::var(backupData))))throw std::runtime_error("Cannot archive legacy library data");
    }
    auto document=readDocument(true);
    if((juce::int64)document["revision"]!=0)return;
    if(validLibrary(saved))document.getDynamicObject()->setProperty("library",saved);
    auto preferences=copy(legacy);preferences.getDynamicObject()->removeProperty("plugin-file:library.json");preferences.getDynamicObject()->removeProperty("plugin-file:library.tmp.json");
    document.getDynamicObject()->setProperty("preferences",preferences);
    document.getDynamicObject()->setProperty("revision",(juce::int64)1);writeDocument(document);
}

void LibraryStore::registerMedia(const juce::String& id,const juce::var& metadata){
    if(sharedStore){ensureSharedMigration();sharedStore->registerMedia(id,metadata);return;}
    const juce::ScopedLock local(localLock);Lock lock(processLock);auto document=readDocument(true);
    auto entries=document["media"].isObject()?document["media"].clone():juce::var(new juce::DynamicObject);
    entries.getDynamicObject()->setProperty(juce::Identifier(id),metadata);
    document.getDynamicObject()->setProperty("media",entries);writeDocument(document);
}
juce::var LibraryStore::media(const juce::String& id){if(sharedStore){ensureSharedMigration();return sharedStore->media(id);}const juce::ScopedLock local(localLock);Lock lock(processLock);return readDocument()["media"][juce::Identifier(id)].clone();}
juce::var LibraryStore::allMedia(){if(sharedStore){ensureSharedMigration();return sharedStore->allMedia();}const juce::ScopedLock local(localLock);Lock lock(processLock);juce::Array<juce::var> result;const auto media=readDocument()["media"];if(const auto* fields=media.getDynamicObject())for(const auto& entry:fields->getProperties())result.add(entry.value.clone());return juce::var(result);}
juce::var LibraryStore::renameLocalMedia(const juce::String& id,const juce::String& title){
    if(sharedStore){ensureSharedMigration();return sharedStore->renameLocalMedia(id,title);}
    const auto clean=title.trim();
    if(!id.startsWith("loc")||id.length()!=11||!id.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"))throw std::runtime_error("Select an imported file or recording to rename");
    if(clean.isEmpty()||clean.length()>200)throw std::runtime_error("Enter a song name of 1 to 200 characters");
    const juce::ScopedLock local(localLock);Lock lock(processLock);auto document=readDocument(true).clone();
    auto track=document["media"][juce::Identifier(id)];if(!track.isObject())throw std::runtime_error("Imported audio is no longer in the library");
    const auto previous=track["title"].toString();track.getDynamicObject()->setProperty("title",clean);
    auto library=document["library"];const auto update=[&](juce::var list){if(auto* items=list.getArray())for(auto& item:*items)if(item["id"].toString()==id)item.getDynamicObject()->setProperty("title",clean);};
    update(library["favorites"]);update(library["history"]);for(const auto& playlist:*library["playlists"].getArray())update(playlist["tracks"]);
    document.getDynamicObject()->setProperty("revision",(juce::int64)document["revision"]+1);writeDocument(document);cachedLibrary=juce::JSON::toString(library);
    auto* result=new juce::DynamicObject;result->setProperty("track",track.clone());result->setProperty("previousTitle",previous);result->setProperty("library",cachedLibrary);return juce::var(result);
}
juce::var LibraryStore::eraseLocalMedia(const juce::String& id,const juce::StringArray& protectedPaths){
    if(sharedStore){ensureSharedMigration();return sharedStore->eraseLocalMedia(id,protectedPaths);}
    if(!id.startsWith("loc")||id.length()!=11||!id.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"))throw std::runtime_error("Only managed local audio can be erased");
    const juce::ScopedLock local(localLock);Lock lock(processLock);auto document=readDocument(true),entries=document["media"].clone();const auto metadata=entries[juce::Identifier(id)];
    const auto path=metadata["path"].toString();const juce::File original(path.isEmpty()?mediaDirectory().getFullPathName():path);
    bool shared=protectedPaths.contains(path);if(const auto* fields=entries.getDynamicObject())for(const auto& entry:fields->getProperties())if(entry.name.toString()!=id&&entry.value["path"].toString()==path)shared=true;
    if(path.isNotEmpty()&&!original.isAChildOf(mediaDirectory()))throw std::runtime_error("Audio is outside managed app storage");
    const auto waveKey=juce::String::toHexString((original.getFullPathName()+juce::String(original.getSize())+juce::String(original.getLastModificationTime().toMilliseconds())).hashCode64());
    juce::File tomb;
    if(!shared&&original.existsAsFile()){
        const auto deleted=mediaDirectory().getChildFile("Deleted");if(!deleted.createDirectory())throw std::runtime_error("Cannot prepare audio removal");
        tomb=deleted.getChildFile(juce::Uuid().toString()+original.getFileExtension());if(!original.moveFileTo(tomb))throw std::runtime_error("Cannot remove the retained audio file");
    }
    try{
        auto library=document["library"].clone();const auto remove=[&](juce::var list){if(auto* items=list.getArray())for(int i=items->size();--i>=0;)if((*items)[i]["id"].toString()==id)items->remove(i);};
        remove(library["favorites"]);remove(library["history"]);for(const auto& playlist:*library["playlists"].getArray())remove(playlist["tracks"]);
        if(auto* fields=entries.getDynamicObject())fields->removeProperty(juce::Identifier(id));auto deleted=document["deletedMedia"].isObject()?document["deletedMedia"].clone():juce::var(new juce::DynamicObject);deleted.getDynamicObject()->setProperty(juce::Identifier(id),true);
        document.getDynamicObject()->setProperty("media",entries);document.getDynamicObject()->setProperty("deletedMedia",deleted);document.getDynamicObject()->setProperty("library",library);document.getDynamicObject()->setProperty("revision",(juce::int64)document["revision"]+1);writeDocument(document);cachedLibrary=juce::JSON::toString(library);
    }catch(...){if(tomb.existsAsFile())tomb.moveFileTo(original);throw;}
    if(tomb.existsAsFile()&&!tomb.deleteFile())throw std::runtime_error("Library entry removed but the retained file could not be erased");
    mediaDirectory().getChildFile("Waveforms/sampler-"+id+".json").deleteFile();mediaDirectory().getChildFile("Waveforms/"+waveKey+".json").deleteFile();
    auto* result=new juce::DynamicObject;result->setProperty("erased",!shared);result->setProperty("retainedForAnotherUse",shared);result->setProperty("library",cachedLibrary);return juce::var(result);
}
void LibraryStore::importLegacy(const juce::String& source,const juce::var& library,const juce::var& media){
    const juce::ScopedLock local(localLock);Lock lock(processLock);auto document=readDocument(true);
    auto imports=document["imports"].isObject()?document["imports"].clone():juce::var(new juce::DynamicObject);
    if((bool)imports[juce::Identifier(source)])return;
    if(!validLibrary(library))throw std::runtime_error("Invalid legacy library");
    auto merged=document["library"].clone();
    for(const auto* key:{"favorites","history","playlists"}){
        auto* target=merged[key].getArray();
        for(const auto& item:*library[key].getArray()){
            auto existing=member(merged[key],item["id"].toString());
            if(existing.isVoid()){target->add(item.clone());continue;}
            if(juce::String(key)=="playlists"&&existing["tracks"].isArray()&&item["tracks"].isArray()){
                for(const auto& track:*item["tracks"].getArray())if(member(existing["tracks"],track["id"].toString()).isVoid())existing["tracks"].getArray()->add(track.clone());
            }
        }
        if(juce::String(key)=="history"&&target->size()>60)target->removeRange(60,target->size()-60);
    }
    auto entries=document["media"].isObject()?document["media"].clone():juce::var(new juce::DynamicObject);
    if(auto* incoming=media.getDynamicObject())for(const auto& entry:incoming->getProperties())if(!entries.hasProperty(entry.name))entries.getDynamicObject()->setProperty(entry.name,entry.value.clone());
    imports.getDynamicObject()->setProperty(juce::Identifier(source),true);
    document.getDynamicObject()->setProperty("imports",imports);document.getDynamicObject()->setProperty("library",merged);document.getDynamicObject()->setProperty("media",entries);
    document.getDynamicObject()->setProperty("revision",(juce::int64)document["revision"]+1);writeDocument(document);
}
bool LibraryStore::hasImported(const juce::String& source){const juce::ScopedLock local(localLock);Lock lock(processLock);return (bool)readDocument()["imports"][juce::Identifier(source)];}
