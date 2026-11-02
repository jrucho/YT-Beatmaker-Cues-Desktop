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
    // Smaller pages warm a cue attack without decoding seconds around every
    // mark. More slots retain the same 16 MiB stereo PCM budget.
    static constexpr int pageFrames=8192, pageSlots=256;
    static_assert(pageFrames*pageSlots==2*1024*1024,"Keep the fixed stereo PCM budget");
    static constexpr int residentFrameLimit=4*1024*1024;
    static constexpr int maxFrames=0x7ffffffe;
    PagedAudio(std::unique_ptr<juce::AudioFormatReader>,int startFrame);
    ~PagedAudio();
    int frames() const {return length;}
    int channels() const {return channelCount;}
    bool prepareRange(double from,double to); // Audio thread only, no IO/locks/allocation.
    float value(int frame,int channel) const;
    void releasePages(); // Audio thread, once per processBlock.
    void setCue(int index,double seconds) {
        const int frame=std::isfinite(seconds)&&seconds>=0?juce::jlimit(0,length-1,(int)juce::jmin(seconds*rate,(double)length-1)):-1;
        if(cueFrames[(size_t)index].exchange(frame)!=frame)++cueHintsRevision;
    }
    void setLoop(double from,double to,bool enabled) {setCue(160,enabled?from:-1);setCue(161,enabled?to:-1);}
    void setCueBank(int bank) {bank=juce::jlimit(0,9,bank);if(cueBank.exchange(bank)!=bank)++cueHintsRevision;}
    int readyCueHeads(int bank) const;
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
    std::atomic<int> cueBank{0};
    std::atomic<unsigned> cueHintsRevision{0};
    std::atomic<juce::uint64> requestedRange{0};
    std::atomic<bool> stopping{false},readFailed{false};
    std::atomic<int> cachedPages{0},reads{0};
    std::thread worker;
    bool load(int page,const std::array<int,pageSlots>& wanted,int wantedCount);
    int cueHistoryFrames() const {return juce::jmin(pageFrames*2,(int)std::ceil(rate*.04));}
    int cueFirstPage(int frame) const {return juce::jmax(0,frame-cueHistoryFrames())/pageFrames;}
    // Keep enough continuation for the stream reader to catch up after a hit,
    // bounded per pad so all sixteen attacks fit even at high source rates.
    int cueLastPage(int frame) const {return (int)juce::jmin((juce::int64)length-1,(juce::int64)frame+juce::jmin((int)std::ceil(rate),pageFrames*10-cueHistoryFrames()))/pageFrames;}
    void run();
};
