#pragma once
#include <juce_core/juce_core.h>
#include <atomic>
#include "FileLock.h"

/** Durable library and product-local sessions. Never called by the audio callback.
 * Desktop uses a common store; iOS can use an entitled App Group. Private/test
 * stores remain supported. Commits use a kernel file lock and three-way merge.
 */
class LibraryStore {
public:
    LibraryStore();
    explicit LibraryStore(juce::File directory,juce::File sharedDirectory = {});
    static juce::File defaultDirectory();
    static juce::File defaultSharedDirectory();
    juce::String readLibrary();
    juce::var readSnapshot();
    juce::String version();
    int documentParseCount() const {return documentParses.load();}
    juce::String commitLibrary(const juce::String& base, const juce::String& edited);
    juce::String readPreferences(const juce::String& session = "standalone");
    void writePreferences(const juce::String&,const juce::String& session = "standalone");
    void migrate(const juce::String& legacyUi);
    void registerMedia(const juce::String& id,const juce::var& metadata);
    juce::var media(const juce::String& id);
    juce::File mediaDirectory() const {return sharedStore?sharedStore->mediaDirectory():folder.getChildFile("Media");}
    void importLegacy(const juce::String& source,const juce::var& library,const juce::var& media = {});
    bool hasImported(const juce::String& source);
    static juce::var merge(const juce::var& base, const juce::var& edited, const juce::var& latest);
private:
    juce::var readDocument(bool force = false);
    juce::String fingerprint() const;
    void writeDocument(const juce::var&);
    juce::File folder, file, backup;
    LibraryFileLock processLock;
    juce::CriticalSection localLock;
    juce::String lastDefaults;
    juce::var cachedDocument;
    juce::String cachedFingerprint, cachedLibrary;
    bool cachedPrimaryValid=false;
    std::atomic<int> documentParses{0};
    std::unique_ptr<LibraryStore> sharedStore;
    std::once_flag sharedMigration;
    void ensureSharedMigration();
    juce::String migrationSource() const;
};
