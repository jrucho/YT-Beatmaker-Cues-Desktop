#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <array>
#include <atomic>
#include <mutex>
#include <thread>
#include <functional>
#include <signalsmith-stretch/signalsmith-stretch.h>
#include "LibraryStore.h"
#include "PagedAudio.h"
#include "dsp/EffectKernels.h"
#include "dsp/FxGraph.h"
#include "StandaloneNowPlaying.h"

class CueProcessor final : public juce::AudioProcessor {
public:
    enum class Action { pad, markNext, play, pause, seek, cue, clearBank, setIn, setOut, toggleLoop };
    enum class RemoteAction {play,pause,toggle,seek,next,previous};
    struct Command { Action action; int bank = 0, pad = -1; double value = 0; bool overwrite = false; };
    struct Target { int bank = -1, pad = -1; };
    struct Sample {
        juce::AudioBuffer<float> audio;
        std::unique_ptr<PagedAudio> paged;
        double rate = 44100; juce::String path;
        int frames() const {return paged?paged->frames():audio.getNumSamples();}
        int channels() const {return paged?paged->channels():audio.getNumChannels();}
        float value(int frame,int channel) const {return paged?paged->value(frame,channel):audio.getSample(juce::jmin(channel,audio.getNumChannels()-1),frame);}
    };

    struct AudioResponse { int status=0; juce::StringPairArray headers; juce::MemoryBlock data; };
    using AudioTransport=std::function<AudioResponse(const juce::String&,const juce::String&,const std::function<bool()>&)>;
    explicit CueProcessor(AudioTransport = {});
    ~CueProcessor() override;
    const juce::String getName() const override { return JucePlugin_Name; }
    void prepareToPlay(double, int) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported(const BusesLayout&) const override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override;
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return fxTailSeconds.load(); }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock&) override;
    void setStateInformation(const void*, int) override;

    bool submit(Command); // Message-thread producer, audio-thread consumer.
    void loadFile(const juce::File&, bool preserveCues = false,int ticket = 0);
    void loadDemo(bool preserveCues = false);
    void loadFromApp(const juce::String& videoId, int port);
    void loadRemote(const juce::String& url, double startAt, juce::String trackId = {},bool prefetch=false,bool preservePlayIntent=false);
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
    bool performRemoteAction(RemoteAction,double position=0);
    juce::String getStatus() const;
    juce::var loadDiagnostics() const;
    void setEffectKernel(const juce::var&);
    juce::var effectKernelState() const;
    void setFxGraph(const juce::var&);
    juce::var fxGraphState() const;
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
    std::atomic<bool> backgroundPlayback{false};
    std::atomic<int> remoteTransportRevision{0};
    std::atomic<int> playIntentRevision{0};
    std::atomic<int> restoreRevision{0};
    std::atomic<int> editorWidth{0},editorHeight{0};

private:
    void execute(const Command&);
    void hit(int bank, int pad, bool replace, float velocity);
    void jump(double seconds, float velocity);
    void render(juce::AudioBuffer<float>&, int start, int count);
    bool prepareAudio(double from,double to);
    void renderBuffering(juce::AudioBuffer<float>&,int start,int count);
    float processEffect(float sample,int channel) const;
    void outputFrame(juce::AudioBuffer<float>&,int frame,beatmaker::dsp::Stereo voice,float gain);
    void handleMidi(const juce::MidiMessage&);
    void padEvent(int bank,int pad,bool down,bool triggered,float velocity);
    float read(double position, int channel) const;
    void publish(std::unique_ptr<Sample>, int generation, bool preserveCues);
    void failLoad(const juce::String&,int generation);
    void decodeFile(const juce::File&,bool preserveCues,int generation);
    std::array<std::array<std::atomic<double>, 16>, 10> cues;
    juce::AbstractFifo commands{256};
    std::array<Command, 256> commandData;
    const AudioTransport audioTransport;
    juce::ThreadPool loaders{2};
    std::atomic<int> loadGeneration{0};
    std::atomic<int> measuredLoadGeneration{0};
    std::atomic<double> loadStartedMs{0},loadDecoderMs{0},loadPcmReadMs{0},loadDownloadMs{0},loadPublishedMs{0},loadFirstRenderMs{0};
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
    std::atomic<juce::uint64> manualQueueRequest{0};
    std::atomic<int> manualQueueIntent{-1};
    std::atomic<bool> needAdvance{false},stopQueue{false},restartAtZero{false};
    std::thread queueThread;
    std::unique_ptr<StandaloneNowPlaying> standaloneNowPlaying;
    void runQueue();
    bool submitRemoteCommand(Command);
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
    bool cacheWaiting=false;
    int bufferingFadeRemaining=0;
    std::array<float,2> bufferingOrigin{};
    std::atomic<bool> cacheBuffering{false};
    std::atomic<int> cacheMisses{0};
    std::atomic<juce::uint64> requestedEffectKernel{0};
    beatmaker::dsp::Kernel currentEffectKernel=beatmaker::dsp::Kernel::none;
    int currentEffectBits=4;
    float currentEffectAmount=1;
    beatmaker::dsp::FxGraph nativeFxGraph;
    beatmaker::dsp::FxState requestedFxGraph;
    beatmaker::dsp::FxStateExchange fxGraphUpdates;
    std::atomic<double> fxTailSeconds{0.003},fxControlRate{44100};
    double stretchFraction=0;
    int stretchBlock=512;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(CueProcessor)
};
