#include "Processor.h"
#include <iostream>
#include <stdexcept>
#include <cstdlib>

namespace { thread_local bool onAudioThread=false; thread_local size_t audioAllocations=0; }
void* operator new(std::size_t size){if(onAudioThread)++audioAllocations;if(auto* memory=std::malloc(size?size:1))return memory;throw std::bad_alloc{};}
void* operator new[](std::size_t size){return ::operator new(size);}
void operator delete(void* memory) noexcept{std::free(memory);}
void operator delete[](void* memory) noexcept{std::free(memory);}
static void renderChecked(CueProcessor& processor,juce::AudioBuffer<float>& audio,juce::MidiBuffer& midi){
    const auto before=audioAllocations;onAudioThread=true;processor.processBlock(audio,midi);onAudioThread=false;
    if(audioAllocations!=before)throw std::runtime_error("Audio callback allocated memory");
}

static void check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
static void block(CueProcessor& processor, int size = 256) {
    juce::AudioBuffer<float> audio(2, size); juce::MidiBuffer midi; renderChecked(processor,audio,midi);
    for (int channel = 0; channel < 2; ++channel) for (int i = 0; i < size; ++i)
        check(std::isfinite(audio.getSample(channel, i)), "Non-finite output");
}
static std::unique_ptr<CueProcessor::Sample> sample() {
    auto result = std::make_unique<CueProcessor::Sample>();
    result->rate = 48000; result->path = "demo:"; result->audio.setSize(2, 48000 * 4);
    for (int i = 0; i < result->audio.getNumSamples(); ++i) {
        result->audio.setSample(0, i, i < 48000 ? 0.5f : -0.5f);
        result->audio.setSample(1, i, i < 48000 ? -0.25f : 0.25f);
    }
    return result;
}

static void effectRoutingTests(){
    CueProcessor processor;processor.prepareToPlay(48000,512);auto fixture=sample();fixture->path="demo:";processor.installSampleForTest(std::move(fixture));
    juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;renderChecked(processor,audio,midi);
    processor.submit({CueProcessor::Action::play});renderChecked(processor,audio,midi);
    const float dryLeft=audio.getSample(0,511),dryRight=audio.getSample(1,511);
    processor.setEffectKernel(juce::JSON::parse("{\"type\":\"bitDecimator\",\"amount\":1}"));renderChecked(processor,audio,midi);
    check(std::abs(audio.getSample(0,511)-0.8f*beatmaker::dsp::quantize(0.5f,4))<1.0e-6f,"Native quantizer did not run before output gain");
    check(std::abs(audio.getSample(1,511)-0.8f*beatmaker::dsp::quantize(-0.25f,4))<1.0e-6f,"Native quantizer lost stereo independence");
    processor.setEffectKernel(juce::JSON::parse("{\"type\":\"twelveBit\"}"));renderChecked(processor,audio,midi);
    check(std::abs(audio.getSample(0,511)-0.8f*beatmaker::dsp::quantize(0.5f,12))<1.0e-6f,"Twelve-bit native host-bus routing failed");
    processor.setEffectKernel(juce::JSON::parse("{\"type\":\"centerCancel\",\"amount\":0.4}"));renderChecked(processor,audio,midi);
    check(std::abs(audio.getSample(0,511)-0.16f)<1.0e-6f&&std::abs(audio.getSample(1,511)-0.08f)<1.0e-6f,"Native center-cancel routing differs from the legacy stereo graph");
    bool rejected=false;try{processor.setEffectKernel(juce::JSON::parse("{\"type\":\"reverb\"}"));}catch(const std::exception&){rejected=true;}check(rejected,"Unported effects must not silently fall back to another kernel");
    rejected=false;try{processor.setEffectKernel(juce::JSON::parse("{\"type\":\"centerCancel\",\"amount\":\"invalid\"}"));}catch(const std::exception&){rejected=true;}check(rejected,"Invalid effect parameters were accepted");
    juce::MemoryBlock state;processor.getStateInformation(state);
    CueProcessor recalled;recalled.prepareToPlay(48000,512);recalled.setStateInformation(state.getData(),(int)state.getSize());
    check(recalled.effectKernelState()["type"].toString()=="centerCancel"&&std::abs((double)recalled.effectKernelState()["amount"]-0.4)<1.0e-6,"Host recall lost native kernel state");
    auto legacy=juce::AudioProcessor::getXmlFromBinary(state.getData(),(int)state.getSize());legacy->deleteAllChildElementsWithTagName("EffectKernel");
    juce::MemoryBlock old;juce::AudioProcessor::copyXmlToBinary(*legacy,old);recalled.setStateInformation(old.getData(),(int)old.getSize());
    check(recalled.effectKernelState()["type"].toString()=="none","Legacy state inherited an unintended native effect");
    processor.setEffectKernel(juce::JSON::parse("{\"type\":\"none\"}"));renderChecked(processor,audio,midi);
    check(audio.getSample(0,511)==dryLeft&&audio.getSample(1,511)==dryRight,"Kernel bypass changed existing playback");
    std::cout<<"PASS: native effect kernel host-bus placement/stereo, validation, compatible state recall and exact bypass; no callback allocation\n";
}

static void padSampleTests(){
    const auto folder=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("beatmaker-pad-samples",{});folder.createDirectory();
    struct Cleanup{juce::File folder;~Cleanup(){folder.deleteRecursively();}}cleanup{folder};
    const auto source=folder.getChildFile("Stereo sample.wav");
    {juce::WavAudioFormat format;std::unique_ptr<juce::AudioFormatWriter> writer(format.createWriterFor(source.createOutputStream().release(),24000,2,24,{},0));check(writer!=nullptr,"Cannot create pad fixture");
        juce::AudioBuffer<float> data(2,12000);for(int i=0;i<12000;++i){data.setSample(0,i,.2f);data.setSample(1,i,-.1f);}check(writer->writeFromAudioSampleBuffer(data,0,12000),"Cannot write pad fixture");}
    CueProcessor processor;processor.prepareToPlay(48000,512);
    processor.importPadSample(0,0,source);processor.importPadSample(1,1,source);
    check(processor.hasPadSample(0,0)&&processor.hasPadSample(1,1)&&!processor.hasPadSample(0,1),"Sample assignments leaked between banks/pads");
    juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;
    midi.addEvent(juce::MidiMessage::noteOn(1,48,(juce::uint8)127),127);renderChecked(processor,audio,midi);
    check(audio.getMagnitude(0,0,127)==0&&std::abs(audio.getSample(0,511)-.16f)<1e-5f&&std::abs(audio.getSample(1,511)+.08f)<1e-5f,"Sample MIDI offset, stereo, resampling or output gain failed");
    check(!processor.playing.load()&&processor.playhead.load()==0&&processor.getCue(0,0)<0,"Sample without a song changed transport or marked a cue");
    midi.addEvent(juce::MidiMessage::noteOn(2,49,(juce::uint8)64),0);renderChecked(processor,audio,midi);
    check(audio.getSample(0,511)>.23f,"Independent bank samples did not overlap with MIDI velocity");
    for(int i=0;i<80;++i){midi.addEvent(juce::MidiMessage::noteOn(1,48,(juce::uint8)100),i%128);renderChecked(processor,audio,midi);}
    midi.addEvent(juce::MidiMessage::allSoundOff(1),0);renderChecked(processor,audio,midi);check(audio.getMagnitude(0,64,448)==0,"All Sound Off did not stop sample voices");
    bool rejected=false;try{processor.importPadSample(0,0,folder.getChildFile("missing.wav"));}catch(const std::exception&){rejected=true;}
    check(rejected&&processor.hasPadSample(0,0),"Failed replacement discarded the existing sample");
    processor.installSampleForTest(sample());renderChecked(processor,audio,midi);processor.submit({CueProcessor::Action::seek,0,0,2.0});renderChecked(processor,audio,midi);
    processor.overwrite.store(true);midi.addEvent(juce::MidiMessage::noteOn(1,48,(juce::uint8)127),0);renderChecked(processor,audio,midi);
    check(processor.getCue(0,0)<0&&processor.playhead.load()==2.0&&!processor.playing.load(),"Sample pad in overwrite mode marked/jumped the song");
    processor.submit({CueProcessor::Action::markNext});renderChecked(processor,audio,midi);check(processor.getCue(0,0)<0&&processor.getCue(0,1)==2.0,"Mark Next did not skip the sample pad");
    juce::MemoryBlock saved;processor.getStateInformation(saved);source.deleteFile();
    CueProcessor recalled;recalled.prepareToPlay(48000,512);recalled.setStateInformation(saved.getData(),(int)saved.getSize());
    for(int i=0;i<1000;++i){const auto pads=recalled.padSamples();if(pads.size()==2&&(bool)pads[0]["ready"]&&(bool)pads[1]["ready"])break;juce::Thread::sleep(2);}
    check(recalled.padSamples().size()==2&&(bool)recalled.padSamples()[0]["ready"],"DAW recall lost app-local samples after the original file was removed");
    renderChecked(recalled,audio,midi);midi.addEvent(juce::MidiMessage::noteOn(1,48,(juce::uint8)127),0);renderChecked(recalled,audio,midi);check(audio.getMagnitude(0,512)>.1f,"Recalled sample did not render");
    processor.removePadSample(0,0);renderChecked(processor,audio,midi);check(audio.getMagnitude(0,64,448)==0,"Removing a sample did not stop its existing voices");
    processor.submit({CueProcessor::Action::pad,0,0,0,true});renderChecked(processor,audio,midi);check(processor.getCue(0,0)==2.0,"Removing a sample did not restore normal cue marking");
    auto legacy=juce::AudioProcessor::getXmlFromBinary(saved.getData(),(int)saved.getSize());legacy->deleteAllChildElementsWithTagName("PadSamples");juce::MemoryBlock old;juce::AudioProcessor::copyXmlToBinary(*legacy,old);
    recalled.setStateInformation(old.getData(),(int)old.getSize());check(!recalled.hasPadSample(0,0),"Old DAW sessions inherited sample assignments");
    std::cout<<"PASS: native sample pads without a song, sample-accurate MIDI, stereo/rate/velocity/polyphony, no cue overwrite, cue fallback, retained files, isolated state recall and allocation-free rendering\n";
}

static void rateTransitionTests(){
    CueProcessor processor;processor.prepareToPlay(48000,512);
    auto fixture=std::make_unique<CueProcessor::Sample>();fixture->rate=48000;fixture->path="demo:";fixture->audio.setSize(2,48000*8);
    for(int i=0;i<fixture->audio.getNumSamples();++i)for(int c=0;c<2;++c)fixture->audio.setSample(c,i,.5f*std::sin(juce::MathConstants<double>::twoPi*80*i/48000.0));
    processor.installSampleForTest(std::move(fixture));juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;
    renderChecked(processor,audio,midi);processor.submit({CueProcessor::Action::play});
    for(int i=0;i<40;++i)renderChecked(processor,audio,midi);
    float previous=audio.getSample(0,511),largest=0;
    struct Change{float rate,tuning;bool stretch;};
    for(const auto change:{Change{1.4f,0,true},Change{.7f,5,true},Change{1,0,true},Change{1.8f,0,false},Change{.6f,0,false},Change{1,0,true}}){
        float transitionLargest=0;int edgeAt=0;
        processor.preservePitch.store(change.stretch);processor.semitones.store(change.tuning);
        auto* speed=processor.parameters.getParameter("speed");speed->setValueNotifyingHost(speed->convertTo0to1(change.rate));
        for(int block=0;block<40;++block){renderChecked(processor,audio,midi);for(int i=0;i<512;++i){const auto value=audio.getSample(0,i);check(std::isfinite(value),"Rate transition produced non-finite audio");if(std::abs(value-previous)>transitionLargest){transitionLargest=std::abs(value-previous);edgeAt=block*512+i;}largest=juce::jmax(largest,std::abs(value-previous));previous=value;}}
        std::cout<<"Rate transition "<<change.rate<<" tune "<<change.tuning<<" stretch "<<change.stretch<<" largest step "<<transitionLargest<<" at "<<edgeAt<<"\n";
    }
    check(largest<.1f,"Speed/stretch transition introduced a click-like discontinuity");
    std::cout<<"PASS: smoothed whole-percent speed/stretch/tuning transitions; largest sample step "<<largest<<"; no callback allocation\n";
}

static void fxGraphRoutingTests(){
    CueProcessor processor;processor.prepareToPlay(48000,512);auto fixture=sample();fixture->path="demo:";processor.installSampleForTest(std::move(fixture));
    juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;renderChecked(processor,audio,midi);processor.submit({CueProcessor::Action::play});renderChecked(processor,audio,midi);
    const float dryLeft=audio.getSample(0,511),dryRight=audio.getSample(1,511);
    processor.setFxGraph(juce::JSON::parse("{\"enabled\":true,\"effects\":[\"delay\",\"none\",\"none\",\"none\"],\"x\":0.4,\"y\":0}"));
    check(processor.getLatencySamples()==576&&processor.getTailLengthSeconds()>0.05,"Native FX graph host latency/tail was not updated");
    for(int i=0;i<20;++i)renderChecked(processor,audio,midi);
    check(audio.getMagnitude(0,512)>0.01f,"Native FX graph produced no host-bus audio");
    const auto pausedAt=processor.playhead.load();processor.submit({CueProcessor::Action::pause});double tailEnergy=0;
    for(int i=0;i<20;++i){renderChecked(processor,audio,midi);for(int n=0;n<512;++n)tailEnergy+=std::abs(audio.getSample(0,n));}
    check(tailEnergy>1&&processor.playhead.load()==pausedAt,"Native delay tail stopped with the source or moved the paused transport");
    bool rejected=false;try{processor.setFxGraph(juce::JSON::parse("{\"effects\":[\"none\",\"none\",\"none\",\"reverb\"]}"));}catch(const std::exception&){rejected=true;}check(rejected,"Unported graph effect was silently accepted");
    rejected=false;try{processor.setFxGraph(juce::JSON::parse("{\"x\":2}"));}catch(const std::exception&){rejected=true;}check(rejected,"Out-of-range graph controls were accepted");
    check(processor.fxGraphState()["effects"][0].toString()=="delay","Invalid control partially changed the requested graph");
    juce::MemoryBlock saved;processor.getStateInformation(saved);CueProcessor recalled;recalled.prepareToPlay(48000,512);recalled.setStateInformation(saved.getData(),(int)saved.getSize());
    check((bool)recalled.fxGraphState()["enabled"]&&recalled.fxGraphState()["effects"][0].toString()=="delay"&&recalled.getLatencySamples()==576,"Native FX graph state/latency did not survive host recall");
    auto legacy=juce::AudioProcessor::getXmlFromBinary(saved.getData(),(int)saved.getSize());legacy->deleteAllChildElementsWithTagName("NativeFxGraph");juce::MemoryBlock old;juce::AudioProcessor::copyXmlToBinary(*legacy,old);recalled.setStateInformation(old.getData(),(int)old.getSize());
    check(!(bool)recalled.fxGraphState()["enabled"]&&recalled.getLatencySamples()==0,"Older sessions unexpectedly enabled the native FX graph");
    processor.setFxGraph(juce::JSON::parse("{\"enabled\":false}"));processor.submit({CueProcessor::Action::play});renderChecked(processor,audio,midi);
    check(audio.getSample(0,511)==dryLeft&&audio.getSample(1,511)==dryRight&&processor.getLatencySamples()==0,"Disabled native graph changed the original output");
    processor.setFxGraph(juce::JSON::parse("{\"enabled\":true,\"multi\":true,\"effects\":[\"flanger\",\"filterDrive\",\"equalizer\",\"duckComp\"]}"));
    for(int i=0;i<80;++i){processor.setFxGraph(juce::JSON::parse("{\"x\":"+juce::String(i%11/10.0)+",\"y\":"+juce::String(i%7/6.0)+"}"));renderChecked(processor,audio,midi);}
    std::cout<<"PASS: native four-corner host-bus graph, latency/tails, paused transport, state/legacy recall, parameter validation and bypass; no callback allocation\n";
}

static void remoteTransportTests(){
    CueProcessor processor;processor.openEditors.store(1);processor.prepareToPlay(48000,128);
    juce::XmlElement session("BeatmakerCuesPrototype");session.setAttribute("version",1);session.setAttribute("sessionId","remote-"+juce::Uuid().toString());
    juce::MemoryBlock sessionBytes;juce::AudioProcessor::copyXmlToBinary(session,sessionBytes);processor.setStateInformation(sessionBytes.getData(),(int)sessionBytes.getSize());
    const auto fixture=juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a");juce::Array<juce::var> tracks;
    for(int i=0;i<3;++i){auto track=processor.importLocalFile(fixture);track.getDynamicObject()->setProperty("title","Remote track "+juce::String(i+1));track.getDynamicObject()->setProperty("artwork","https://fixture.invalid/art.jpg");tracks.add(track);}
    auto* queue=new juce::DynamicObject;queue->setProperty("tracks",tracks);queue->setProperty("index",0);queue->setProperty("repeat","one");processor.setNativeQueue(juce::var(queue));
    processor.loadRemote("beatmaker-local://"+tracks[0]["id"].toString(),0,tracks[0]["id"].toString());
    const auto waitFor=[&](int index){for(int i=0;i<1500;++i){block(processor,128);if(processor.ready.load()&&!processor.nativeAdvancing.load()&&processor.nativeSnapshot()["trackId"].toString()==tracks[index]["id"].toString())return true;juce::Thread::sleep(2);}return false;};
    check(waitFor(0),"Remote-control fixture did not load");
    const auto initial=processor.nativeSnapshot();check(initial["title"].toString()=="Remote track 1"&&initial["artwork"].toString().contains("art.jpg")&&(bool)initial["canNext"],"Native Now Playing metadata is incomplete");
    check(processor.performRemoteAction(CueProcessor::RemoteAction::play),"Remote Play was rejected");block(processor,128);check(processor.playing.load(),"Remote Play did not reach the native renderer");
    check(processor.performRemoteAction(CueProcessor::RemoteAction::toggle),"Remote Toggle was rejected");block(processor,128);check(!processor.playing.load()&&!processor.requestedPlay.load(),"Remote Toggle did not pause");
    check(processor.performRemoteAction(CueProcessor::RemoteAction::seek,0.125),"Remote seek was rejected");block(processor,128);check(std::abs(processor.playhead.load()-0.125)<0.001&&!processor.playing.load(),"Paused remote seek changed play intent or lost its position");
    check(processor.performRemoteAction(CueProcessor::RemoteAction::next)&&processor.performRemoteAction(CueProcessor::RemoteAction::next),"Rapid remote Next was rejected");
    check(waitFor(2)&&!processor.playing.load()&&!processor.requestedPlay.load(),"Rapid Next lost an action, obeyed repeat-one, or resumed a paused source");
    check(!(bool)processor.nativeSnapshot()["canNext"]&&!processor.performRemoteAction(CueProcessor::RemoteAction::next),"Remote Next exceeded a nonwrapping queue");
    check(processor.performRemoteAction(CueProcessor::RemoteAction::previous)&&waitFor(1),"Remote Previous did not select the prior native track");
    check(processor.performRemoteAction(CueProcessor::RemoteAction::next)&&processor.performRemoteAction(CueProcessor::RemoteAction::previous)&&waitFor(1),"Opposite remote actions failed to cancel a pending skip");
    auto* wrapping=new juce::DynamicObject;wrapping->setProperty("tracks",tracks);wrapping->setProperty("index",1);wrapping->setProperty("repeat","all");processor.setNativeQueue(juce::var(wrapping));
    check(processor.performRemoteAction(CueProcessor::RemoteAction::next)&&waitFor(2)&&(bool)processor.nativeSnapshot()["canNext"],"Repeat-all did not expose the final Next command");
    check(processor.performRemoteAction(CueProcessor::RemoteAction::next)&&waitFor(0),"Remote repeat-all Next did not wrap");
    check(processor.performRemoteAction(CueProcessor::RemoteAction::previous)&&waitFor(2),"Remote repeat-all Previous did not wrap");
    check(processor.performRemoteAction(CueProcessor::RemoteAction::previous)&&waitFor(1),"Remote wrapped queue did not return to the expected index");
    const auto marker=juce::Uuid().toString();auto* ui=new juce::DynamicObject;ui->setProperty("remote-background-check",marker);
    auto* player=new juce::DynamicObject;player->setProperty("queue",tracks);player->setProperty("index",0);player->setProperty("position",0);
    ui->setProperty("musike:player",juce::JSON::toString(juce::var(player)));processor.setWebState(juce::JSON::toString(juce::var(ui)));processor.backgroundPlayback.store(true);
    bool saved=false;for(int i=0;i<150;++i){const auto value=juce::JSON::parse(processor.libraryStore.readPreferences(processor.getSessionId()));if(value["remote-background-check"].toString()==marker){saved=(int)juce::JSON::parse(value["musike:player"].toString())["index"]==1;break;}juce::Thread::sleep(10);}
    check(saved,"Background native track index was not retained with an existing WebView");processor.backgroundPlayback.store(false);
    {
        CueProcessor restart;restart.prepareToPlay(48000,128);restart.installSampleForTest(sample());block(restart,128);restart.submit({CueProcessor::Action::seek,0,0,3.5});block(restart,128);
        check(restart.performRemoteAction(CueProcessor::RemoteAction::previous),"Remote restart was rejected");block(restart,128);check(restart.playhead.load()==0,"Previous after three seconds did not restart the source");
    }
    {
        juce::MemoryBlock bytes;check(fixture.loadFileAsData(bytes),"Remote download fixture missing");juce::WaitableEvent entered,release{true};
        CueProcessor loading([&](const juce::String&,const juce::String&,const std::function<bool()>& cancel){entered.signal();for(int i=0;i<1000&&!release.wait(2);++i)if(cancel())return CueProcessor::AudioResponse{};CueProcessor::AudioResponse response;response.status=206;response.data=bytes;response.headers.set("Content-Range","bytes 0-"+juce::String((juce::int64)bytes.getSize()-1)+"/"+juce::String((juce::int64)bytes.getSize()));return response;});
        loading.prepareToPlay(48000,128);const auto id=juce::Uuid().toString().removeCharacters("-").substring(0,11);auto* item=new juce::DynamicObject;item->setProperty("id",id);auto* state=new juce::DynamicObject;state->setProperty("tracks",juce::Array<juce::var>{juce::var(item)});state->setProperty("index",0);loading.setNativeQueue(juce::var(state));
        loading.requestedPlay.store(true);loading.loadRemote("https://fixture.googlevideo.com/audio",0,id,false,true);check(entered.wait(2000),"Background native download did not start");
        check(loading.performRemoteAction(CueProcessor::RemoteAction::pause),"Remote pause during loading was rejected");block(loading,128);release.signal();
        for(int i=0;i<1000&&!loading.ready.load();++i){block(loading,128);juce::Thread::sleep(2);}check(loading.ready.load()&&!loading.playing.load()&&!loading.requestedPlay.load(),"Completing a background load overrode a newer remote pause");
    }
    std::cout<<"PASS: native background play/pause/toggle/seek, rapid next/previous, repeat-one override, paused navigation, metadata, restart, checkpoint and pause during loading\n";
}

namespace {
std::atomic<bool> decoderOnAudioThread{false};
class LongToneReader final:public juce::AudioFormatReader {
public:
    explicit LongToneReader(std::shared_ptr<std::atomic<bool>> delayed={},juce::int64 failFrom=PagedAudio::maxFrames):AudioFormatReader(nullptr,"Synthetic long stereo"),delay(std::move(delayed)),failureFrame(failFrom){
        sampleRate=48000;lengthInSamples=645*48000;numChannels=2;bitsPerSample=32;usesFloatingPointData=true;
    }
    static float tone(juce::int64 frame,int channel){return 0.4f*std::sin((float)std::fmod(frame*(channel==0?440.0:220.0)*juce::MathConstants<double>::twoPi/48000,juce::MathConstants<double>::twoPi));}
    bool readSamples(int* const* destination,int channels,int offset,juce::int64 start,int count) override {
        if(onAudioThread)decoderOnAudioThread.store(true);
        if(start>=failureFrame)return false;
        if(delay&&delay->load())juce::Thread::sleep(40);
        for(int channel=0;channel<channels;++channel)if(destination[channel])for(int i=0;i<count;++i)
            reinterpret_cast<float*>(destination[channel])[offset+i]=tone(start+i,channel);
        return true;
    }
private:
    std::shared_ptr<std::atomic<bool>> delay;
    juce::int64 failureFrame;
};
}

static void longTrackTests(){
    auto delay=std::make_shared<std::atomic<bool>>(false);
    auto source=std::make_unique<CueProcessor::Sample>();source->rate=48000;source->path="long-fixture:";
    source->paged=std::make_unique<PagedAudio>(std::make_unique<LongToneReader>(delay),0);
    check(source->paged->pcmBytes()==16*1024*1024,"Paged stereo PCM budget must remain 16 MiB");
    CueProcessor processor;processor.prepareToPlay(48000,512);processor.installSampleForTest(std::move(source));
    juce::AudioBuffer<float> output(2,512);juce::MidiBuffer midi;
    renderChecked(processor,output,midi);processor.submit({CueProcessor::Action::play});renderChecked(processor,output,midi);
    check(std::abs(processor.getDuration()-645)<0.001,"Long sample duration was truncated");
    check(output.getMagnitude(0,512)>0.2f&&output.getMagnitude(1,512)>0.2f,"Long stereo sample failed to play");
    // Force a cold decoder read to take much longer than an audio block. The
    // render callback must fade/hold the requested position rather than decode.
    delay->store(true);
    const double cold=610.125;
    const float before=output.getSample(0,511);
    processor.submit({CueProcessor::Action::cue,0,0,cold});renderChecked(processor,output,midi);
    check(std::abs(output.getSample(0,0)-before)<1.0e-6,"Cold cue introduced a discontinuity");
    check(std::abs(processor.playhead.load()-cold)<0.0001,"Cold cue advanced while its page was unavailable");
    check((bool)processor.loadDiagnostics()["buffering"],"Cold cache miss was not exposed");
    // A second cue replaces the pending first one; old work may finish but cannot
    // move playback back to the old position.
    const double latest=520.25;
    processor.submit({CueProcessor::Action::cue,0,0,latest});renderChecked(processor,output,midi);delay->store(false);
    for(int i=0;i<2000&&processor.playhead.load()<latest+0.001;++i){renderChecked(processor,output,midi);juce::Thread::sleep(1);}
    check(processor.playhead.load()>latest+0.001&&processor.playhead.load()<latest+0.1,"Latest cold cue did not resume at its own position");
    renderChecked(processor,output,midi);
    const auto lastFrame=(juce::int64)std::llround(processor.playhead.load()*48000)-1;
    for(int channel=0;channel<2;++channel)check(std::abs(output.getSample(channel,511)-0.8f*LongToneReader::tone(lastFrame,channel))<0.0001,"Paged output differs from the source PCM");
    // Exercise eviction far beyond the cache's capacity, including page boundaries.
    for(int jump=0;jump<90;++jump){
        const double target=std::fmod(jump*113.713,640.0);
        processor.submit({CueProcessor::Action::cue,0,0,target});
        for(int i=0;i<2000;++i){renderChecked(processor,output,midi);if(processor.playhead.load()>target+0.001)break;juce::Thread::sleep(1);}
        check(processor.playhead.load()>target+0.001&&processor.playhead.load()<target+0.1,"Evicted page did not resume at the requested cue");
        for(int i=0;i<2000;++i){renderChecked(processor,output,midi);if(!(bool)processor.loadDiagnostics()["buffering"])break;juce::Thread::sleep(1);}
        const auto frame=(juce::int64)std::llround(processor.playhead.load()*48000)-1;
        if(std::abs(output.getSample(0,511)-0.8f*LongToneReader::tone(frame,0))>=0.0001){std::cerr<<"Eviction jump "<<jump<<" target "<<target<<" frame "<<frame<<" actual "<<output.getSample(0,511)<<" expected "<<0.8f*LongToneReader::tone(frame,0)<<" diagnostics "<<juce::JSON::toString(processor.loadDiagnostics(),true)<<"\n";check(false,"Page eviction or interpolation corrupted audio");}
    }
    check((juce::int64)processor.loadDiagnostics()["pcmCacheBytes"]==16*1024*1024,"Long playback grew its PCM cache");
    // Warm a marked cue through the same background hint path used by the UI.
    processor.syncWebCues(juce::JSON::parse("{\"bank\":\"A\",\"cues\":{\"A\":{\"1\":600}}}"));
    juce::Thread::sleep(150);
    const int misses=processor.loadDiagnostics()["cacheMisses"];
    processor.submit({CueProcessor::Action::pad,0,0});renderChecked(processor,output,midi);
    check(processor.playhead.load()>600&&(int)processor.loadDiagnostics()["cacheMisses"]==misses,"Marked cue was not warmed in the background");
    processor.loopIn.store(600.10);processor.loopOut.store(600.18);processor.loopEnabled.store(true);
    processor.submit({CueProcessor::Action::cue,0,0,600.14});
    for(int i=0;i<80;++i){renderChecked(processor,output,midi);check(processor.playhead.load()>=600.10&&processor.playhead.load()<600.181,"Paged loop escaped its bounds");}
    processor.loopEnabled.store(false);
    processor.preservePitch.store(true);processor.semitones.store(12);
    processor.parameters.getParameter("speed")->setValueNotifyingHost(processor.parameters.getParameter("speed")->convertTo0to1(1.5f));
    processor.submit({CueProcessor::Action::cue,0,0,600.3});
    int crossings=0,frames=0;float previous=0;
    for(int b=0;b<140;++b){renderChecked(processor,output,midi);juce::Thread::sleep(1);if(b<30)continue;
        for(int i=0;i<512;++i){const float value=output.getSample(0,i);if(previous<0&&value>=0)++crossings;previous=value;++frames;}}
    const double frequency=crossings*48000.0/frames;
    check(std::abs(frequency-880)<35,"Paged pitch/speed processing changed the expected frequency");
    processor.semitones.store(0);processor.parameters.getParameter("speed")->setValueNotifyingHost(processor.parameters.getParameter("speed")->convertTo0to1(1.0f));
    // The exact-PCM cache checks start after the intentional rate/tuning ramp
    // and stretch pipeline have settled; transitions are checked separately.
    for(int i=0;i<20;++i)renderChecked(processor,output,midi);
    processor.setNonRealtime(true);
    for(int jump=0;jump<12;++jump){
        const double target=jump*49.123;
        processor.submit({CueProcessor::Action::cue,0,0,target});renderChecked(processor,output,midi);
        check(processor.playhead.load()>target+0.001&&!(bool)processor.loadDiagnostics()["buffering"],"Offline bounce inserted a cache-wait block");
        renderChecked(processor,output,midi);
        const auto frame=(juce::int64)std::llround(processor.playhead.load()*48000)-1;
        check(std::abs(output.getSample(0,511)-0.8f*LongToneReader::tone(frame,0))<0.0001,"Offline page changes corrupted rendered PCM");
    }
    {
        juce::AudioBuffer<float> bounce(2,4096);
        processor.submit({CueProcessor::Action::cue,0,0,0});
        for(int b=0;b<640;++b){
            renderChecked(processor,bounce,midi);
            const auto frame=(juce::int64)(b+1)*4096-1;
            check(std::abs(processor.playhead.load()*48000-(frame+1))<0.001,"Continuous offline bounce inserted or skipped frames at a cache boundary");
            check(std::abs(bounce.getSample(0,4095)-0.8f*LongToneReader::tone(frame,0))<0.0001,"Continuous eviction changed the bounced PCM");
        }
    }
    processor.setNonRealtime(false);
    processor.submit({CueProcessor::Action::cue,0,0,644.98});
    for(int i=0;i<2000;++i){renderChecked(processor,output,midi);if(!processor.playing.load())break;juce::Thread::sleep(1);}
    check(!processor.playing.load()&&processor.playhead.load()>=645&&processor.playhead.load()<645.001,"Paged playback did not stop at the exact sample end");
    check(!decoderOnAudioThread.load(),"Paged audio decoded inside the render callback");
    {
        auto failing=std::make_unique<CueProcessor::Sample>();failing->rate=48000;
        failing->paged=std::make_unique<PagedAudio>(std::make_unique<LongToneReader>(nullptr,600*48000),0);
        CueProcessor failure;failure.prepareToPlay(48000,512);failure.installSampleForTest(std::move(failing));
        renderChecked(failure,output,midi);failure.submit({CueProcessor::Action::cue,0,0,630});
        for(int i=0;i<2000&&failure.nativeErrorRevision.load()==0;++i){renderChecked(failure,output,midi);juce::Thread::sleep(1);}
        check(failure.nativeErrorRevision.load()>0&&!failure.ready.load()&&failure.getStatus().contains("page decoding failed"),"Background decoder failure left an endless cache wait");
    }
    std::cout<<"PASS: 645-second stereo sample, fixed 16 MiB PCM cache, cold/latest/warmed cues, 90 evictions, loop, independent pitch/speed, offline bounce, exact end and background errors; no callback decode/allocation\n";
}

int main() {
    juce::ScopedJuceInitialiser_GUI initialise;
    try {
        constexpr int notes[] = {48,49,50,51,44,45,46,47,40,41,42,43,36,37,38,39};
        for (int bank = 0; bank < 10; ++bank) for (int pad = 0; pad < 16; ++pad) {
            auto a = CueProcessor::mapNote(0, bank + 1, notes[pad], 9);
            check(a.bank == bank && a.pad == pad, "Mode A mapping");
            auto b = CueProcessor::mapNote(1, bank < 5 ? 1 : 2, 12 + bank % 5 * 16 + notes[pad] - 36, 9);
            check(b.bank == bank && b.pad == pad, "Mode B mapping");
        }
        check(CueProcessor::mapNote(0, 11, 48, 0).bank == -1, "Mode A bank isolation");
        check(CueProcessor::mapNote(1, 3, 24, 0).bank == -1, "Mode B bank isolation");
        for (int i = 0; i < 12; ++i) check(CueProcessor::mapNote(2, 16, 36 + i, 7).pad == i, "Legacy note order");
        std::cout << "PASS: 320 Roland mappings and legacy/channel isolation\n";

        CueProcessor processor;
        processor.prepareToPlay(48000, 256); processor.installSampleForTest(sample()); block(processor);
        check(processor.getLatencySamples() == 0, "Unexpected declared look-ahead latency");
        processor.submit({CueProcessor::Action::pad, 0, 0}); block(processor);
        check(processor.getCue(0, 0) == 0, "Empty pad marks zero");
        juce::AudioBuffer<float> audio(2, 256); juce::MidiBuffer midi;
        midi.addEvent(juce::MidiMessage::noteOn(1, 48, (juce::uint8) 127), 77);
        renderChecked(processor,audio,midi);
        check((processor.padStates[0].load()&1u)!=0,"Native MIDI press state missing");
        for (int i = 0; i <= 77; ++i) check(audio.getSample(0, i) == 0, "MIDI played before its sample offset");
        check(audio.getSample(0, 78) > 0, "Cue did not begin immediately after scheduled offset");
        midi.addEvent(juce::MidiMessage::noteOff(1, 48), 0); processor.processBlock(audio, midi);
        check((processor.padStates[0].load()&1u)==0,"Native MIDI release state missing");
        check(processor.playing.load(), "Note Off must preserve one-shot playback");
        check(audio.getSample(0, 200) > 0.3f, "Steady-state audio output");
        processor.submit({CueProcessor::Action::seek, 0, 0, 1.5}); processor.processBlock(audio, midi);
        check(audio.getSample(0, 0) > 0.3f && audio.getSample(0, 200) < -0.3f, "Crossfade should join old and new waveform");
        float largestStep = 0;
        for (int i = 1; i < 200; ++i) largestStep = juce::jmax(largestStep, std::abs(audio.getSample(0, i) - audio.getSample(0, i - 1)));
        check(largestStep < 0.02f, "Crossfade introduced a waveform step");
        float last=audio.getSample(0,audio.getNumSamples()-1);
        for(int hit=0;hit<12;++hit){
            processor.submit({CueProcessor::Action::cue,0,0,hit%2==0?0.25:1.5});
            processor.submit({CueProcessor::Action::play}); // Redundant Play must not restart the cue envelope.
            juce::AudioBuffer<float> retrigger(2,17);juce::MidiBuffer events;processor.processBlock(retrigger,events);
            check(std::abs(retrigger.getSample(0,0)-last)<1.0e-6f,"Rapid cue retrigger has a discontinuity");
            last=retrigger.getSample(0,16);
        }
        processor.submit({CueProcessor::Action::pause});block(processor);
        processor.submit({CueProcessor::Action::cue,0,0,0.25});
        juce::AudioBuffer<float> fromPause(2,256);juce::MidiBuffer fromPauseMidi;processor.processBlock(fromPause,fromPauseMidi);
        check(fromPause.getSample(0,0)==0&&fromPause.getSample(0,1)>0,"Paused cue must fade from zero without waiting for a timer");
        std::cout << "PASS: sample-offset MIDI, stereo audio, Note Off, zero look-ahead and 3 ms waveform transition\n";
        std::cout << "PASS: rapid mid-fade retriggers, redundant Play and fade-in from pause\n";

        processor.submit({CueProcessor::Action::pause}); block(processor);
        processor.selectedBank.store(1);
        for (int i = 0; i < 17; ++i) { processor.submit({CueProcessor::Action::markNext}); block(processor); }
        check(processor.selectedBank.load() == 2 && processor.getCue(2, 0) >= 0, "Sixteen-pad Mark rollover");
        const double hiddenCue = processor.getCue(1, 15);
        processor.preset.store(2); processor.selectedBank.store(3);
        for (int i = 0; i < 13; ++i) { processor.submit({CueProcessor::Action::markNext}); block(processor); }
        check(processor.selectedBank.load() == 4 && processor.getCue(4, 0) >= 0, "Legacy twelve-pad Mark rollover");
        check(processor.getCue(1, 15) == hiddenCue, "Legacy erased hidden cues");
        std::cout << "PASS: sixteen/twelve-pad rollover and hidden cue preservation\n";

        juce::MemoryBlock state; processor.getStateInformation(state);
        CueProcessor restored; restored.prepareToPlay(44100, 512); restored.setStateInformation(state.getData(), (int) state.getSize());
        for (int i = 0; i < 200 && restored.getDuration() == 0; ++i) juce::Thread::sleep(10);
        block(restored, 512);
        check(restored.getDuration() == 60 && !restored.playing.load(), "State restored paused sample");
        check(restored.preset.load() == 2 && restored.selectedBank.load() == 4, "State preset/bank");
        check(std::abs(restored.getCue(1, 15) - hiddenCue) < 1.0e-9, "State cue persistence");
        check(std::abs(restored.playhead.load() - processor.playhead.load()) < 0.001, "State playhead");
        restored.submit({CueProcessor::Action::play}); block(restored, 512);
        check(restored.playing.load(), "First Play after restore");
        restored.submit({CueProcessor::Action::seek, 0, 0, 0.5}); block(restored);
        restored.submit({CueProcessor::Action::setIn}); block(restored);
        restored.submit({CueProcessor::Action::seek, 0, 0, 0.55}); block(restored);
        restored.submit({CueProcessor::Action::setOut}); restored.submit({CueProcessor::Action::toggleLoop});
        for (int i = 0; i < 50; ++i) block(restored, 512);
        check(restored.loopEnabled.load() && restored.playhead.load() < 0.58, "IN/OUT loop");
        std::cout << "PASS: host state, sample-rate conversion, first Play after restore and IN/OUT loop\n";
        for(const auto settings : {std::array<float,3>{2,1,0},std::array<float,3>{1,1,12},std::array<float,3>{2,0,0}}) {
            CueProcessor pitch;pitch.prepareToPlay(48000,256);
            auto tone=sample();
            for(int c=0;c<2;++c)for(int i=0;i<tone->audio.getNumSamples();++i)tone->audio.setSample(c,i,0.4f*(float)std::sin(juce::MathConstants<double>::twoPi*440*i/48000));
            pitch.installSampleForTest(std::move(tone));block(pitch);
            pitch.preservePitch.store(settings[1]>0);pitch.semitones.store(settings[2]);
            auto* speed=pitch.parameters.getParameter("speed");speed->setValueNotifyingHost(speed->convertTo0to1(settings[0]));
            pitch.submit({CueProcessor::Action::play});
            int crossings=0,frames=0;float previous=0;
            float lastPitchSample=0;
            for(int b=0;b<120;++b){juce::AudioBuffer<float> rendered(2,256);juce::MidiBuffer events;renderChecked(pitch,rendered,events);
                lastPitchSample=rendered.getSample(0,255);
                if(b<24)continue;
                for(int i=0;i<256;++i){const float value=rendered.getSample(0,i);check(std::isfinite(value),"Pitch processing non-finite");if(previous<0&&value>=0)++crossings;previous=value;++frames;}}
            const double frequency=crossings*48000.0/frames;
            const double expected=settings[2]>0||settings[1]==0?880:440;
            check(std::abs(frequency-expected)<expected*0.04,"Independent pitch/speed frequency");
            for(int hit=0;hit<6;++hit){
                pitch.submit({CueProcessor::Action::cue,0,0,hit%2==0?0.7:1.3});
                juce::AudioBuffer<float> retrigger(2,19);juce::MidiBuffer events;pitch.processBlock(retrigger,events);
                check(std::abs(retrigger.getSample(0,0)-lastPitchSample)<1.0e-6f,"Pitch-processed cue must join actual rendered audio");
                lastPitchSample=retrigger.getSample(0,18);
            }
        }
        std::cout<<"PASS: pitch-kept 2x speed, independent +12 semitones and coupled varispeed frequency checks\n";
        std::cout<<"PASS: cue continuity in pitch-kept, tuned and varispeed modes\n";
        std::cout<<"PASS: checked audio callbacks allocate no C++ heap memory; native MIDI press/release states\n";
        {
            CueProcessor playlist;playlist.prepareToPlay(48000,128);
            const auto temporary=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("beatmaker-local-test",".wav");
            juce::WavAudioFormat wav;
            {std::unique_ptr<juce::AudioFormatWriter> writer(wav.createWriterFor(temporary.createOutputStream().release(),48000,2,16,{},0));
                check(writer!=nullptr,"WAV fixture writer");juce::AudioBuffer<float> tone(2,4800);tone.clear();for(int i=0;i<4800;++i)tone.setSample(0,i,0.1f);check(writer->writeFromAudioSampleBuffer(tone,0,4800),"WAV fixture write");}
            const auto first=playlist.importLocalFile(temporary),second=playlist.importLocalFile(temporary);temporary.deleteFile();
            auto* queue=new juce::DynamicObject;queue->setProperty("tracks",juce::Array<juce::var>{first,second});queue->setProperty("index",0);queue->setProperty("repeat","off");playlist.setNativeQueue(juce::var(queue));
            playlist.loadRemote("beatmaker-local://"+first["id"].toString(),0,first["id"].toString());playlist.requestedPlay.store(true);
            for(int i=0;i<1000&&!playlist.nativeEnded.load();++i){block(playlist,128);juce::Thread::sleep(2);}
            check(playlist.nativeSnapshot()["trackId"].toString()==second["id"].toString()&&playlist.nativeEnded.load(),"Editor-closed playlist advancement");
            std::cout<<"PASS: imported local audio remains registered; native playlist advances without a WebView/editor\n";
        }
        {
            CueProcessor codec;codec.prepareToPlay(48000,256);
            codec.loadFile(juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a"));
            for(int i=0;i<1000&&codec.getDuration()==0;++i){block(codec);juce::Thread::sleep(5);}
            check(codec.getDuration()>0.45&&codec.getDuration()<0.6,"AAC/M4A fixture did not decode");
            codec.submit({CueProcessor::Action::play});
            int crossings=0;float previous=0;double energy=0;
            for(int b=0;b<40;++b){juce::AudioBuffer<float> rendered(2,256);juce::MidiBuffer events;renderChecked(codec,rendered,events);
                for(int i=0;i<256;++i){const auto value=rendered.getSample(0,i);energy+=value*value;if(previous<0&&value>=0)++crossings;previous=value;}}
            check(energy>1&&std::abs(crossings*48000.0/(40*256)-440)<20,"AAC/M4A decoded audio content");
            std::cout<<"PASS: real AAC/M4A decode and rendered tone content\n";
        }
        {
            CueProcessor latest;latest.prepareToPlay(48000,256);
            const auto fixture=juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a");
            const auto first=latest.importLocalFile(fixture),second=latest.importLocalFile(fixture);
            latest.loadRemote("beatmaker-local://"+first["id"].toString(),0.1,first["id"].toString());
            latest.loadRemote("beatmaker-local://"+second["id"].toString(),0.2,second["id"].toString());
            for(int i=0;i<1000&&(!latest.ready.load()||!latest.getStatus().contains(second["id"].toString()));++i){block(latest);juce::Thread::sleep(2);}
            check(latest.ready.load()&&latest.getStatus().contains(second["id"].toString()),"A stale local lookup replaced the newer selection");
            check(std::abs(latest.playhead.load()-0.2)<0.001,"A stale lookup replaced the saved seek position");
            const auto revision=latest.nativeErrorRevision.load();latest.loadRemote("beatmaker-cache://missing0000",0,"missing0000");
            check(latest.nativeErrorRevision.load()>revision&&!latest.ready.load(),"Load error must notify UI instead of leaving an endless loading state");
            std::cout<<"PASS: latest local selection wins; saved start position preserved; load errors notify the UI\n";
        }
        {
            juce::MemoryBlock fixture;
            check(juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a").loadFileAsData(fixture),"Download fixture missing");
            const auto id=juce::Uuid().toString().removeCharacters("-").substring(0,11);
            const auto url="https://fixture.googlevideo.com/audio";
            juce::WaitableEvent entered,release{true};
            std::atomic<int> requests{0};std::atomic<bool> abandoned{false},badRange{false};
            const auto transport=[&](const juce::String&,const juce::String& headers,const std::function<bool()>& cancelled){
                ++requests;entered.signal();
                while(!release.wait(10))if(cancelled()){abandoned.store(true);return CueProcessor::AudioResponse{};}
                if(!headers.contains("Range: bytes=0-1048575")){badRange.store(true);return CueProcessor::AudioResponse{};}
                CueProcessor::AudioResponse response;response.status=206;response.data=fixture;
                response.headers.set("Content-Range","bytes 0-"+juce::String((juce::int64)fixture.getSize()-1)+"/"+juce::String((juce::int64)fixture.getSize()));return response;
            };
            const auto queue=[&](int index){
                auto* current=new juce::DynamicObject;current->setProperty("id","current0001");
                auto* next=new juce::DynamicObject;next->setProperty("id",id);
                auto* state=new juce::DynamicObject;state->setProperty("tracks",juce::Array<juce::var>{juce::var(current),juce::var(next)});state->setProperty("index",index);state->setProperty("repeat","off");return juce::var(state);
            };
            CueProcessor first(transport),second(transport);first.prepareToPlay(48000,256);second.prepareToPlay(48000,256);
            first.setNativeQueue(queue(0));first.loadRemote(url,0,id,true);
            check(entered.wait(2000),"Prefetch did not start");
            first.setNativeQueue(queue(1));first.loadRemote(url,0.1,id);
            second.loadRemote(url,0.2,id);
            juce::Thread::sleep(150);
            const bool duplicate=requests.load()!=1;
            release.signal();
            for(int i=0;i<2500&&(!first.ready.load()||!second.ready.load());++i){block(first);block(second);juce::Thread::sleep(4);}
            check(!duplicate&&requests.load()==1,"Prefetch promotion / second processor duplicated the download");
            check(!badRange.load(),"Unexpected fixture range");
            if(abandoned.load()||!first.ready.load()||!second.ready.load())throw std::runtime_error("Promoted prefetch failed: first="+first.getStatus().toStdString()+"; second="+second.getStatus().toStdString()+"; cancelled="+(abandoned.load()?"yes":"no"));
            check(std::abs(first.playhead.load()-0.1)<0.001&&std::abs(second.playhead.load()-0.2)<0.001,"Shared download lost independent seek positions");
            second.loadRemote(url,0.15,id);
            for(int i=0;i<1000&&!second.ready.load();++i){block(second);juce::Thread::sleep(2);}
            check(second.ready.load()&&requests.load()==1,"Warm cache reopened over the network");
            std::cout<<"PASS: in-flight prefetch promotion, same-process multi-instance download reuse, independent seek and warm cache\n";
        }
        {
            const auto id=juce::Uuid().toString().removeCharacters("-").substring(0,11);
            juce::WaitableEvent entered;std::atomic<int> requests{0};std::atomic<bool> cancelled{false};
            CueProcessor removed([&](const juce::String&,const juce::String&,const std::function<bool()>& shouldCancel){
                ++requests;entered.signal();for(int i=0;i<1000;++i){if(shouldCancel()){cancelled.store(true);break;}juce::Thread::sleep(2);}return CueProcessor::AudioResponse{};
            });
            auto* track=new juce::DynamicObject;track->setProperty("id",id);
            auto* state=new juce::DynamicObject;state->setProperty("tracks",juce::Array<juce::var>{juce::var(track)});state->setProperty("index",0);
            removed.setNativeQueue(juce::var(state));removed.loadRemote("https://fixture.googlevideo.com/audio",0,id,true);
            check(entered.wait(2000),"Cancellation fixture did not start");
            removed.setNativeQueue(juce::JSON::parse("{\"tracks\":[],\"index\":0}"));
            for(int i=0;i<1000&&!cancelled.load();++i)juce::Thread::sleep(2);
            check(cancelled.load()&&requests.load()==1,"Obsolete prefetch was not cancelled without retry");
            check(removed.cachedTrack(id).isVoid(),"Cancelled prefetch exposed a partial cache file");
            std::cout<<"PASS: obsolete prefetch cancels without retries or publishing a partial cache\n";
        }
        effectRoutingTests();
        padSampleTests();
        rateTransitionTests();
        fxGraphRoutingTests();
        remoteTransportTests();
        longTrackTests();
        return 0;
    } catch (const std::exception& error) { std::cerr << "FAIL: " << error.what() << "\n"; return 1; }
}
