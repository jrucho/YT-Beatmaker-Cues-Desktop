#pragma once
#include <juce_core/juce_core.h>

/** Durable product-local data. Never called by the audio callback.
 * Each iOS sandbox has its own store (no App Group required). Desktop plug-in
 * instances serialize commits with a named interprocess lock and three-way merge.
 */
class LibraryStore {
public:
    explicit LibraryStore(juce::File directory = defaultDirectory());
    static juce::File defaultDirectory();
    juce::String readLibrary();
    juce::String commitLibrary(const juce::String& base, const juce::String& edited);
    juce::String readPreferences(const juce::String& session = "standalone");
    void writePreferences(const juce::String&,const juce::String& session = "standalone");
    void migrate(const juce::String& legacyUi);
    void registerMedia(const juce::String& id,const juce::var& metadata);
    juce::var media(const juce::String& id);
    juce::File mediaDirectory() const {return folder.getChildFile("Media");}
    static juce::var merge(const juce::var& base, const juce::var& edited, const juce::var& latest);
private:
    juce::var readDocument();
    void writeDocument(const juce::var&);
    juce::File folder, file, backup;
    juce::InterProcessLock processLock;
    juce::CriticalSection localLock;
    juce::String lastDefaults;
};
