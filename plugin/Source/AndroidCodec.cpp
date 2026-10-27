#include "AndroidCodec.h"
#include "LibraryStore.h"
#include "FileLock.h"
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaExtractor.h>
#include <fcntl.h>
#include <unistd.h>

juce::File decodeAndroidAudio(const juce::File& input,juce::String& error,const std::function<bool()>& cancelled){
    const auto directory=LibraryStore::defaultDirectory().getChildFile("Decoded");directory.createDirectory();
    const auto key=input.getFullPathName()+juce::String(input.getSize())+juce::String(input.getLastModificationTime().toMilliseconds());
    const auto decoded=directory.getChildFile(juce::String::toHexString(key.hashCode64())+".wav");
    LibraryFileLock lock(decoded.getFullPathName().toStdString()+".lock");
    const auto lockDeadline=juce::Time::getMillisecondCounterHiRes()+120000;
    while(!lock.enter(100)){if((cancelled&&cancelled())||juce::Time::getMillisecondCounterHiRes()>lockDeadline){error="Android decoding cancelled or timed out waiting for cache";return {};}}
    if(decoded.existsAsFile())return decoded;
    juce::TemporaryFile temporary(decoded);auto output=temporary.getFile().createOutputStream();
    if(!output){error="Cannot create Android decoded-audio cache";return {};}
    const int fd=::open(input.getFullPathName().toRawUTF8(),O_RDONLY);
    if(fd<0){error="Cannot open Android audio source";return {};}
    struct Close{int fd;~Close(){::close(fd);}}close{fd};
    auto* extractor=AMediaExtractor_new();
    struct Extractor{AMediaExtractor* value;~Extractor(){if(value)AMediaExtractor_delete(value);}}extractorOwner{extractor};
    if(!extractor||AMediaExtractor_setDataSourceFd(extractor,fd,0,input.getSize())!=AMEDIA_OK){error="Cannot inspect Android audio";return {};}
    AMediaFormat* format=nullptr;const char* mime=nullptr;
    for(size_t i=0;i<AMediaExtractor_getTrackCount(extractor);++i){auto* candidate=AMediaExtractor_getTrackFormat(extractor,i);const char* type=nullptr;
        if(candidate&&AMediaFormat_getString(candidate,AMEDIAFORMAT_KEY_MIME,&type)&&juce::String(type).startsWith("audio/")){format=candidate;AMediaExtractor_selectTrack(extractor,i);AMediaFormat_getString(format,AMEDIAFORMAT_KEY_MIME,&mime);break;}if(candidate)AMediaFormat_delete(candidate);
    }
    if(!format||!mime){error="Android source has no audio track";return {};}
    struct Format{AMediaFormat* value;~Format(){AMediaFormat_delete(value);}}formatOwner{format};
    AMediaFormat_setInt32(format,"pcm-encoding",4); // Ask for float; accept PCM16 if the decoder chooses it.
    auto* codec=AMediaCodec_createDecoderByType(mime);
    if(!codec){error="Android has no decoder for this audio format";return {};}
    struct Codec{AMediaCodec* value;bool started=false;~Codec(){if(started)AMediaCodec_stop(value);AMediaCodec_delete(value);}}codecOwner{codec};
    if(AMediaCodec_configure(codec,format,nullptr,nullptr,0)!=AMEDIA_OK||AMediaCodec_start(codec)!=AMEDIA_OK){error="Cannot start Android audio decoder";return {};}
    codecOwner.started=true;
    bool inputEnded=false,ended=false,header=false;int32_t channels=0,rate=0,encoding=2;juce::int64 written=0;
    const auto deadline=juce::Time::getMillisecondCounterHiRes()+120000;
    while(!ended){
        if((cancelled&&cancelled())||juce::Time::getMillisecondCounterHiRes()>deadline){error="Android decoding cancelled or timed out";return {};}
        // Keep the decoder pipeline full. Waiting after every encoded frame
        // serialises IPC and makes the initial full-file conversion very slow.
        for(int fed=0;fed<16&&!inputEnded;++fed){const auto index=AMediaCodec_dequeueInputBuffer(codec,0);if(index>=0){size_t capacity=0;auto* data=AMediaCodec_getInputBuffer(codec,(size_t)index,&capacity);
            if(!data||!capacity){error="Android decoder returned an invalid input buffer";return {};}
            const auto count=AMediaExtractor_readSampleData(extractor,data,capacity);
            if(count<0){inputEnded=true;AMediaCodec_queueInputBuffer(codec,(size_t)index,0,0,0,AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM);}
            else if((size_t)count<=capacity){const auto time=AMediaExtractor_getSampleTime(extractor);AMediaCodec_queueInputBuffer(codec,(size_t)index,0,(size_t)count,(uint64_t)juce::jmax((int64_t)0,time),0);AMediaExtractor_advance(extractor);}
            else {error="Invalid Android encoded-audio buffer";return {};}
        }else if(index==AMEDIACODEC_INFO_TRY_AGAIN_LATER)break;else{error="Android decoder input failed";return {};}}
        AMediaCodecBufferInfo info{};const auto index=AMediaCodec_dequeueOutputBuffer(codec,&info,10000);
        if(index==AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED||(!header&&index>=0)){
            auto* actual=AMediaCodec_getOutputFormat(codec);if(actual){AMediaFormat_getInt32(actual,AMEDIAFORMAT_KEY_CHANNEL_COUNT,&channels);AMediaFormat_getInt32(actual,AMEDIAFORMAT_KEY_SAMPLE_RATE,&rate);AMediaFormat_getInt32(actual,"pcm-encoding",&encoding);AMediaFormat_delete(actual);}
            if(channels<1||channels>2||rate<8000||rate>384000||(encoding!=2&&encoding!=4)){error="Unsupported Android PCM output";return {};}
            if(!header){for(int i=0;i<44;++i)output->writeByte(0);header=true;}
        }
        if(index>=0){size_t capacity=0;const auto* data=AMediaCodec_getOutputBuffer(codec,(size_t)index,&capacity);
            if(info.size>0){if(!header||!data||info.offset<0||info.size<0||(size_t)info.offset+(size_t)info.size>capacity||written+info.size>2LL*1024*1024*1024){AMediaCodec_releaseOutputBuffer(codec,(size_t)index,false);error="Android decoded audio exceeds the supported disk budget";return {};}
                if(!output->write(data+info.offset,(size_t)info.size)){AMediaCodec_releaseOutputBuffer(codec,(size_t)index,false);error="Cannot write Android PCM cache";return {};}written+=info.size;
            }
            ended=(info.flags&AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM)!=0;AMediaCodec_releaseOutputBuffer(codec,(size_t)index,false);
        }else if(index!=AMEDIACODEC_INFO_TRY_AGAIN_LATER&&index!=AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED&&index!=AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED){error="Android audio decoding failed";return {};}
    }
    const int bytes=encoding==4?4:2;if(!header||written<channels*bytes*2||written%(channels*bytes)){error="Android decoder returned incomplete PCM";return {};}
    output->setPosition(0);output->write("RIFF",4);output->writeInt((int)(written+36));output->write("WAVEfmt ",8);output->writeInt(16);output->writeShort((short)(encoding==4?3:1));output->writeShort((short)channels);output->writeInt(rate);output->writeInt(rate*channels*bytes);output->writeShort((short)(channels*bytes));output->writeShort((short)(bytes*8));output->write("data",4);output->writeInt((int)written);output->flush();
    if(output->getStatus().failed()){error="Android PCM cache flush failed";return {};}output.reset();
    if(!temporary.overwriteTargetFileWithTemporary()){error="Cannot publish Android PCM cache";return {};}return decoded;
}
