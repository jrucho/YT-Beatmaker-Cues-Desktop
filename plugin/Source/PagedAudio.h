#pragma once
#include <juce_audio_formats/juce_audio_formats.h>
#include <array>
#include <atomic>
#include <thread>
#include <cmath>

/** Fixed-size PCM cache. Decoder/IO and page eviction run off the audio thread.
 * The sole audio reader pins pages until its render segment completes; it never waits
 * for a missing page. A cold jump asks the worker for that range and is retried
 * by the processor after a short fade to silence.
 */
class PagedAudio final {
public:
    static_assert(std::atomic<juce::uint64>::is_always_lock_free&&std::atomic<void*>::is_always_lock_free,"Audio cache needs lock-free atomics");
    static constexpr int pageFrames=32768, pageSlots=64;
    static constexpr int residentFrameLimit=4*1024*1024;
    static constexpr int maxFrames=0x7ffffffe;
    PagedAudio(std::unique_ptr<juce::AudioFormatReader>,int startFrame);
    ~PagedAudio();
    int frames() const {return length;}
    int channels() const {return channelCount;}
    bool prepareRange(double from,double to); // Audio thread only, no IO/locks/allocation.
    float value(int frame,int channel) const;
    void releasePages(); // Audio thread, once per processBlock.
    void setCue(int index,double seconds) {cueFrames[(size_t)index].store(std::isfinite(seconds)&&seconds>=0?juce::jlimit(0,length-1,(int)juce::jmin(seconds*rate,(double)length-1)):-1);}
    void setLoop(double from,double to,bool enabled) {setCue(160,enabled?from:-1);setCue(161,enabled?to:-1);}
    bool failed() const {return readFailed.load();}
    size_t pcmBytes() const {return (size_t)pageSlots*pageFrames*channelCount*sizeof(float);}
    int loadedPages() const {return cachedPages.load();}
    int decoderReads() const {return reads.load();}
    double bufferedTo(double seconds) const;
private:
    struct Page {juce::AudioBuffer<float> audio;int number=-1,slot=0;};
    const int length,channelCount,pageCount;
    const double rate;
    std::unique_ptr<juce::AudioFormatReader> reader;
    std::array<Page,pageSlots> pages;
    std::unique_ptr<std::atomic<Page*>[]> table;
    std::unique_ptr<Page*[]> pinnedTable;
    std::array<std::atomic<Page*>,pageSlots> hazards{};
    std::array<std::atomic<int>,162> cueFrames;
    std::atomic<juce::uint64> requestedRange{0};
    std::atomic<bool> stopping{false},readFailed{false};
    std::atomic<int> cachedPages{0},reads{0};
    std::thread worker;
    bool load(int page,const std::array<int,pageSlots>& wanted,int wantedCount);
    void run();
};
