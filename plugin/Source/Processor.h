#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <array>
#include <atomic>
#include <mutex>
#include <thread>
#include <signalsmith-stretch/signalsmith-stretch.h>
#include "LibraryStore.h"

class CueProcessor final : public juce::AudioProcessor {
public:
    enum class Action { pad, markNext, play, pause, seek, cue, clearBank, setIn, setOut, toggleLoop };
    struct Command { Action action; int bank = 0, pad = -1; double value = 0; bool overwrite = false; };
    struct Target { int bank = -1, pad = -1; };
    struct Sample { juce::AudioBuffer<float> audio; double rate = 44100; juce::String path; };

    CueProcessor();
    ~CueProcessor() override;
    const juce::String getName() const override { return "Beatmaker Cues Plug-in"; }
    void prepareToPlay(double, int) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported(const BusesLayout&) const override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override;
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.003; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock&) override;
    void setStateInformation(const void*, int) override;

    bool submit(Command); // Message-thread producer, audio-thread consumer.
    void loadFile(const juce::File&, bool preserveCues = false);
    void loadDemo(bool preserveCues = false);
    void loadFromApp(const juce::String& videoId, int port);
    void loadRemote(const juce::String& url, double startAt, juce::String trackId = {},bool prefetch=false);
    juce::var cachedTrack(const juce::String&);
    juce::var importLocalFile(const juce::File&);
    void setWebState(const juce::String&);
    juce::String getWebState() const;
    juce::String getSessionId() const {std::lock_guard<std::mutex> lock(metadataMutex);return sessionId;}
    juce::String sessionUiState() const;
    juce::String getLegacyState() const {std::lock_guard<std::mutex> lock(metadataMutex);return legacyState;}
    void syncWebCues(const juce::var&);
    juce::var getWebCues() const;
    void setWebTrack(const juce::String&);
    void setNativeQueue(const juce::var&);
    juce::var nativeSnapshot() const;
    juce::String getStatus() const;
    double getCue(int bank, int pad) const { return cues[(size_t) bank][(size_t) pad].load(); }
    double getDuration() const;
    static Target mapNote(int preset, int channel, int note, int selectedBank);
    int padCount() const { return preset.load() == 2 ? 12 : 16; }
    void installSampleForTest(std::unique_ptr<Sample>);

    juce::AudioProcessorValueTreeState parameters;
    LibraryStore libraryStore;
    juce::ThreadPool networkWorkers{4};
    std::atomic<int> selectedBank{0}, preset{0}, activePad{-1};
    std::atomic<bool> overwrite{false}, playing{false}, loopEnabled{false};
    std::atomic<double> playhead{0}, loopIn{-1}, loopOut{-1};
    std::atomic<int> droppedCommands{0};
    std::atomic<bool> ready{false}, requestedPlay{false};
    std::atomic<int> cueRevision{0};
    std::atomic<bool> muted{false};
    std::atomic<bool> preservePitch{true};
    std::atomic<float> semitones{0};
    std::array<std::atomic<unsigned int>,160> padStates{};
    std::array<std::atomic<int>,160> padVelocities{};
    std::atomic<double> durationSeconds{0};
    std::atomic<bool> nativeAdvancing{false},nativeEnded{false};
    std::atomic<int> nativeTrackRevision{0},nativeErrorRevision{0};
    std::atomic<int> openEditors{0};
    std::atomic<bool> hostRestored{false};
    std::atomic<int> restoreRevision{0};

private:
    void execute(const Command&);
    void hit(int bank, int pad, bool replace, float velocity);
    void jump(double seconds, float velocity);
    void render(juce::AudioBuffer<float>&, int start, int count);
    void handleMidi(const juce::MidiMessage&);
    void padEvent(int bank,int pad,bool down,bool triggered,float velocity);
    float read(double position, int channel) const;
    void publish(std::unique_ptr<Sample>, int generation, bool preserveCues);
    std::array<std::array<std::atomic<double>, 16>, 10> cues;
    juce::AbstractFifo commands{256};
    std::array<Command, 256> commandData;
    juce::ThreadPool loaders{2};
    std::atomic<int> loadGeneration{0};
    std::atomic<Sample*> published{nullptr};
    std::atomic<Sample*> audioHazard{nullptr};
    // Loaded sample ownership stays off the real-time thread, including old generations.
    std::vector<std::unique_ptr<Sample>> retained;
    mutable std::mutex metadataMutex;
    juce::String status{"Load audio or press Demo to begin"}, samplePath;
    juce::String webState{"{}"}, webTrack;
    juce::String legacyState;
    juce::String sessionId;
    juce::var nativeQueue;
    std::atomic<int> nativeIndex{0},queueGeneration{0};
    std::atomic<bool> needAdvance{false},stopQueue{false},restartAtZero{false};
    std::thread queueThread;
    void runQueue();
    Sample* current = nullptr;
    double hostRate = 44100, position = 0;
    float velocityGain = 1;
    int fadeLength = 132, fadeRemaining = 0;
    std::array<float,2> lastVoice{}, fadeOrigin{};
    std::vector<float> cueFade;
    float cueFadeIn() const { return fadeRemaining > 0 ? cueFade[(size_t)(fadeLength-fadeRemaining)] : 1.0f; }
    std::atomic<double> restorePosition{0};
    juce::SmoothedValue<float> outputGain{0.8f};
    std::atomic<float>* gainValue=nullptr;
    std::atomic<float>* speedValue=nullptr;
    signalsmith::stretch::SignalsmithStretch<float> stretch;
    juce::AudioBuffer<float> stretchInput,stretchOutput;
    bool stretchSeek=true,stretchWasActive=false;
    double stretchFraction=0;
    int stretchBlock=512;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(CueProcessor)
};
