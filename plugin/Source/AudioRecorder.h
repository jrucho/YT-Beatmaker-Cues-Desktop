#pragma once
#include <juce_audio_formats/juce_audio_formats.h>
#include <array>
#include <atomic>
#include <mutex>
#include <cmath>

/** One selected producer (device input OR rendered playback), bounded SPSC PCM
 * FIFO and a disk worker. The render/input callbacks never lock, allocate or do
 * file I/O. A stopped/interrupted take stays retained until explicitly finished. */
class AudioRecorder final {
public:
    ~AudioRecorder(){try{finish();}catch(...) {}}
    enum Fault {none,routeChanged,rateChanged,bufferFull,diskError,lengthLimit};
    void start(const juce::File& file,double rate,bool playback){
        std::lock_guard<std::mutex> lock(control);
        if(take)throw std::runtime_error("Finish the current recording first");
        if(!std::isfinite(rate)||rate<8000||rate>192000)throw std::runtime_error("Audio device is not ready");
        auto next=std::make_unique<Take>(file,rate,playback);next->startThread();take=std::move(next);interrupted.store(false);active.store(take.get());
    }
    void capture(const float* const* channels,int count,int frames,double rate,bool playback) noexcept {
        const size_t slot=playback?1:0;Take* current;
        do{current=active.load();hazards[slot].store(current);}while(current!=active.load());
        if(current&&current->playback==playback&&current->fault.load()==none){
            if(interrupted.load())current->fault.store(routeChanged);
            else if(std::abs(rate-current->rate)>.1)current->fault.store(rateChanged);
            else if(count<1||!channels||!channels[0])current->fault.store(routeChanged);
            else if(current->frames.load()+frames>(juce::int64)(current->rate*20*60))current->fault.store(lengthLimit);
            else{
                int first,n1,second,n2;current->fifo.prepareToWrite(frames,first,n1,second,n2);
                if(n1+n2!=frames)current->fault.store(bufferFull);
                else{
                    for(int c=0;c<2;++c){const auto* source=channels[juce::jmin(c,count-1)];auto* dest=current->pcm.getWritePointer(c);
                        const auto copy=[&](int at,int size,int offset){for(int i=0;i<size;++i){const float value=source?source[offset+i]:0;dest[at+i]=std::isfinite(value)?juce::jlimit(-1.0f,1.0f,value):0;}};
                        copy(first,n1,0);copy(second,n2,n1);}
                    current->fifo.finishedWrite(frames);current->frames.fetch_add(frames);
                }
            }
        }
        hazards[slot].store(nullptr);
    }
    void interrupt() noexcept {interrupted.store(true);}
    bool hasTake() const {std::lock_guard<std::mutex> lock(control);return take!=nullptr;}
    juce::var state() const {
        std::lock_guard<std::mutex> lock(control);auto* result=new juce::DynamicObject;result->setProperty("hasTake",take!=nullptr);
        result->setProperty("recording",take&&take->fault.load()==none&&!interrupted.load());result->setProperty("seconds",take?take->frames.load()/take->rate:0);
        result->setProperty("source",take&&take->playback?"playback":"input");result->setProperty("message",take?faultText(take->fault.load()!=none?take->fault.load():interrupted.load()?routeChanged:none):juce::String{});return juce::var(result);
    }
    juce::var finish(){
        std::lock_guard<std::mutex> lock(control);if(!take)return {};
        active.store(nullptr);for(const auto& hazard:hazards)while(hazard.load()!=nullptr)juce::Thread::yield();
        if(interrupted.load()){int expected=none;take->fault.compare_exchange_strong(expected,routeChanged);}
        take->signalThreadShouldExit();take->notify();take->waitForThreadToExit(-1);take->writer.reset();
        auto* result=new juce::DynamicObject;result->setProperty("path",take->file.getFullPathName());result->setProperty("frames",take->frames.load());result->setProperty("rate",take->rate);
        result->setProperty("source",take->playback?"playback":"input");result->setProperty("message",faultText(take->fault.load()));take.reset();return juce::var(result);
    }
private:
    struct Take final:juce::Thread {
        static constexpr int capacity=262144;
        Take(const juce::File& path,double sampleRate,bool fromPlayback):Thread("Beatmaker recording writer"),file(path),rate(sampleRate),playback(fromPlayback),fifo(capacity),pcm(2,capacity){
            if(!file.getParentDirectory().createDirectory())throw std::runtime_error("Cannot create recording storage");
            juce::WavAudioFormat format;std::unique_ptr<juce::OutputStream> stream=file.createOutputStream();writer=format.createWriterFor(stream,juce::AudioFormatWriterOptions{}.withSampleRate(rate).withNumChannels(2).withBitsPerSample(24));
            if(!writer)throw std::runtime_error("Cannot create recording WAV");
        }
        void run() override {
            while(!threadShouldExit()||fifo.getNumReady()>0){
                int first,n1,second,n2;fifo.prepareToRead(fifo.getNumReady(),first,n1,second,n2);
                if(n1&&!writer->writeFromAudioSampleBuffer(pcm,first,n1))fault.store(diskError);
                if(n2&&!writer->writeFromAudioSampleBuffer(pcm,second,n2))fault.store(diskError);
                fifo.finishedRead(n1+n2);
                if(juce::Time::getMillisecondCounter()-flushed>1000){if(!writer->flush())fault.store(diskError);flushed=juce::Time::getMillisecondCounter();}
                if(!n1&&!n2)wait(5);
            }
            if(!writer->flush())fault.store(diskError);
        }
        juce::File file;const double rate;const bool playback;juce::AbstractFifo fifo;juce::AudioBuffer<float> pcm;
        std::unique_ptr<juce::AudioFormatWriter> writer;std::atomic<juce::int64> frames{0};std::atomic<int> fault{none};juce::uint32 flushed=0;
    };
    static juce::String faultText(int fault){switch(fault){case routeChanged:return "Audio route changed · finish to keep this take";case rateChanged:return "Sample rate changed · finish to keep this take";case bufferFull:return "Recording buffer filled · finish to keep this take";case diskError:return "Recording write failed · retained take needs recovery";case lengthLimit:return "20-minute take limit reached · finish to keep this take";default:return {};}}
    mutable std::mutex control;std::unique_ptr<Take> take;std::atomic<Take*> active{nullptr};std::array<std::atomic<Take*>,2> hazards{};std::atomic<bool> interrupted{false};
};
