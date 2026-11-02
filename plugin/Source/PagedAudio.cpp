#include "PagedAudio.h"
#include <algorithm>
#include <cmath>
#include <stdexcept>

PagedAudio::PagedAudio(std::unique_ptr<juce::AudioFormatReader> source,int startFrame)
    :length((int)source->lengthInSamples),channelCount(juce::jmin(2,(int)source->numChannels)),
     pageCount((length-1)/pageFrames+1),rate(source->sampleRate),reader(std::move(source)),
     table(std::make_unique<std::atomic<Page*>[]>((size_t)pageCount)),pinnedTable(std::make_unique<Page*[]>((size_t)pageCount)) {
    for(int i=0;i<pageCount;++i)table[(size_t)i].store(nullptr);
    for(auto& hazard:hazards)hazard.store(nullptr);
    for(auto& cue:cueFrames)cue.store(-1);
    for(int i=0;i<pageSlots;++i){pages[(size_t)i].slot=i;pages[(size_t)i].audio.setSize(channelCount,pageFrames);}
    const int first=juce::jlimit(0,length-1,startFrame)/pageFrames;
    requestedRange.store(((juce::uint64)first<<32)|(juce::uint32)first);
    std::array<int,pageSlots> wanted{};int count=0;
    for(int page=juce::jmax(0,first-1);page<=juce::jmin(pageCount-1,first+2);++page)wanted[(size_t)count++]=page;
    for(int i=0;i<count;++i)if(!load(wanted[(size_t)i],wanted,count))throw std::runtime_error("Cannot decode the initial audio pages");
    worker=std::thread([this]{run();});
}
PagedAudio::~PagedAudio(){stopping.store(true);if(worker.joinable())worker.join();}

bool PagedAudio::prepareRange(double from,double to){
    if(to<0||from>=length)return true;
    if(!std::isfinite(from)||!std::isfinite(to)||to<from)return false;
    const int first=(int)juce::jlimit(0.0,(double)length-1,std::floor(from))/pageFrames;
    const int last=(int)juce::jlimit(0.0,(double)length-1,std::ceil(to))/pageFrames;
    requestedRange.store(((juce::uint64)first<<32)|(juce::uint32)last);
    if(last-first>=pageSlots)return false;
    bool available=true;
    for(int i=first;i<=last;++i){
        if(pinnedTable[(size_t)i])continue;
        auto* page=table[(size_t)i].load();
        if(!page){available=false;continue;}
        hazards[(size_t)page->slot].store(page);
        // Standard hazard-pointer publication/recheck. The worker unpublishes
        // before checking hazards and cannot overwrite any successfully pinned page.
        if(table[(size_t)i].load()!=page){hazards[(size_t)page->slot].store(nullptr);available=false;}
        else pinnedTable[(size_t)i]=page;
    }
    return available;
}
float PagedAudio::value(int frame,int channel) const {
    if(frame<0||frame>=length)return 0;
    const auto* page=pinnedTable[(size_t)(frame/pageFrames)];
    return page?page->audio.getSample(juce::jmin(channel,channelCount-1),frame%pageFrames):0;
}
void PagedAudio::releasePages(){for(auto& hazard:hazards){if(auto* page=hazard.load())pinnedTable[(size_t)page->number]=nullptr;hazard.store(nullptr);}}
double PagedAudio::bufferedTo(double seconds) const {
    int page=(int)juce::jlimit(0.0,(double)length-1,seconds*rate)/pageFrames;
    if(!table[(size_t)page].load())return seconds;
    while(page<pageCount&&table[(size_t)page].load())++page;
    return juce::jmin((double)length,(double)page*pageFrames)/rate;
}
int PagedAudio::readyCueHeads(int bank) const {
    int ready=0;
    for(int pad=0;pad<16;++pad){
        const int frame=cueFrames[(size_t)(juce::jlimit(0,9,bank)*16+pad)].load();if(frame<0)continue;
        bool resident=true;
        for(int page=cueFirstPage(frame);page<=cueLastPage(frame);++page)resident=resident&&table[(size_t)page].load()!=nullptr;
        if(resident)++ready;
    }
    return ready;
}

bool PagedAudio::load(int number,const std::array<int,pageSlots>& wanted,int wantedCount){
    if(table[(size_t)number].load())return true;
    Page* destination=nullptr;
    for(auto& page:pages)if(page.number<0){destination=&page;break;}
    if(!destination)for(auto& page:pages){
        if(std::find(wanted.begin(),wanted.begin()+wantedCount,page.number)==wanted.begin()+wantedCount){destination=&page;break;}
    }
    if(!destination)return false;
    if(destination->number>=0){
        table[(size_t)destination->number].store(nullptr);
        while(hazards[(size_t)destination->slot].load()==destination){if(stopping.load())return false;juce::Thread::sleep(1);}
        --cachedPages;
    }
    destination->number=-1;
    ++reads;
    const auto start=(juce::int64)number*pageFrames;
    const int count=(int)juce::jmin((juce::int64)pageFrames,length-start);
    if(!reader->read(&destination->audio,0,count,start,true,true)){readFailed.store(true);return false;}
    if(count<pageFrames)destination->audio.clear(count,pageFrames-count);
    destination->number=number;
    table[(size_t)number].store(destination);++cachedPages;return true;
}
void PagedAudio::run(){
    int playbackFirst=-1,playbackLast=-1;
    while(!stopping.load()&&!readFailed.load()){
        const auto request=requestedRange.load();
        const auto hints=cueHintsRevision.load();
        const int first=(int)(request>>32),last=(int)(request&0xffffffffu);
        // Refill a multi-second playback window in chunks. Extending it one
        // page on every callback repeatedly seeks the sole decoder away from
        // cue preparation, starving distant banks while playback advances.
        if(first<playbackFirst||last>playbackLast||playbackLast-last<16){
            playbackFirst=juce::jmax(0,first-2);playbackLast=juce::jmin(pageCount-1,last+32);
        }
        std::array<int,pageSlots> wanted{};int count=0;
        const auto add=[&](int number){if(number>=0&&number<pageCount&&count<pageSlots&&std::find(wanted.begin(),wanted.begin()+count,number)==wanted.begin()+count)wanted[(size_t)count++]=number;};
        for(int i=first;i<=last&&count<pageSlots;++i)add(i);
        for(int page=last+1;page<=playbackLast;++page)add(page);
        add(first-1);add(first-2);
        // Reserve the performing bank before filling spare slots with other
        // banks. A-to-J order otherwise evicts every later-bank attack as soon
        // as the song has more marked cues than the bounded cache can hold.
        const auto addCue=[&](int index){const int frame=cueFrames[(size_t)index].load();if(frame>=0)for(int page=cueFirstPage(frame);page<=cueLastPage(frame);++page)add(page);};
        for(int i=160;i<162;++i)addCue(i);
        const int active=cueBank.load()*16;
        for(int pad=0;pad<160&&count<pageSlots;++pad)addCue((active+pad)%160);
        for(int i=0;i<count&&!stopping.load()&&!readFailed.load();++i){
            if(requestedRange.load()!=request||cueHintsRevision.load()!=hints)break;
            load(wanted[(size_t)i],wanted,count);
        }
        juce::Thread::sleep(2);
    }
}
