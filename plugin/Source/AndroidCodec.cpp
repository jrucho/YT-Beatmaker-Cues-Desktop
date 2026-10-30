#include "AndroidCodec.h"
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaExtractor.h>
#include <fcntl.h>
#include <unistd.h>
#include <cmath>
#include <cstring>
#include <vector>
#include <stdexcept>

namespace {
// Used only by the load/page workers. No codec access, allocation or seeking
// happens in the audio callback; PagedAudio remains the bounded PCM front end.
class AndroidStreamReader final : public juce::AudioFormatReader {
public:
    AndroidStreamReader() : AudioFormatReader(nullptr,"Android MediaCodec") {
        usesFloatingPointData=true;bitsPerSample=32;
    }
    ~AndroidStreamReader() override {
        if(codec){if(started)AMediaCodec_stop(codec);AMediaCodec_delete(codec);}
        if(extractor)AMediaExtractor_delete(extractor);
        if(fd>=0)::close(fd);
    }
    bool open(const juce::File& file,juce::String& error,const std::function<bool()>& cancelled){
        fd=::open(file.getFullPathName().toRawUTF8(),O_RDONLY);
        extractor=AMediaExtractor_new();
        if(fd<0||!extractor||AMediaExtractor_setDataSourceFd(extractor,fd,0,file.getSize())!=AMEDIA_OK){error="Cannot inspect Android audio source";return false;}
        AMediaFormat* format=nullptr;
        for(size_t i=0;i<AMediaExtractor_getTrackCount(extractor);++i){
            auto* candidate=AMediaExtractor_getTrackFormat(extractor,i);const char* mime=nullptr;
            if(candidate&&AMediaFormat_getString(candidate,AMEDIAFORMAT_KEY_MIME,&mime)&&juce::String(mime).startsWith("audio/")){
                format=candidate;aac=juce::String(mime)=="audio/mp4a-latm";AMediaExtractor_selectTrack(extractor,i);codec=AMediaCodec_createDecoderByType(mime);break;
            }
            if(candidate)AMediaFormat_delete(candidate);
        }
        if(!format||!codec){if(format)AMediaFormat_delete(format);error="Android source has no supported audio decoder";return false;}
        int32_t rate=0,channels=0;
        AMediaFormat_getInt32(format,AMEDIAFORMAT_KEY_SAMPLE_RATE,&rate);
        AMediaFormat_getInt32(format,AMEDIAFORMAT_KEY_CHANNEL_COUNT,&channels);
        AMediaFormat_getInt64(format,AMEDIAFORMAT_KEY_DURATION,&durationUs);
        AMediaFormat_setInt32(format,"pcm-encoding",2);
        const auto configured=AMediaCodec_configure(codec,format,nullptr,nullptr,0);AMediaFormat_delete(format);
        if(configured!=AMEDIA_OK||AMediaCodec_start(codec)!=AMEDIA_OK){error="Cannot start Android audio decoder";return false;}
        started=true;sampleRate=rate;numChannels=(unsigned)channels;
        if(!validFormat()||durationUs<=0){error="Unsupported Android audio metadata";return false;}
        if((cancelled&&cancelled())||!nextChunk(cancelled)){error="Cannot prime Android audio decoder";return false;}
        lengthInSamples=(juce::int64)std::llround(durationUs*sampleRate/1000000.0);
        return lengthInSamples>1;
    }
    bool readSamples(int* const* destinations,int destinationChannels,int destinationOffset,juce::int64 start,int count) override {
        if(start!=readPosition&&!seek(start))return false;
        const auto deadline=juce::Time::getMillisecondCounterHiRes()+15000;
        int written=0;
        while(written<count){
            if(juce::Time::getMillisecondCounterHiRes()>deadline)return false;
            const auto position=start+written;
            const auto end=chunkStart+chunkFrames;
            if(position>=end){
                if(outputEnded){clear(destinations,destinationChannels,destinationOffset+written,count-written);break;}
                if(!nextChunk({}))return false;
                continue;
            }
            if(position<chunkStart){
                const int gap=(int)juce::jmin((juce::int64)(count-written),chunkStart-position);
                clear(destinations,destinationChannels,destinationOffset+written,gap);written+=gap;continue;
            }
            const int frames=(int)juce::jmin((juce::int64)(count-written),end-position);
            const auto offset=(size_t)(position-chunkStart);
            for(int channel=0;channel<destinationChannels;++channel){
                if(!destinations[channel])continue;
                auto* out=reinterpret_cast<float*>(destinations[channel])+destinationOffset+written;
                if(channel>=(int)numChannels){std::fill(out,out+frames,0.0f);continue;}
                for(int frame=0;frame<frames;++frame){
                    const auto sample=(offset+(size_t)frame)*numChannels+(unsigned)channel;
                    if(encoding==4){float value;std::memcpy(&value,chunk.data()+sample*4,4);out[frame]=value;}
                    else{int16_t value;std::memcpy(&value,chunk.data()+sample*2,2);out[frame]=(float)value/32768.0f;}
                }
            }
            written+=frames;
        }
        readPosition=start+count;return true;
    }
private:
    bool validFormat() const{return sampleRate>=8000&&sampleRate<=384000&&numChannels>=1&&numChannels<=2;}
    static void clear(int* const* destinations,int channels,int offset,int count){
        for(int c=0;c<channels;++c)if(destinations[c])std::fill_n(reinterpret_cast<float*>(destinations[c])+offset,count,0.0f);
    }
    bool seek(juce::int64 frame){
        // AAC needs a little preroll to reconstruct its overlapping filterbank.
        const auto time=(int64_t)juce::jmax(0.0,(frame/sampleRate-0.05)*1000000.0);
        if(AMediaExtractor_seekTo(extractor,time,AMEDIAEXTRACTOR_SEEK_PREVIOUS_SYNC)!=AMEDIA_OK||AMediaCodec_flush(codec)!=AMEDIA_OK)return false;
        inputEnded=false;outputEnded=false;chunk.clear();chunkFrames=0;chunkStart=0;nextFrame=-1;previousInputTime=-1;readPosition=frame;
        return true;
    }
    bool nextChunk(const std::function<bool()>& cancelled){
        const auto deadline=juce::Time::getMillisecondCounterHiRes()+15000;
        while(!outputEnded){
            if((cancelled&&cancelled())||juce::Time::getMillisecondCounterHiRes()>deadline)return false;
            for(int fed=0;fed<16&&!inputEnded;++fed){
                const auto index=AMediaCodec_dequeueInputBuffer(codec,0);
                if(index==AMEDIACODEC_INFO_TRY_AGAIN_LATER)break;
                if(index<0)return false;
                size_t capacity=0;auto* data=AMediaCodec_getInputBuffer(codec,(size_t)index,&capacity);
                if(!data||capacity==0)return false;
                const auto bytes=AMediaExtractor_readSampleData(extractor,data,capacity);
                media_status_t queued;
                if(bytes<0){inputEnded=true;queued=AMediaCodec_queueInputBuffer(codec,(size_t)index,0,0,0,AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM);}
                else if((size_t)bytes<=capacity){
                    const auto time=juce::jmax((int64_t)0,AMediaExtractor_getSampleTime(extractor));
                    if(aac&&accessUnitFrames==0&&previousInputTime>=0){
                        const double frames=(time-previousInputTime)*sampleRate/1000000.0;
                        for(const int size:{480,512,960,1024,1920,2048,4096})if(std::abs(frames-size)<2.0){accessUnitFrames=size;break;}
                    }
                    previousInputTime=time;
                    queued=AMediaCodec_queueInputBuffer(codec,(size_t)index,0,(size_t)bytes,(uint64_t)time,0);AMediaExtractor_advance(extractor);
                }else return false;
                if(queued!=AMEDIA_OK)return false;
            }
            AMediaCodecBufferInfo info{};const auto index=AMediaCodec_dequeueOutputBuffer(codec,&info,10000);
            if(index==AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED){
                auto* format=AMediaCodec_getOutputFormat(codec);if(!format)return false;
                int32_t rate=(int32_t)sampleRate,channels=(int32_t)numChannels;
                AMediaFormat_getInt32(format,AMEDIAFORMAT_KEY_SAMPLE_RATE,&rate);AMediaFormat_getInt32(format,AMEDIAFORMAT_KEY_CHANNEL_COUNT,&channels);
                AMediaFormat_getInt32(format,"pcm-encoding",&encoding);AMediaFormat_delete(format);
                if(lengthInSamples>0&&(rate!=(int)sampleRate||channels!=(int)numChannels))return false;
                sampleRate=rate;numChannels=(unsigned)channels;
                if(!validFormat()||(encoding!=2&&encoding!=4))return false;
            }else if(index>=0){
                size_t capacity=0;const auto* data=AMediaCodec_getOutputBuffer(codec,(size_t)index,&capacity);
                outputEnded=(info.flags&AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM)!=0;
                if(info.size>0){
                    const auto stride=numChannels*(encoding==4?4u:2u);
                    if(!data||info.offset<0||(size_t)info.offset+(size_t)info.size>capacity||info.size>8*1024*1024||(size_t)info.size%stride){AMediaCodec_releaseOutputBuffer(codec,(size_t)index,false);return false;}
                    chunk.assign(data+info.offset,data+info.offset+info.size);
                    chunkFrames=(juce::int64)((size_t)info.size/stride);
                    // Android rounds AAC timestamps to microseconds. Snap seek
                    // starts back to the inferred access-unit grid so a codec
                    // timestamp rounding error cannot shift a page by a frame.
                    const double frameTime=info.presentationTimeUs*sampleRate/1000000.0;
                    const auto timestampFrame=accessUnitFrames>0?(juce::int64)std::llround(frameTime/accessUnitFrames)*accessUnitFrames:(juce::int64)std::llround(frameTime);
                    chunkStart=nextFrame>=0?nextFrame:timestampFrame;
                    nextFrame=chunkStart+chunkFrames;
                    AMediaCodec_releaseOutputBuffer(codec,(size_t)index,false);return true;
                }
                AMediaCodec_releaseOutputBuffer(codec,(size_t)index,false);
            }else if(index!=AMEDIACODEC_INFO_TRY_AGAIN_LATER&&index!=AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED)return false;
        }
        chunkFrames=0;chunkStart=nextFrame>=0?nextFrame:0;return true;
    }
    int fd=-1;AMediaExtractor* extractor=nullptr;AMediaCodec* codec=nullptr;
    bool started=false,inputEnded=false,outputEnded=false;
    bool aac=false;int accessUnitFrames=0;int64_t previousInputTime=-1;
    int32_t encoding=2;int64_t durationUs=0;
    juce::int64 readPosition=0,chunkStart=0,chunkFrames=0,nextFrame=-1;
    std::vector<uint8_t> chunk;
};
}
std::unique_ptr<juce::AudioFormatReader> createAndroidAudioReader(const juce::File& input,juce::String& error,const std::function<bool()>& cancelled){
    auto reader=std::make_unique<AndroidStreamReader>();
    if(!reader->open(input,error,cancelled))return {};
    return reader;
}
#if JUCE_DEBUG
juce::var checkAndroidReaderPCM(const juce::File& encoded,const juce::File& pcm){
    juce::String error;auto reader=createAndroidAudioReader(encoded,error,{});
    juce::WavAudioFormat format;std::unique_ptr<juce::AudioFormatReader> reference(format.createReaderFor(pcm.createInputStream().release(),true));
    if(!reader||!reference)throw std::runtime_error(("PCM comparison: "+error).toStdString());
    if(reader->sampleRate!=reference->sampleRate||reader->numChannels!=reference->numChannels)throw std::runtime_error("PCM comparison format mismatch");
    juce::Array<juce::var> results;
    for(const auto start:{juce::int64(0),juce::int64(reader->sampleRate),reader->lengthInSamples/10,reader->lengthInSamples/2,reader->lengthInSamples*83/100,reader->lengthInSamples-(juce::int64)(reader->sampleRate*30),juce::int64(0)}){
        juce::AudioBuffer<float> actual((int)reader->numChannels,4096),expected((int)reader->numChannels,4096);
        if(!reader->read(&actual,0,4096,start,true,true)||!reference->read(&expected,0,4096,start,true,true))throw std::runtime_error("PCM comparison read failed");
        double maximum=0,squared=0,energy=0;
        for(int c=0;c<actual.getNumChannels();++c)for(int i=0;i<4096;++i){const double a=actual.getSample(c,i),b=expected.getSample(c,i),difference=a-b;maximum=juce::jmax(maximum,std::abs(difference));squared+=difference*difference;energy+=b*b;}
        int bestOffset=0;double bestError=squared;
        if(start>=16){juce::AudioBuffer<float> neighbours((int)reader->numChannels,4128);reference->read(&neighbours,0,4128,start-16,true,true);
            for(int shift=-16;shift<=16;++shift){double total=0;for(int c=0;c<actual.getNumChannels();++c)for(int i=0;i<4096;++i){const double difference=actual.getSample(c,i)-neighbours.getSample(c,i+16+shift);total+=difference*difference;}if(total<bestError){bestError=total;bestOffset=shift;}}
        }
        auto* row=new juce::DynamicObject;row->setProperty("frame",start);row->setProperty("maxError",maximum);row->setProperty("normalizedRms",std::sqrt(squared/juce::jmax(1e-12,energy)));row->setProperty("bestFrameOffset",bestOffset);row->setProperty("alignedRms",std::sqrt(bestError/juce::jmax(1e-12,energy)));row->setProperty("peak",actual.getMagnitude(0,4096));results.add(juce::var(row));
    }
    return juce::var(results);
}
#endif
