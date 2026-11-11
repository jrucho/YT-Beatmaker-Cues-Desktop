#include "Processor.h"
#include "NativePadInput.h"
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

static void sampleStartEditingTests(){
    const auto folder=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("beatmaker-start-edit",{});folder.createDirectory();
    struct Cleanup{juce::File folder;~Cleanup(){folder.deleteRecursively();}}cleanup{folder};const auto input=folder.getChildFile("Attack.wav");
    {juce::WavAudioFormat wav;std::unique_ptr<juce::AudioFormatWriter> writer(wav.createWriterFor(input.createOutputStream().release(),24000,2,24,{},0));check(writer!=nullptr,"Cannot create start-edit fixture");
        juce::AudioBuffer<float> data(2,12000);data.clear();for(int i=6000;i<12000;++i){data.setSample(0,i,.25f);data.setSample(1,i,-.125f);}check(writer->writeFromAudioSampleBuffer(data,0,12000),"Cannot write start-edit fixture");}
    CueProcessor processor;processor.prepareToPlay(48000,512);processor.importPadSample(0,0,input);
    const auto retained=juce::File(processor.padSamples()[0]["path"].toString());juce::MemoryBlock original;retained.loadFileAsData(original);
    juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;
    midi.addEvent(juce::MidiMessage::noteOn(1,48,(juce::uint8)127),23);renderChecked(processor,audio,midi);check(audio.getMagnitude(0,512)==0,"Unedited sample should begin with the retained silent lead-in");
    processor.submit({CueProcessor::Action::auditionSample,0,0,.25});renderChecked(processor,audio,midi);
    check(audio.getMagnitude(0,512)>.1f&&(double)processor.padSamples()[0]["start"]==0,"Live start audition was silent or committed its temporary start");
    processor.editPadSample(0,0,.25);midi.addEvent(juce::MidiMessage::allSoundOff(1),0);renderChecked(processor,audio,midi);
    midi.addEvent(juce::MidiMessage::noteOn(1,48,(juce::uint8)127),23);renderChecked(processor,audio,midi);
    check(audio.getMagnitude(0,0,23)==0&&std::abs(audio.getSample(0,511)-.2f)<1e-5f&&std::abs(audio.getSample(1,511)+.1f)<1e-5f,"Edited sample start lost MIDI offset, stereo or original PCM");
    juce::MemoryBlock unchanged;retained.loadFileAsData(unchanged);check(original==unchanged,"Start editing destructively changed the retained file");
    const auto region=processor.waveformRegion(juce::JSON::parse("{\"sample\":true,\"bank\":\"A\",\"pad\":1,\"from\":0.24,\"to\":0.26,\"bins\":128}"));
    check(region["peaks"].size()==128&&(double)region["peaks"][0]==0&&(double)region["peaks"][127]>.2,"Zoomed sample waveform did not represent the original attack boundary");
    const auto descriptor=processor.padSamples()[0];processor.removePadSample(0,0);processor.restorePadSample(0,0,descriptor);
    check(processor.hasPadSample(0,0)&&std::abs((double)processor.padSamples()[0]["start"]-.25)<1e-6,"Retained sample undo did not restore its start/assignment");
    juce::MemoryBlock saved;processor.getStateInformation(saved);CueProcessor recalled;recalled.prepareToPlay(48000,512);recalled.setStateInformation(saved.getData(),(int)saved.getSize());
    for(int i=0;i<1000;++i){if(recalled.padSamples().size()&&(bool)recalled.padSamples()[0]["ready"])break;juce::Thread::sleep(2);}
    check(recalled.padSamples().size()&&std::abs((double)recalled.padSamples()[0]["start"]-.25)<1e-6,"State restart lost the edited sample start");
    bool rejected=false;try{processor.editPadSample(0,0,NAN);}catch(const std::exception&){rejected=true;}check(rejected,"Non-finite sample start was accepted");
    const auto swap=juce::JSON::parse(R"([{"bank":"A","pads":[2,1,3,4,5,6,7,8,9,10,11,12,13,14,15,16]}])");
    processor.remapPadSamples(swap);
    check(!processor.hasPadSample(0,0)&&processor.hasPadSample(0,1)&&(int)processor.padSamples()[0]["pad"]==2&&std::abs((double)processor.padSamples()[0]["start"]-.25)<1e-6,"Content move changed/lost the sample or start instead of moving it to the fixed destination");
    midi.addEvent(juce::MidiMessage::allSoundOff(1),0);renderChecked(processor,audio,midi);processor.submit({CueProcessor::Action::pad,0,1});renderChecked(processor,audio,midi);
    check(audio.getMagnitude(0,512)>.1f,"Moved PCM did not play from the destination pad");
    processor.getStateInformation(saved);recalled.setStateInformation(saved.getData(),(int)saved.getSize());
    for(int i=0;i<1000;++i){if(recalled.hasPadSample(0,1)&&recalled.padSamples().size()&&(bool)recalled.padSamples()[0]["ready"])break;juce::Thread::sleep(2);}
    check(!recalled.hasPadSample(0,0)&&recalled.hasPadSample(0,1)&&(bool)recalled.padSamples()[0]["ready"],"Moved sample assignment did not survive state restore");
    rejected=false;try{processor.remapPadSamples(juce::JSON::parse(R"([{"bank":"A","pads":[1,1]}])"));}catch(const std::exception&){rejected=true;}
    check(rejected&&processor.hasPadSample(0,1),"Invalid content permutation destroyed an assignment");
    processor.remapPadSamples(swap);check(processor.hasPadSample(0,0)&&!processor.hasPadSample(0,1),"Inverse content move did not restore the original assignment");
    juce::MemoryBlock movedFile;check(retained.loadFileAsData(movedFile)&&original==movedFile,"Moving sample contents changed the original PCM file");
    const auto track=processor.importLocalFile(input);auto* queue=new juce::DynamicObject;queue->setProperty("tracks",juce::Array<juce::var>{track});queue->setProperty("index",0);processor.setNativeQueue(juce::var(queue));processor.loadRemote("beatmaker-local://"+track["id"].toString(),0,track["id"].toString());
    for(int i=0;i<1000&&!processor.ready.load();++i){renderChecked(processor,audio,midi);juce::Thread::sleep(2);}check(processor.ready.load(),"Zoomed song fixture did not load");
    auto request=juce::JSON::parse("{\"from\":0.24,\"to\":0.26,\"bins\":128}");request.getDynamicObject()->setProperty("trackId",track["id"]);const auto song=processor.waveformRegion(request);
    check(song["peaks"].size()==128&&(double)song["peaks"][0]==0&&(double)song["peaks"][127]>.2,"High-resolution song waveform missed the local PCM boundary");
    std::cout<<"PASS: non-destructive sample-start editing, MIDI offsets/stereo/PCM, retained-file undo, compatible restart, finite validation and zoomed song/sample waveforms; no callback allocation\n";
}

static void mediaEditingTests(){
    const auto folder=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("beatmaker-media-edit",{});folder.createDirectory();
    struct Cleanup{juce::File folder;~Cleanup(){folder.deleteRecursively();}}cleanup{folder};const auto input=folder.getChildFile("Four regions.wav");
    {juce::WavAudioFormat format;std::unique_ptr<juce::AudioFormatWriter> writer(format.createWriterFor(input.createOutputStream().release(),24000,2,24,{},0));check(writer!=nullptr,"Cannot create chop fixture");
        juce::AudioBuffer<float> pcm(2,24000);const float levels[]={.1f,.2f,-.1f,.3f};for(int i=0;i<24000;++i){pcm.setSample(0,i,levels[i/6000]);pcm.setSample(1,i,-levels[i/6000]*.5f);}check(writer->writeFromAudioSampleBuffer(pcm,0,24000),"Cannot write chop fixture");}
    CueProcessor processor;processor.prepareToPlay(48000,512);processor.preset.store(3);
    const auto track=processor.importLocalAudio(juce::URL(input));const auto retained=juce::File(track["path"].toString());juce::MemoryBlock original;retained.loadFileAsData(original);input.deleteFile();
    const auto source=processor.samplerSource(track);
    check(source["id"].toString()==track["id"].toString()&&source["peaks"].size()==2048&&std::abs((double)source["duration"]-1)<1e-6,"Retained library source/overview did not survive removal of the original file");
    const auto exported=processor.prepareLocalAudioExport(track["id"].toString());const auto exportFolder=juce::File(exported["folder"].toString());Cleanup exportCleanup{exportFolder};
    juce::MemoryBlock exportedBytes;check(juce::File(exported["path"].toString()).loadFileAsData(exportedBytes)&&exportedBytes==original&&exported["name"].toString()=="Four regions.wav","Local audio export changed bytes or lost the original file name/format");
    bool exportRejected=false;try{processor.prepareLocalAudioExport("abcdefghijk");}catch(const std::exception&){exportRejected=true;}check(exportRejected&&retained.existsAsFile(),"Remote audio export was accepted or the managed original was removed");
    auto preview=juce::JSON::parse(R"({"from":0.25,"to":0.5})");preview.getDynamicObject()->setProperty("sourceId",source["id"]);
    processor.previewSamplerSource(preview);juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;renderChecked(processor,audio,midi);
    check(std::abs(audio.getSample(0,511)-.16f)<1e-5&&processor.padSamples().size()==0&&!processor.playing.load()&&processor.getCue(0,0)<0,"Source preview replaced a pad, changed transport or rendered wrong PCM");
    processor.clearSamplerPreview();renderChecked(processor,audio,midi);check(audio.getMagnitude(0,64,448)==0,"Source-preview stop left an audible voice");
    preview.getDynamicObject()->setProperty("ticket",processor.reserveSamplerPreview());processor.clearSamplerPreview();processor.previewSamplerSource(preview);renderChecked(processor,audio,midi);
    check(audio.getMagnitude(0,512)==0,"A cancelled source preview published/played after close");
    auto request=juce::JSON::parse(R"({"from":0.25,"to":0.75,"slices":2,"bank":"A","pad":5})");request.getDynamicObject()->setProperty("sourceId",source["id"]);
    const auto pads=processor.chopSamplerSource(request);check(pads.size()==2&&(int)pads[0]["pad"]==5&&(int)pads[1]["pad"]==6&&pads[0]["peaks"].size()==256,"Chops did not assign to fixed destination pads with ready waveform overviews");
    check(std::abs((double)pads[0]["duration"]-.25)<1e-6&&std::abs((double)pads[1]["duration"]-.25)<1e-6,"Chop boundaries lost source frames");
    processor.submit({CueProcessor::Action::pad,0,4});renderChecked(processor,audio,midi);check(std::abs(audio.getSample(0,511)-.16f)<1e-5&&std::abs(audio.getSample(1,511)+.08f)<1e-5,"First chop PCM/stereo is incorrect");
    midi.addEvent(juce::MidiMessage::allSoundOff(1),0);renderChecked(processor,audio,midi);midi.addEvent(juce::MidiMessage::noteOn(1,41,(juce::uint8)127),23);renderChecked(processor,audio,midi);
    check(audio.getMagnitude(0,0,23)==0&&std::abs(audio.getSample(0,511)+.08f)<1e-5,"Second chop lost native MIDI sample-offset playback");
    juce::MemoryBlock unchanged;retained.loadFileAsData(unchanged);check(original==unchanged,"Chopping changed the retained original source");
    juce::Array<juce::var> restore;for(const auto& pad:*pads.getArray()){auto* entry=new juce::DynamicObject;entry->setProperty("bank",pad["bank"]);entry->setProperty("pad",pad["pad"]);entry->setProperty("descriptor",pad);restore.add(juce::var(entry));}
    processor.assignPadSamples(juce::JSON::parse(R"([{"bank":"A","pad":5,"descriptor":null},{"bank":"A","pad":6,"descriptor":null}])"));check(!processor.hasPadSample(0,4)&&!processor.hasPadSample(0,5),"Batch chop undo did not clear destination assignments");
    processor.assignPadSamples(juce::var(restore));check(processor.hasPadSample(0,4)&&processor.hasPadSample(0,5),"Retained chop redo did not restore assignments");
    bool rejected=false;auto invalid=juce::var(restore).clone();(*invalid.getArray())[1].getDynamicObject()->setProperty("descriptor",juce::JSON::parse(R"({"path":"/missing/chop.wav"})"));
    try{processor.assignPadSamples(invalid);}catch(const std::exception&){rejected=true;}check(rejected&&processor.hasPadSample(0,4)&&processor.hasPadSample(0,5),"Failed batch replacement partially destroyed existing pads");
    const auto before=juce::JSON::toString(processor.padSamples());rejected=false;request.getDynamicObject()->setProperty("pad",16);try{processor.chopSamplerSource(request);}catch(const std::exception&){rejected=true;}
    check(rejected&&juce::JSON::toString(processor.padSamples())==before,"Out-of-bank chops altered saved assignments");
    juce::MemoryBlock saved;processor.getStateInformation(saved);CueProcessor recalled;recalled.prepareToPlay(48000,512);recalled.setStateInformation(saved.getData(),(int)saved.getSize());
    for(int i=0;i<1000;++i){const auto state=recalled.padSamples();if(state.size()==2&&(bool)state[0]["ready"]&&(bool)state[1]["ready"])break;juce::Thread::sleep(2);}
    check(recalled.hasPadSample(0,4)&&recalled.hasPadSample(0,5)&&(bool)recalled.padSamples()[0]["ready"],"Chop assignments did not survive state restore");
    std::cout<<"PASS: retained URL/file import, source peaks/preview/cancellation, exact stereo chop PCM and MIDI offsets, atomic batch replacement/undo/redo, original preservation and state recall; no callback allocation\n";
}

static void recordingTests(){
    CueProcessor processor;processor.prepareToPlay(48000,256);processor.installSampleForTest(sample());
    juce::AudioBuffer<float> audio(2,256);juce::MidiBuffer midi;renderChecked(processor,audio,midi);
    processor.recording(juce::JSON::parse(R"({"cmd":"start","source":"playback"})"));processor.submit({CueProcessor::Action::play});
    juce::AudioBuffer<float> expected(2,256*20);
    for(int i=0;i<20;++i){renderChecked(processor,audio,midi);for(int c=0;c<2;++c)expected.copyFrom(c,i*256,audio,c,0,256);}
    const auto stopped=processor.recording(juce::JSON::parse(R"({"cmd":"stop"})")),track=stopped["track"];
    check(track["id"].toString().startsWith("loc")&&(bool)track["recorded"]&&std::abs((double)track["duration"]-5120.0/48000)<1e-6,"Playback recording did not register exact length as managed local audio");
    juce::AudioFormatManager formats;formats.registerBasicFormats();auto reader=std::unique_ptr<juce::AudioFormatReader>(formats.createReaderFor(juce::File(track["path"].toString())));
    check(reader&&reader->lengthInSamples==5120&&reader->numChannels==2,"Recorded WAV lost frame/channel count");
    juce::AudioBuffer<float> recorded(2,5120);reader->read(&recorded,0,5120,0,true,true);for(int c=0;c<2;++c)for(int i=0;i<5120;++i)check(std::abs(recorded.getSample(c,i)-expected.getSample(c,i))<2e-6,"Playback recording PCM differs from actual rendered cue audio");
    check(processor.cachedTrack(track["id"].toString()).isObject(),"Finished recording could not load through the native local resolver");
    const auto exported=processor.prepareLocalAudioExport(track["id"].toString());const juce::File exportedFile(exported["path"].toString());juce::MemoryBlock takeBytes,copyBytes;
    check(juce::File(track["path"].toString()).loadFileAsData(takeBytes)&&exportedFile.loadFileAsData(copyBytes)&&takeBytes==copyBytes&&exportedFile.getFileExtension()==".wav","Recording download/share preparation altered the retained WAV");juce::File(exported["folder"].toString()).deleteRecursively();
    const auto directory=processor.libraryStore.mediaDirectory().getChildFile("Recordings");const auto inputFile=directory.getChildFile("Recording-input-test-"+juce::Uuid().toString()+".wav");
    processor.recorder.start(inputFile,48000,false);juce::AudioBuffer<float> input(1,256);for(int i=0;i<256;++i)input.setSample(0,i,i==0?NAN:.125f);
    const auto before=audioAllocations;onAudioThread=true;processor.recorder.capture(input.getArrayOfReadPointers(),1,256,48000,true);processor.recorder.capture(input.getArrayOfReadPointers(),1,256,48000,false);onAudioThread=false;
    check(audioAllocations==before,"Input recording allocated in its callback");
    processor.recorder.interrupt();onAudioThread=true;processor.recorder.capture(input.getArrayOfReadPointers(),1,256,48000,false);onAudioThread=false;
    check(!(bool)processor.recorder.state()["recording"]&&(double)processor.recorder.state()["seconds"]==256.0/48000,"Interrupted input take continued appending or captured the wrong producer");
    const auto finished=processor.recorder.finish();check((juce::int64)finished["frames"]==256&&finished["message"].toString().isNotEmpty(),"Interrupted input take lost frame count/error status");
    reader.reset(formats.createReaderFor(inputFile));check(reader&&reader->lengthInSamples==256&&reader->numChannels==2,"Input take could not be recovered after route interruption");
    recorded.setSize(2,256);reader->read(&recorded,0,256,0,true,true);check(recorded.getSample(0,0)==0&&std::abs(recorded.getSample(0,255)-.125f)<1e-6&&recorded.getSample(0,255)==recorded.getSample(1,255),"Input recording did not sanitize NaN/duplicate mono to stereo");
    const auto recovered=processor.recording(juce::JSON::parse(R"({"cmd":"recover"})"));bool found=false;for(const auto& entry:*recovered.getArray())if(entry["path"].toString()==inputFile.getFullPathName())found=true;
    check(found&&processor.recording(juce::JSON::parse(R"({"cmd":"recover"})")).size()==0,"Unfiled recording recovery missed/duplicated a retained take");
    const auto rateFile=directory.getChildFile("Recording-rate-test-"+juce::Uuid().toString()+".wav");processor.recorder.start(rateFile,48000,false);processor.recorder.capture(input.getArrayOfReadPointers(),1,256,44100,false);
    check(!(bool)processor.recorder.state()["recording"]&&processor.recorder.state()["message"].toString().contains("Sample rate"),"Recorder silently accepted a mid-take sample-rate change");processor.recorder.finish();rateFile.deleteFile();
    std::cout<<"PASS: exact native rendered-playback WAV, microphone/USB producer isolation, allocation-free input capture, mono/stereo/NaN, route/rate interruption and idempotent retained-take recovery\n";
}

#if BEATMAKER_PERFORMANCE_FEATURES && !BEATMAKER_DESKTOP_BETA
static void hostedInputTests(){
    juce::AudioProcessor::setTypeOfNextNewPlugin(juce::AudioProcessor::wrapperType_VST3);CueProcessor processor;juce::AudioProcessor::setTypeOfNextNewPlugin(juce::AudioProcessor::wrapperType_Undefined);
    check(processor.getBusCount(true)==1&&processor.getTotalNumInputChannels()==0&&!processor.getVST3ClientExtensions()->getPluginHasMainInput(),"Hosted recording input must be an optional disabled sidechain");
    const auto configure=[&](const char* json){juce::var result;bool done=false;processor.configureAudio(juce::JSON::parse(json),[&](juce::var value){result=value;done=true;});check(done,"Hosted routing unexpectedly waited for device access");return result;};
    check(configure(R"({"inputEnabled":true})").hasProperty("__error"),"Hosted input was falsely accepted before the DAW bus was connected");
    auto layout=processor.getBusesLayout();layout.inputBuses.getReference(0)=juce::AudioChannelSet::stereo();check(processor.setBusesLayout(layout),"DAW stereo recorder input was rejected");processor.prepareToPlay(48000,128);
    check((bool)processor.audioRoutes()["hostManaged"]&&(bool)processor.audioRoutes()["inputActive"]&&!(bool)processor.audioRoutes()["monitor"],"Hosted route status/monitor default is incorrect");
    juce::AudioBuffer<float> audio(2,128);juce::MidiBuffer midi;const auto fill=[&]{for(int i=0;i<128;++i){audio.setSample(0,i,.125f);audio.setSample(1,i,-.25f);}};fill();renderChecked(processor,audio,midi);check(audio.getMagnitude(0,128)==0,"Unmonitored DAW input leaked into the instrument output");
    processor.recording(juce::JSON::parse(R"({"cmd":"start","source":"input"})"));check(!configure(R"({"monitor":true,"monitorLevel":0.5})").hasProperty("__error"),"Hosted monitor could not enable on an accepted DAW bus");
    for(int block=0;block<4;++block){fill();renderChecked(processor,audio,midi);check(std::abs(audio.getSample(0,127)-.0625f)<1e-7&&std::abs(audio.getSample(1,127)+.125f)<1e-7,"Hosted monitoring changed stereo routing/gain");}
    const auto inputTake=processor.recording(juce::JSON::parse(R"({"cmd":"stop"})"));juce::AudioFormatManager formats;formats.registerBasicFormats();auto reader=std::unique_ptr<juce::AudioFormatReader>(formats.createReaderFor(juce::File(inputTake["track"]["path"].toString())));check(reader&&reader->lengthInSamples==512,"Hosted input WAV lost its sample count");juce::AudioBuffer<float> pcm(2,512);reader->read(&pcm,0,512,0,true,true);check(std::abs(pcm.getSample(0,511)-.125f)<1e-6&&std::abs(pcm.getSample(1,511)+.25f)<1e-6,"Hosted input recording captured monitor gain instead of the raw DAW input");
    processor.recording(juce::JSON::parse(R"({"cmd":"start","source":"playback"})"));for(int block=0;block<4;++block){fill();renderChecked(processor,audio,midi);}const auto playbackTake=processor.recording(juce::JSON::parse(R"({"cmd":"stop"})"));reader.reset(formats.createReaderFor(juce::File(playbackTake["track"]["path"].toString())));check(reader&&reader->lengthInSamples==512,"Hosted playback WAV was not retained");reader->read(&pcm,0,512,0,true,true);check(pcm.getMagnitude(0,512)==0&&audio.getMagnitude(0,128)>.01f,"Resampling captured separately monitored DAW input");
    check(configure(R"({"input":"usb"})").hasProperty("__error"),"Hosted plug-in attempted to own the DAW's sound card");check(configure(R"({"monitorLevel":2})").hasProperty("__error"),"Hosted monitor accepted an invalid level");
    processor.releaseResources();check(!processor.monitorInput.load()&&(bool)processor.audioRoutes()["monitorSuspended"],"DAW input stop left monitoring live");processor.prepareToPlay(48000,128);check(processor.monitorInput.load(),"Same DAW bus did not restore its requested monitoring state");configure(R"({"monitor":false})");processor.releaseResources();processor.prepareToPlay(48000,128);check(!processor.monitorInput.load(),"DAW reinitialization overrode explicit monitoring Off");
    configure(R"({"monitor":true,"monitorLevel":0.25})");processor.releaseResources();layout.inputBuses.getReference(0)=juce::AudioChannelSet::disabled();check(processor.setBusesLayout(layout),"DAW could not disable the optional recorder bus");processor.prepareToPlay(48000,128);check(!(bool)processor.audioRoutes()["inputActive"]&&(bool)processor.audioRoutes()["monitorRequested"]&&!processor.monitorInput.load(),"Disconnected DAW bus did not mute while retaining the request");
    layout.inputBuses.getReference(0)=juce::AudioChannelSet::mono();check(processor.setBusesLayout(layout),"Mono DAW input was rejected");processor.prepareToPlay(48000,128);fill();renderChecked(processor,audio,midi);check(std::abs(audio.getSample(0,127)-.03125f)<1e-7&&audio.getSample(0,127)==audio.getSample(1,127),"Mono hosted input did not duplicate to the stereo monitor");
    layout.inputBuses.getReference(0)=juce::AudioChannelSet::stereo();layout.outputBuses.getReference(0)=juce::AudioChannelSet::mono();check(processor.setBusesLayout(layout),"Stereo input/mono output host layout was rejected");processor.prepareToPlay(48000,128);fill();renderChecked(processor,audio,midi);check(std::abs(audio.getSample(0,127)-.03125f)<1e-7&&audio.getSample(1,127)==0,"Hosted mono output leaked an unrendered input channel");
    juce::MemoryBlock saved;processor.getStateInformation(saved);juce::AudioProcessor::setTypeOfNextNewPlugin(juce::AudioProcessor::wrapperType_VST3);CueProcessor restored;juce::AudioProcessor::setTypeOfNextNewPlugin(juce::AudioProcessor::wrapperType_Undefined);restored.setStateInformation(saved.getData(),(int)saved.getSize());check((bool)restored.audioRoutes()["monitorRequested"]&&!restored.monitorInput.load()&&std::abs((double)restored.audioRoutes()["monitorLevel"]-.25)<1e-7,"Host input preferences were lost or went live before bus reconnection");
    std::cout<<"PASS: optional DAW sidechain, no default input-through, exact raw stereo input WAV, separate monitor/playback capture, mono layouts, bus stop/reconnect/Off and host-state recall; no callback allocation\n";
}
#endif

static void emptyTrackTests(){
    CueProcessor processor;processor.prepareToPlay(48000,512);processor.preset.store(3);processor.installSampleForTest(sample());
    processor.importPadSample(0,0,juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a"));
    juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;renderChecked(processor,audio,midi);
    processor.setWebState(R"({"musike:cues:v1":"{\"empty-source\":{\"A\":{\"2\":0.125}}}","musike:player":"{\"queue\":[{\"id\":\"empty-source\"}],\"index\":0}"})");
    processor.syncWebCues(juce::JSON::parse(R"({"trackId":"empty-source","bank":"A","preset":"linear16","cues":{"A":{"2":0.125}}})"));
    processor.setNativeQueue(juce::JSON::parse(R"({"tracks":[{"id":"empty-source"}],"index":0,"repeat":"one"})"));
    processor.submit({CueProcessor::Action::cue,0,1,.125});renderChecked(processor,audio,midi);
    processor.submit({CueProcessor::Action::pad,0,2,0,true});renderChecked(processor,audio,midi);const auto marked=processor.getCue(0,2);
    CueProcessor::Command late{CueProcessor::Action::cue,0,1,.125};late.sourceGeneration=processor.audioGeneration();processor.submit(late);
    const auto previous=processor.unloadSong();renderChecked(processor,audio,midi);
    check(previous["trackId"].toString()=="empty-source"&&std::abs((double)previous["cues"]["A"]["3"]-marked)<1e-6,"Empty track did not preserve the final native cue snapshot");
    check(!processor.ready.load()&&!processor.playing.load()&&processor.getDuration()==0&&processor.playhead.load()==0&&audio.getMagnitude(0,512)==0,"Empty track retained old song PCM/transport or accepted an old queued cue");
    const auto snapshot=processor.nativeSnapshot();check(!(bool)snapshot["canNext"]&&!(bool)snapshot["canPrevious"]&&snapshot["trackId"].isVoid(),"Old native queue/Now Playing survived creating an empty track");
    const auto saved=juce::JSON::parse(processor.getWebState()),all=juce::JSON::parse(saved["musike:cues:v1"].toString());check(std::abs((double)all["empty-source"]["A"]["3"]-marked)<1e-6,"Empty track erased saved song-specific cues");
    midi.addEvent(juce::MidiMessage::noteOn(1,37,(juce::uint8)127),0);renderChecked(processor,audio,midi);
    check(processor.getCue(0,1)<0&&audio.getMagnitude(0,512)==0,"MIDI on an unassigned empty-track pad marked/replayed the old song");
    processor.recording(juce::JSON::parse(R"({"cmd":"start","source":"playback"})"));midi.addEvent(juce::MidiMessage::noteOn(1,36,(juce::uint8)127),23);renderChecked(processor,audio,midi);
    check(processor.hasPadSample(0,0)&&audio.getMagnitude(0,512)>.001f&&audio.getMagnitude(0,0,23)==0&&!processor.ready.load(),"Empty track lost sample playback or MIDI sample offsets");
    const auto take=processor.recording(juce::JSON::parse(R"({"cmd":"stop"})"));juce::AudioFormatManager formats;formats.registerBasicFormats();
    auto reader=std::unique_ptr<juce::AudioFormatReader>(formats.createReaderFor(juce::File(take["track"]["path"].toString())));check(reader&&reader->lengthInSamples==512,"Sample-only recording on an empty track did not produce a retained take");
    juce::AudioBuffer<float> recorded(2,512);reader->read(&recorded,0,512,0,true,true);for(int c=0;c<2;++c)for(int i=0;i<512;++i)check(std::abs(recorded.getSample(c,i)-audio.getSample(c,i))<2e-6,"Empty-track recording mixed in old song audio or changed sample PCM");
    std::cout<<"PASS: native empty-track unload, stale-command/queue cancellation, final MIDI cue preservation, no old-song triggers, and sample-only MIDI/recording with exact PCM; no callback allocation\n";
}

static void recordingMidiGuardTests(){
    CueProcessor processor;processor.prepareToPlay(48000,512);processor.preset.store(3);processor.installSampleForTest(sample());
    processor.importPadSample(0,0,juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a"));
    juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;renderChecked(processor,audio,midi);
    processor.syncWebCues(juce::JSON::parse(R"({"trackId":"midi-record-guard","bank":"A","preset":"linear16","cues":{"A":{"2":0.125}}})"));
    midi.addEvent(juce::MidiMessage::noteOn(1,37,(juce::uint8)127),23);renderChecked(processor,audio,midi);
    check(processor.playing.load()&&(processor.padStates[1].load()&1u)!=0,"Unblocked recording MIDI fixture did not trigger/hold its cue");
    const auto cueHits=processor.padStates[1].load()>>1,sampleHits=processor.padStates[0].load()>>1;
    processor.recordingMidiGuards.store(1);processor.submit({CueProcessor::Action::pause});
    midi.addEvent(juce::MidiMessage::noteOff(1,37),0);midi.addEvent(juce::MidiMessage::noteOn(1,36,(juce::uint8)127),10);
    midi.addEvent(juce::MidiMessage::noteOn(1,37,(juce::uint8)127),20);midi.addEvent(juce::MidiMessage::noteOn(1,38,(juce::uint8)127),30);
    midi.addEvent(juce::MidiMessage::controllerEvent(1,22,127),40);renderChecked(processor,audio,midi);
    check(!processor.playing.load()&&audio.getMagnitude(0,512)==0&&(processor.padStates[1].load()>>1)==cueHits&&(processor.padStates[0].load()>>1)==sampleHits,"Suspended MIDI retriggered a cue or sample");
    check((processor.padStates[1].load()&1u)==0&&processor.getCue(0,1)==.125&&processor.getCue(0,2)<0,"MIDI guard blocked a release or created/overwrote a cue");
    processor.inputChannels.store(2);processor.inputRate.store(48000);processor.recording(juce::JSON::parse(R"({"cmd":"start","source":"input"})"));
    juce::AudioBuffer<float> input(2,512);for(int i=0;i<512;++i){input.setSample(0,i,.125f);input.setSample(1,i,-.25f);}
    const auto allocations=audioAllocations;onAudioThread=true;processor.recorder.capture(input.getArrayOfReadPointers(),2,512,48000,false);onAudioThread=false;
    check(audioAllocations==allocations,"Guarded input recording allocated on the audio callback");
    const auto take=processor.recording(juce::JSON::parse(R"({"cmd":"stop"})"));juce::AudioFormatManager formats;formats.registerBasicFormats();
    auto reader=std::unique_ptr<juce::AudioFormatReader>(formats.createReaderFor(juce::File(take["track"]["path"].toString())));check(reader&&reader->lengthInSamples==512,"MIDI suspension interrupted audio-input capture");
    juce::AudioBuffer<float> captured(2,512);reader->read(&captured,0,512,0,true,true);check(std::abs(captured.getSample(0,511)-.125f)<1e-6&&std::abs(captured.getSample(1,511)+.25f)<1e-6,"MIDI guard changed external input PCM");
    processor.submit({CueProcessor::Action::pad,0,0});renderChecked(processor,audio,midi);check((processor.padStates[0].load()>>1)==sampleHits+1,"MIDI guard incorrectly disabled direct on-screen pad commands");
    processor.recordingMidiGuards.store(0);midi.addEvent(juce::MidiMessage::noteOn(1,37,(juce::uint8)127),23);renderChecked(processor,audio,midi);
    check(processor.playing.load()&&(processor.padStates[1].load()>>1)==cueHits+1,"MIDI pad control did not resume after releasing the recording guard");
    processor.submit({CueProcessor::Action::cue,0,1,.125});renderChecked(processor,audio,midi);check((processor.padStates[1].load()&1u)!=0,"On-screen playback erased a physically held MIDI pad");
    processor.fineMidiEditors.store(1);processor.overwrite.store(true);midi.addEvent(juce::MidiMessage::noteOn(1,37,(juce::uint8)100),0);midi.addEvent(juce::MidiMessage::noteOn(1,38,(juce::uint8)100),1);renderChecked(processor,audio,midi);
    check(processor.getCue(0,1)==.125&&processor.getCue(0,2)<0&&processor.playing.load(),"Fine-mode MIDI overwrote/created a cue instead of selecting/auditioning");
    processor.fineMidiEditors.store(0);processor.overwrite.store(false);
    processor.recordingMidiGuards.store(1);midi.addEvent(juce::MidiMessage::noteOn(1,37,(juce::uint8)0),0);renderChecked(processor,audio,midi);check((processor.padStates[1].load()&1u)==0,"Guarded velocity-zero release stuck a held MIDI pad");
    midi.addEvent(juce::MidiMessage::allSoundOff(1),0);renderChecked(processor,audio,midi);check(!processor.playing.load()&&audio.getMagnitude(0,64,448)==0,"Recording MIDI guard suppressed All Sound Off");
    juce::MemoryBlock state;processor.getStateInformation(state);CueProcessor recalled;recalled.prepareToPlay(48000,512);recalled.setStateInformation(state.getData(),(int)state.getSize());check(recalled.recordingMidiGuards.load()==0,"Transient recording MIDI suspension leaked into saved musical state");
    std::cout<<"PASS: recording MIDI guard blocks cue/sample/mark/CC presses, preserves note-off/zero-velocity/panic and input PCM, keeps direct pads, restores triggering and is not saved; no callback allocation\n";
}

static void mixerTests(){
    CueProcessor processor;processor.prepareToPlay(48000,512);processor.installSampleForTest(sample());juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;renderChecked(processor,audio,midi);processor.submit({CueProcessor::Action::play});
    processor.setMixer(juce::JSON::parse(R"({"enabled":false,"song":0.5,"samples":1,"output":1.5})"));for(int i=0;i<3;++i)renderChecked(processor,audio,midi);
    check(std::abs(audio.getSample(0,511)-.2f)<1e-6&&std::abs(audio.getSample(1,511)+.1f)<1e-6,"Song bus fader did not scale native cue audio");
    beatmaker::dsp::Dynamics reference;reference.prepare(48000);reference.configure(-30,0,20,.01f,.2f);reference.reset();processor.setMixer(juce::JSON::parse(R"({"enabled":true})"));
    for(int block=0;block<12;++block){renderChecked(processor,audio,midi);for(int i=0;i<512;++i){const auto expected=reference.process({.25f,-.125f});check(std::abs(audio.getSample(0,i)-expected[0]*1.5f*.8f)<2e-6&&std::abs(audio.getSample(1,i)-expected[1]*1.5f*.8f)<2e-6,"Native compressor differs from the original desktop default curve/post gain");}}
    check(processor.getLatencySamples()==288,"Enabled compressor did not report its native look-ahead latency");
    processor.setMixer(juce::JSON::parse(R"({"enabled":false,"song":1,"samples":0})"));for(int i=0;i<3;++i)renderChecked(processor,audio,midi);check(processor.getLatencySamples()==0&&std::abs(audio.getSample(0,511)-.4f)<1e-6,"Compressor bypass changed timing or dry song audio");
    const auto before=juce::JSON::toString(processor.mixerState());bool rejected=false;try{processor.setMixer(juce::JSON::parse(R"({"song":0.2,"samples":9})"));}catch(const std::exception&){rejected=true;}check(rejected&&juce::JSON::toString(processor.mixerState())==before,"Invalid mixer input partially applied");
    juce::MemoryBlock state;processor.getStateInformation(state);CueProcessor recalled;recalled.prepareToPlay(48000,512);recalled.setStateInformation(state.getData(),(int)state.getSize());check((double)recalled.mixerState()["samples"]==0,"Host state did not restore mixer levels");
    auto legacy=juce::AudioProcessor::getXmlFromBinary(state.getData(),(int)state.getSize());legacy->deleteAllChildElementsWithTagName("Mixer");juce::MemoryBlock old;juce::AudioProcessor::copyXmlToBinary(*legacy,old);recalled.setStateInformation(old.getData(),(int)old.getSize());check((double)recalled.mixerState()["samples"]==1&&!(bool)recalled.mixerState()["enabled"],"Legacy state inherited non-neutral mixer settings");
    CueProcessor samples;samples.prepareToPlay(48000,512);samples.importPadSample(0,0,juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a"));samples.setMixer(juce::JSON::parse(R"({"song":1,"samples":0})"));for(int i=0;i<3;++i)renderChecked(samples,audio,midi);samples.submit({CueProcessor::Action::pad,0,0});renderChecked(samples,audio,midi);check(audio.getMagnitude(0,512)==0,"Sample/drum bus mute did not silence sample pads independently");
    std::cout<<"PASS: native two-bus mixer, original desktop compressor threshold/knee/ratio/attack/release/post gain, exact dry bypass, reported latency, validation and state; no callback allocation\n";
}

static void padLooperTests(){
    PadLooper looper;looper.publish(PadLooper::restore({},1));std::vector<PadLooper::Event> notes;notes.reserve(256);
    const auto rt=[&](auto&& work){const auto before=audioAllocations;onAudioThread=true;work();onAudioThread=false;check(audioAllocations==before,"Pad looper allocated on its real-time path");};
    const auto fire=[&]{looper.fire([&](PadLooper::Event event){notes.push_back(event);});};
    rt([&]{looper.beginBlock();looper.control(PadLooper::assign,0,15);looper.control(PadLooper::press,0,15);looper.control(PadLooper::release,0,15);looper.capture(0,0,.5f);looper.advance(32,48000);looper.capture(0,1,1);looper.advance(96,48000);looper.control(PadLooper::press,0,15);looper.control(PadLooper::release,0,15);fire();});
    auto state=looper.snapshot(true);check((int)state["pads"][0]["length"]==128&&state["pads"][0]["events"].size()==2&&notes.size()==1&&notes[0].pad==0&&notes[0].velocity==64,"First loop did not retain exact event offsets/velocity/length");
    check(looper.segment(512,48000)==32,"Looper did not split the renderer exactly at the next event");rt([&]{looper.advance(32,48000);fire();looper.advance(96,48000);fire();});check(notes.size()==3&&notes[1].pad==1&&notes[2].pad==0,"Loop cycle/event ordering is incorrect");
    rt([&]{looper.advance(15000,48000);fire();looper.control(PadLooper::press,0,15);looper.control(PadLooper::release,0,15);looper.capture(0,2,1);});const size_t born=notes.size();rt([&]{fire();});check(notes.size()==born,"A newly overdubbed note replayed twice in its birth cycle");
    rt([&]{looper.advance(128,48000);fire();});check(notes.back().pad==2,"Overdubbed notes did not repeat during continued overdubbing");
    rt([&]{looper.advance(15000,48000);fire();});const size_t beforeCommit=notes.size();rt([&]{looper.control(PadLooper::press,0,15);looper.control(PadLooper::release,0,15);fire();});
    check(notes.size()==beforeCommit,"Committing an overdub replayed already-processed notes");state=looper.snapshot(true);check((int)state["pads"][0]["layers"]==2&&state["pads"][0]["events"].size()==3,"Overdub did not retain its independent layer");const auto saved=state.clone();
    rt([&]{looper.control(PadLooper::undo,0,15);looper.control(PadLooper::stop,0,15);looper.advance(15000,48000);looper.control(PadLooper::press,0,15);looper.control(PadLooper::release,0,15);});notes.clear();rt([&]{fire();looper.advance(24,48000);fire();});check(notes.size()==1&&notes[0].pad==0,"Last-layer undo replayed the removed overdub");
    rt([&]{looper.control(PadLooper::undo,0,15);looper.control(PadLooper::stop,0,15);looper.advance(15000,48000);looper.control(PadLooper::press,0,15);looper.control(PadLooper::release,0,15);});notes.clear();rt([&]{fire();looper.advance(24,48000);fire();});check(notes.size()==2&&notes[1].pad==2,"Layer redo did not restore the recorded note");
    rt([&]{looper.advance(1000,48000);looper.control(PadLooper::press,0,15);looper.advance(28800,48000);fire();looper.control(PadLooper::release,0,15);});check((bool)looper.snapshot(false)["pads"][0]["undone"],"Double-tap-and-hold did not undo the last layer");
    rt([&]{looper.control(PadLooper::press,0,15);looper.control(PadLooper::release,0,15);looper.advance(1000,48000);looper.control(PadLooper::press,0,15);looper.advance(28800,48000);fire();looper.control(PadLooper::release,0,15);});state=looper.snapshot(false);check(!(bool)state["pads"][0]["undone"]&&(int)state["pads"][0]["layers"]==2,"Next double-hold discarded redo history instead of restoring the last layer");
    PadLooper recalled;recalled.publish(PadLooper::restore(saved,2));rt([&]{recalled.beginBlock();});check(recalled.assigned(0,15)&&recalled.snapshot(true)["pads"][0]["events"].size()==3&&(int)recalled.snapshot(false)["pads"][0]["mode"]==PadLooper::stopped,"Looper restore lost events/layers or started playing automatically");
    for(const double rate:{44100.0,96000.0}){
        PadLooper timed;timed.publish(PadLooper::restore(saved,1));rt([&]{timed.beginBlock();timed.control(PadLooper::press,0,15);timed.control(PadLooper::release,0,15);});
        std::vector<int> frames;frames.reserve(256);int frame=0;
        while(frame<512){rt([&]{timed.fire([&](PadLooper::Event event){if(event.pad==1)frames.push_back(frame);});const int count=timed.segment(juce::jmin(13,512-frame),rate);timed.advance(count,rate);frame+=count;});}
        check(!frames.empty(),"Resampled loop did not replay");for(size_t i=0;i<frames.size();++i)check(frames[i]==(int)std::ceil((32.0+128.0*i)*rate/48000.0-1e-8),"Looper introduced sample drift at a different device rate");
    }
    rt([&]{looper.advance(15000,48000);looper.control(PadLooper::press,0,15);looper.advance(57600,48000);fire();looper.control(PadLooper::release,0,15);});state=looper.snapshot(false);check(looper.assigned(0,15)&&(int)state["pads"][0]["count"]==0&&(int)state["pads"][0]["length"]==0,"Deliberate hold did not clear the loop while retaining assignment");
    rt([&]{recalled.control(PadLooper::assign,0,14);recalled.control(PadLooper::press,0,15);recalled.control(PadLooper::release,0,15);recalled.control(PadLooper::press,0,14);recalled.control(PadLooper::release,0,14);});int active=0;const auto switched=recalled.snapshot(false);for(const auto& pad:*switched["pads"].getArray())if((int)pad["mode"]!=PadLooper::stopped)++active;check(active==1,"Switching loop pads left more than one clip active");
    CueProcessor engine;engine.prepareToPlay(48000,512);engine.preset.store(3);engine.importPadSample(0,0,juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a"));juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;
    engine.looperAction(juce::JSON::parse(R"({"cmd":"assign","bank":"A","pad":16})"));renderChecked(engine,audio,midi);check(engine.hasPadLooper(0,15),"Native looper assignment did not reach the audio owner");
    midi.addEvent(juce::MidiMessage::noteOn(1,51,(juce::uint8)127),0);midi.addEvent(juce::MidiMessage::noteOff(1,51),1);renderChecked(engine,audio,midi);
    midi.addEvent(juce::MidiMessage::noteOn(1,36,(juce::uint8)127),23);midi.addEvent(juce::MidiMessage::noteOff(1,36),24);renderChecked(engine,audio,midi);
    midi.addEvent(juce::MidiMessage::noteOn(1,51,(juce::uint8)127),0);midi.addEvent(juce::MidiMessage::noteOff(1,51),1);renderChecked(engine,audio,midi);const auto hits=engine.padStates[0].load()>>1;
    juce::AudioBuffer<float> shortBlock(2,23),single(2,1);renderChecked(engine,shortBlock,midi);check((engine.padStates[0].load()>>1)==hits,"Native loop event fired before its recorded sample offset");renderChecked(engine,single,midi);check((engine.padStates[0].load()>>1)==hits+1,"Native loop did not replay exactly at the recorded MIDI offset");
    check((engine.padStates[0].load()&1u)==0,"Loop replay fabricated a held physical MIDI pad");
    const auto loops=engine.looperData();check(loops["songs"]["@empty"]["pads"][0]["events"].size()==1,"Loop playback recursively recorded its own events");
    juce::MemoryBlock host;engine.getStateInformation(host);CueProcessor hostRecall;hostRecall.prepareToPlay(48000,512);hostRecall.setStateInformation(host.getData(),(int)host.getSize());renderChecked(hostRecall,audio,midi);check(hostRecall.hasPadLooper(0,15)&&hostRecall.looperState(true)["pads"][0]["events"].size()==1,"Host state did not restore native pad-loop events");
    const auto one=engine.importLocalFile(juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a")),two=engine.importLocalFile(juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a"));
    const auto selectSong=[&](int index){auto* queue=new juce::DynamicObject;queue->setProperty("tracks",juce::Array<juce::var>{one,two});queue->setProperty("index",index);engine.setNativeQueue(juce::var(queue));const auto id=(index?two:one)["id"].toString();engine.loadRemote("beatmaker-local://"+id,0,id);for(int i=0;i<1000&&!engine.ready.load();++i){renderChecked(engine,audio,midi);juce::Thread::sleep(2);}check(engine.ready.load(),"Looper navigation source did not load");renderChecked(engine,audio,midi);};
    selectSong(0);check(engine.looperState()["pads"].size()==0,"An unseen song inherited another song/empty-workspace loopers");
    engine.looperAction(juce::JSON::parse(R"({"cmd":"assign","bank":"A","pad":15})"));renderChecked(engine,audio,midi);engine.looperAction(juce::JSON::parse(R"({"cmd":"press","bank":"A","pad":15})"));engine.looperAction(juce::JSON::parse(R"({"cmd":"release","bank":"A","pad":15})"));renderChecked(engine,audio,midi);
    midi.addEvent(juce::MidiMessage::noteOn(1,36,(juce::uint8)90),40);renderChecked(engine,audio,midi);engine.looperAction(juce::JSON::parse(R"({"cmd":"press","bank":"A","pad":15})"));engine.looperAction(juce::JSON::parse(R"({"cmd":"release","bank":"A","pad":15})"));renderChecked(engine,audio,midi);
    selectSong(1);check(engine.looperState()["pads"].size()==0,"Changing songs did not stop/isolate the active MIDI pad loop");selectSong(0);check(engine.hasPadLooper(0,14)&&engine.looperState(true)["pads"][0]["events"].size()==1&&(int)engine.looperState()["pads"][0]["mode"]==PadLooper::stopped,"Returning to a song lost its loop or resumed it without a press");
    std::cout<<"PASS: exact native internal pad-loop timing/velocity, record/play/overdub, live overdub repeat/no double replay, independent layer undo/redo and hold gestures, exclusive switching and state; no callback allocation\n";
}

static void permanentLocalEraseTests(){
    CueProcessor engine;engine.prepareToPlay(48000,512);engine.installSampleForTest(sample());juce::AudioBuffer<float> pcm(2,512);juce::MidiBuffer midi;renderChecked(engine,pcm,midi);engine.recording(juce::JSON::parse(R"({"cmd":"start","source":"playback"})"));engine.submit({CueProcessor::Action::play});renderChecked(engine,pcm,midi);
    const auto take=engine.recording(juce::JSON::parse(R"({"cmd":"stop"})")),track=take["track"];const auto id=track["id"].toString();const juce::File file(track["path"].toString());engine.samplerSource(track);
    auto library=juce::JSON::parse(engine.libraryStore.readLibrary());const auto baseline=juce::JSON::toString(library);library["favorites"].getArray()->add(track);library["history"].getArray()->add(track);
    auto playlist=juce::JSON::parse(R"({"id":"erase-audio-fixture","name":"Delete fixture","tracks":[]})");playlist["tracks"].getArray()->add(track);library["playlists"].getArray()->add(playlist);engine.libraryStore.commitLibrary(baseline,juce::JSON::toString(library));
    const auto beforeDelete=engine.libraryStore.readLibrary();auto removedOnly=juce::JSON::parse(beforeDelete);for(auto& item:*removedOnly["playlists"].getArray())if(item["id"].toString()=="erase-audio-fixture")item.getDynamicObject()->setProperty("tracks",juce::Array<juce::var>{});engine.libraryStore.commitLibrary(beforeDelete,juce::JSON::toString(removedOnly));
    check(file.existsAsFile(),"Removing a playlist entry deleted retained audio");const auto result=engine.eraseLocalAudio(id);check((bool)result["erased"]&&!file.existsAsFile()&&!engine.libraryStore.media(id).isObject()&&engine.cachedTrack(id).isVoid(),"Remove from library did not erase the managed recording and registry entry");
    const auto cache=engine.libraryStore.mediaDirectory().getChildFile("Waveforms/sampler-"+id+".json");check(!cache.existsAsFile(),"Permanent audio removal retained its sampler waveform cache");
    auto stale=juce::JSON::parse(beforeDelete);auto resurrect=juce::JSON::parse(R"({"id":"stale-delete-fixture","name":"Stale edit","tracks":[]})");resurrect["tracks"].getArray()->add(track);stale["playlists"].getArray()->add(resurrect);engine.libraryStore.commitLibrary(beforeDelete,juce::JSON::toString(stale));
    const auto committed=juce::JSON::parse(engine.libraryStore.readLibrary());for(const auto& item:*committed["playlists"].getArray())for(const auto& song:*item["tracks"].getArray())check(song["id"].toString()!=id,"A stale library edit resurrected a permanently deleted track");
    const auto recovered=engine.recording(juce::JSON::parse(R"({"cmd":"recover"})"));for(const auto& entry:*recovered.getArray())check(entry["path"].toString()!=file.getFullPathName(),"Recording recovery resurrected a deleted take");
    bool rejected=false;try{engine.prepareLocalAudioExport(id);}catch(const std::exception&){rejected=true;}check(rejected,"A permanently deleted take could still be exported");
    const auto original=juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a");const auto imported=engine.importLocalFile(original);const auto importedPath=imported["path"].toString();const auto protectedResult=engine.libraryStore.eraseLocalMedia(imported["id"].toString(),juce::StringArray{importedPath});
    check((bool)protectedResult["retainedForAnotherUse"]&&juce::File(importedPath).existsAsFile()&&original.existsAsFile(),"Permanent library removal erased another pad/track's audio or the external original");juce::File(importedPath).deleteFile();
    std::cout<<"PASS: permanent managed recording/import deletion, waveform/registry cleanup, playlist-only preservation, stale-edit/recovery tombstones and independent original/other-use protection\n";
}

static void midiVelocityTests(){
    {
        CueProcessor processor;processor.prepareToPlay(48000,512);processor.installSampleForTest(sample());block(processor,512);
        processor.submit({CueProcessor::Action::seek,0,0,.25});block(processor,512);processor.submit({CueProcessor::Action::pad,0,0,0,true});block(processor,512);
        juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;
        const auto hit=[&](bool enabled){processor.midiVelocityEnabled.store(enabled);processor.submit({CueProcessor::Action::pause});renderChecked(processor,audio,midi);
            midi.addEvent(juce::MidiMessage::noteOn(1,48,(juce::uint8)32),37);renderChecked(processor,audio,midi);
            check(audio.getMagnitude(0,0,37)==0,"Velocity option lost the MIDI sample offset");return audio.getSample(0,511);};
        check(std::abs(hit(true)-.4f*32/127)<1e-6f,"Enabled MIDI velocity did not scale cue audio");
        check(std::abs(hit(false)-.4f)<1e-6f,"Disabled MIDI velocity did not play cue audio at full level");
        const auto before=processor.padStates[0].load()>>1;
        midi.addEvent(juce::MidiMessage::noteOn(1,48,(juce::uint8)0),0);renderChecked(processor,audio,midi);
        check((processor.padStates[0].load()>>1)==before&&(processor.padStates[0].load()&1u)==0,"Velocity-zero Note On became a trigger with velocity disabled");
        juce::MemoryBlock saved;processor.getStateInformation(saved);CueProcessor recalled;recalled.prepareToPlay(48000,512);recalled.setStateInformation(saved.getData(),(int)saved.getSize());
        check(!recalled.midiVelocityEnabled.load()&&juce::JSON::parse(recalled.sessionUiState())["musike:midi:velocity"].toString()=="off","State recall did not restore MIDI velocity in engine/UI state");
        auto legacy=juce::AudioProcessor::getXmlFromBinary(saved.getData(),(int)saved.getSize());legacy->removeAttribute("midiVelocity");juce::MemoryBlock old;juce::AudioProcessor::copyXmlToBinary(*legacy,old);recalled.setStateInformation(old.getData(),(int)old.getSize());
        check(recalled.midiVelocityEnabled.load(),"Legacy state did not retain enabled MIDI velocity by default");
        CueProcessor drums;drums.prepareToPlay(48000,512);drums.importPadSample(0,0,juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a"));
        const auto drumHit=[&](bool enabled){midi.addEvent(juce::MidiMessage::allSoundOff(1),0);renderChecked(drums,audio,midi);drums.midiVelocityEnabled.store(enabled);
            midi.addEvent(juce::MidiMessage::noteOn(1,48,(juce::uint8)32),37);renderChecked(drums,audio,midi);check(audio.getMagnitude(0,0,37)==0,"Sample velocity option lost its MIDI offset");return audio.getMagnitude(0,512);};
        const float quiet=drumHit(true),full=drumHit(false);
        check(full>.001f&&std::abs(quiet/full-32.0f/127)<1e-5f,"Velocity option did not scale imported one-shot samples consistently");
    }
    {
        LibraryStore store;const auto previous=store.readPreferences("standalone");
        struct Restore{LibraryStore& store;juce::String saved;~Restore(){store.writePreferences(saved,"standalone");}}restore{store,previous};
        store.writePreferences("{\"musike:midi:velocity\":\"off\"}","standalone");
        juce::AudioProcessor::setTypeOfNextNewPlugin(juce::AudioProcessor::wrapperType_Standalone);
        CueProcessor cold;juce::AudioProcessor::setTypeOfNextNewPlugin(juce::AudioProcessor::wrapperType_Undefined);
        check(!cold.midiVelocityEnabled.load(),"Standalone restart required a WebView to restore velocity preference");
    }
    std::cout<<"PASS: MIDI velocity on/off for cue/sample audio, retained sample offsets and zero-velocity release, compatible state/UI recall and native cold preference restore; no callback allocation\n";
}

static void trackPlaybackTests(){
    CueProcessor processor;processor.prepareToPlay(48000,128);processor.songPlaybackEnabled.store(true);
    const auto fixture=juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a");juce::Array<juce::var> tracks;
    for(int i=0;i<3;++i)tracks.add(processor.importLocalFile(fixture));
    auto* settings=new juce::DynamicObject;settings->setProperty(juce::Identifier(tracks[0]["id"].toString()),juce::JSON::parse("{\"speed\":30,\"speedMode\":\"pitch\",\"tuning\":5}"));
    settings->setProperty(juce::Identifier(tracks[2]["id"].toString()),juce::JSON::parse("{\"speed\":-50,\"speedMode\":\"speed\",\"tuning\":-7}"));
    auto* ui=new juce::DynamicObject;ui->setProperty("musike:track-playback",juce::JSON::toString(juce::var(settings)));processor.setWebState(juce::JSON::toString(juce::var(ui)));
    const auto queue=[&](int index){auto* value=new juce::DynamicObject;value->setProperty("tracks",tracks);value->setProperty("index",index);value->setProperty("repeat","one");processor.setNativeQueue(juce::var(value));};
    const auto wait=[&](int index){for(int i=0;i<1500;++i){block(processor,128);if(processor.ready.load()&&!processor.nativeAdvancing.load()&&processor.nativeSnapshot()["trackId"].toString()==tracks[index]["id"].toString())return true;juce::Thread::sleep(2);}return false;};
    const auto verify=[&](double speed,const juce::String& mode,double tuning){const auto snapshot=processor.nativeSnapshot();const auto value=snapshot["playback"];
        if(!(std::abs((double)value["speed"]-speed)<.01&&value["speedMode"].toString()==mode&&std::abs((double)value["tuning"]-tuning)<.01))throw std::runtime_error("Per-song native controls expected "+juce::String(speed).toStdString()+"/"+mode.toStdString()+"/"+juce::String(tuning).toStdString()+" got "+juce::JSON::toString(snapshot,true).toStdString());};
    queue(0);processor.loadRemote("beatmaker-local://"+tracks[0]["id"].toString(),0,tracks[0]["id"].toString());check(wait(0),"Per-song audio fixture did not load");verify(30,"pitch",5);
    check(processor.setTrackPlayback(tracks[0]["id"].toString(),juce::JSON::parse("{\"speed\":25,\"speedMode\":\"pitch\",\"tuning\":3}")),"Current song playback setting was rejected");verify(25,"pitch",3);
    processor.backgroundPlayback.store(true);
    check(processor.performRemoteAction(CueProcessor::RemoteAction::next)&&wait(1),"Background next did not select the second song");verify(0,"speed",0);
    check(!processor.setTrackPlayback(tracks[0]["id"].toString(),juce::JSON::parse("{\"speed\":99}")),"A delayed old-song rate command changed the new song");verify(0,"speed",0);
    check(processor.performRemoteAction(CueProcessor::RemoteAction::next)&&wait(2),"Background next did not select the third song");verify(-50,"speed",-7);
    check(processor.performRemoteAction(CueProcessor::RemoteAction::previous)&&wait(1),"Background previous did not return to the second song");verify(0,"speed",0);
    check(processor.performRemoteAction(CueProcessor::RemoteAction::previous)&&wait(0),"Background previous did not return to the first song");verify(25,"pitch",3);
    processor.backgroundPlayback.store(false);
    processor.loadRemote("beatmaker-local://"+tracks[2]["id"].toString(),0,tracks[2]["id"].toString(),true);verify(25,"pitch",3);
    const auto saved=processor.sessionUiState();const auto map=juce::JSON::parse(juce::JSON::parse(saved)["musike:track-playback"].toString());
    check((double)map[juce::Identifier(tracks[0]["id"].toString())]["speed"]==25&&(double)map[juce::Identifier(tracks[2]["id"].toString())]["tuning"]==-7,"Per-song playback settings were not retained in native session state");
    CueProcessor cold;cold.prepareToPlay(48000,128);cold.songPlaybackEnabled.store(true);cold.setWebState(saved);
    auto* coldQueue=new juce::DynamicObject;coldQueue->setProperty("tracks",tracks);coldQueue->setProperty("index",2);cold.setNativeQueue(juce::var(coldQueue));cold.loadRemote("beatmaker-local://"+tracks[2]["id"].toString(),0,tracks[2]["id"].toString());
    for(int i=0;i<1000&&!cold.ready.load();++i){block(cold,128);juce::Thread::sleep(2);}
    check(cold.ready.load()&&(double)cold.nativeSnapshot()["playback"]["speed"]==-50&&cold.semitones.load()==-7,"Cold native restore lost a song's playback controls");
    std::cout<<"PASS: per-song native playback settings, neutral unseen songs, screen-off next/previous, stale-rate rejection, no prefetch side effects and cold session restore; no callback allocation\n";
}

static void nativePadInputTests(){
    CueProcessor processor;processor.prepareToPlay(48000,128);processor.installSampleForTest(sample());block(processor,128);
    processor.submit({CueProcessor::Action::seek,0,0,2.25});block(processor,128);
    PadInputRouter router(processor);router.setSource(7,"input-fixture");
    auto map=juce::JSON::parse(R"({"sourceId":7,"bank":0,"width":400,"height":800,"dpr":2,"enabled":true,"pads":[{"pad":0,"to":0.125,"sample":false,"x":0.1,"y":0.2,"w":0.5,"h":0.3}],"blocked":[{"x":0.1,"y":0.2,"w":0.05,"h":0.05}]})");
    const auto configure=[&]{auto* object=map.getDynamicObject();const auto state=router.state(true);object->setProperty("generation",state["audioGeneration"]);object->setProperty("trackRevision",state["trackRevision"]);object->setProperty("layoutRevision",state["layoutRevision"]);router.configure(map);};
    configure();const double epoch=juce::Time::currentTimeMillis();
    auto request=juce::JSON::parse(R"({"sourceId":7,"bank":0,"pad":0,"to":0.125,"sample":false})");
    request.getDynamicObject()->setProperty("eventEpochMs",epoch);request.getDynamicObject()->setProperty("generation",processor.audioGeneration());request.getDynamicObject()->setProperty("trackRevision",processor.nativeTrackRevision.load());
    check(!router.pointerDown(45,170,400,800,false,epoch,1),"Native input ignored a blocked delete control");
    check(!router.pointerDown(150,250,800,400,false,epoch,1),"Native input accepted stale viewport geometry");
    check(!router.pointerDown(NAN,250,400,800,false,epoch,1),"Native input accepted non-finite coordinates");
    const auto before=processor.padStates[0].load()>>1;
    check(router.pointerDown(150,250,400,800,false,epoch,1),"Native input did not accept a prepared cue");
    check(processor.nativePadInputAccepted.load()==1&&(processor.padStates[0].load()>>1)==before,"Native input bypassed the audio command consumer");
    block(processor,128);
    check((processor.padStates[0].load()>>1)==before+1&&processor.nativePadInputRendered.load()==1&&processor.playhead.load()>.125&&processor.playhead.load()<.13,"Native input did not render exactly one cue");
    const auto receipt=router.claim(request);
    check((bool)receipt["accepted"]&&!(bool)receipt["stale"]&&(double)receipt["position"]==2.25,"Native receipt lost its original pre-jump playhead");
    check(!(bool)router.claim(request)["accepted"],"Native receipt could be claimed twice");
    check(router.pointerDown(300,500,800,1600,true,epoch+100,1),"Native Windows physical-pixel/DPR conversion failed");
    request.getDynamicObject()->setProperty("eventEpochMs",epoch+300);
    check(!(bool)router.claim(request)["accepted"],"Native receipt matched a different physical event");
    request.getDynamicObject()->setProperty("eventEpochMs",epoch+100);
    check((bool)router.claim(request)["accepted"],"Mismatched claim consumed the valid receipt");
    check(router.pointerDown(150,250,400,800,false,epoch+200,1),"Native changed-cue fixture did not queue");
    request.getDynamicObject()->setProperty("eventEpochMs",epoch+200);request.getDynamicObject()->setProperty("to",.25);
    const auto changed=router.claim(request);check((bool)changed["accepted"]&&(bool)changed["stale"],"Changed cue target would replay an already accepted physical event");request.getDynamicObject()->setProperty("to",.125);
    check(router.pointerDown(150,250,400,800,false,epoch+500,1)&&router.pointerDown(150,250,400,800,false,epoch+550,1),"Rapid touch receipt fixture did not queue both genuine taps");
    request.getDynamicObject()->setProperty("orderedTouch",true);request.getDynamicObject()->setProperty("eventEpochMs",epoch-8000);
    check((bool)router.claim(request)["accepted"]&&(bool)router.claim(request)["accepted"]&&!(bool)router.claim(request)["accepted"],"Secondary-finger clock mismatch duplicated/dropped an ordered touch or merged genuine rapid taps");
    request.getDynamicObject()->setProperty("orderedTouch",false);
    block(processor,128);router.invalidateLayout();router.configure(map);
    check(!router.pointerDown(150,250,400,800,false,epoch,1),"Native input accepted a pre-resize layout revision");
    configure();processor.backgroundPlayback.store(true);
    check(!router.pointerDown(150,250,400,800,false,epoch,1),"Native input triggered during background playback");processor.backgroundPlayback.store(false);
    processor.nativeTrackRevision.fetch_add(1);
    check(!router.pointerDown(150,250,400,800,false,epoch,1),"Native input accepted a stale track revision");configure();
    const auto oldHits=processor.padStates[0].load()>>1;
    check(router.pointerDown(150,250,400,800,false,epoch+400,1),"Native stale-generation fixture did not queue");
    processor.installSampleForTest(sample());block(processor,128);
    check((processor.padStates[0].load()>>1)==oldHits,"Queued native cue triggered a replacement source");
    request.getDynamicObject()->setProperty("eventEpochMs",epoch+400);
    const auto stale=router.claim(request);check((bool)stale["accepted"]&&(bool)stale["stale"],"Stale accepted event would fall back to a second UI trigger");
    configure();router.setSource(8,"replacement");
    check(!router.pointerDown(150,250,400,800,false,epoch,1),"Changing source did not invalidate native regions");
    CueProcessor samples;samples.prepareToPlay(48000,128);samples.importPadSample(0,0,juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a"));samples.overwrite.store(true);
    PadInputRouter sampleRouter(samples);auto* object=map.getDynamicObject();object->setProperty("sourceId",0);object->setProperty("layoutRevision",0);object->setProperty("generation",-1);
    (*map["pads"].getArray())[0].getDynamicObject()->setProperty("sample",true);sampleRouter.configure(map);
    check(sampleRouter.pointerDown(150,250,400,800,false,epoch,1),"Native sample input required a loaded song");
    juce::AudioBuffer<float> audio(2,128);juce::MidiBuffer midi;renderChecked(samples,audio,midi);
    check(audio.getMagnitude(0,128)>.0001f&&!samples.playing.load()&&samples.getCue(0,0)<0,"Native sample input marked/jumped transport or failed to render");
    samples.removePadSample(0,0);
    check(!sampleRouter.pointerDown(150,250,400,800,false,epoch,1),"Removed sample fell through to a native cue");
    std::cout<<"PASS: native cue/sample input, one-time event receipts, pre-jump position, stale source/generation/layout, blocked controls, DPR, background and sample-only playback; no callback allocation\n";
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

static void songTransitionTests(){
    const auto folder=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("SongFadeFixture",{});folder.createDirectory();struct Cleanup{juce::File folder;~Cleanup(){folder.deleteRecursively();}}cleanup{folder};
    for(int track=0;track<2;++track){const auto file=folder.getChildFile(juce::String(track)+".wav");juce::WavAudioFormat wav;std::unique_ptr<juce::AudioFormatWriter> writer(wav.createWriterFor(file.createOutputStream().release(),48000,2,24,{},0));juce::AudioBuffer<float> pcm(2,48000*3);for(int c=0;c<2;++c)for(int i=0;i<pcm.getNumSamples();++i)pcm.setSample(c,i,track?.5f:.25f);check(writer&&writer->writeFromAudioSampleBuffer(pcm,0,pcm.getNumSamples()),"Cannot write song fade fixture");}
    for(const int rate:{44100,48000,96000}){
        CueProcessor processor;processor.openEditors.store(1);processor.prepareToPlay(rate,256);check((bool)processor.transitions()["enabled"]&&std::abs((double)processor.transitions()["seconds"]-.35)<1e-9,"Song fades must default On at 350 ms");processor.setTransitions(juce::JSON::parse(R"({"enabled":true,"seconds":0.12})"));
        juce::Array<juce::var> tracks;for(int i=0;i<2;++i)tracks.add(processor.importLocalFile(folder.getChildFile(juce::String(i)+".wav")));
        auto* queue=new juce::DynamicObject;queue->setProperty("tracks",tracks);queue->setProperty("index",0);queue->setProperty("repeat","off");processor.setNativeQueue(juce::var(queue));processor.loadRemote("beatmaker-local://"+tracks[0]["id"].toString(),0,tracks[0]["id"].toString());juce::AudioBuffer<float> audio(2,256);juce::MidiBuffer midi;
        const auto waitReady=[&](int index){for(int i=0;i<2000;++i){renderChecked(processor,audio,midi);if(processor.ready.load()&&!processor.nativeAdvancing.load()&&(int)processor.nativeSnapshot()["queueIndex"]==index)return true;juce::Thread::sleep(1);}return false;};
        check(waitReady(0),"Fade fixture failed to load");processor.submit({CueProcessor::Action::play});for(int i=0;i<10;++i)renderChecked(processor,audio,midi);check(std::abs(audio.getSample(0,255)-.2f)<.0001f,"Fade fixture did not reach dry unity");
        check(processor.navigateTo(1),"Foreground native navigation was rejected");bool faded=false,quiet=false;
        for(int i=0;i<2000&&(int)processor.nativeSnapshot()["queueIndex"]==0;++i){renderChecked(processor,audio,midi);const float last=audio.getSample(0,255);if(last>.005f&&last<.18f)faded=true;if(faded&&last<.001f)quiet=true;juce::Thread::sleep(1);}
        check(faded&&quiet,"Next cut the outgoing song before its fade reached silence");check(waitReady(1),"Faded Next never loaded its destination");check(audio.getMagnitude(0,256)<.05f,"Incoming song skipped fade-in");
        for(int i=0;i<(int)std::ceil(rate*.15/256);++i)renderChecked(processor,audio,midi);check(std::abs(audio.getSample(0,255)-.4f)<.0001f,"Fade-in did not reach full song gain");
        processor.setTransitions(juce::JSON::parse(R"({"enabled":false,"seconds":0.12})"));check(processor.navigateTo(0)&&waitReady(0),"Instant navigation failed with fades Off");for(int i=0;i<2;++i)renderChecked(processor,audio,midi);if(std::abs(audio.getSample(0,255)-.2f)>=.0001f)std::cerr<<"Instant fade rate "<<rate<<" sample "<<audio.getSample(0,255)<<" settings "<<juce::JSON::toString(processor.transitions(),true)<<" snapshot "<<juce::JSON::toString(processor.nativeSnapshot(),true)<<"\n";check(std::abs(audio.getSample(0,255)-.2f)<.0001f,"Turning fades Off left a reduced song level");
        processor.setTransitions(juce::JSON::parse(R"({"enabled":true,"seconds":0.12})"));check(processor.navigateTo(1),"Cue-cancellation fade did not start");bool duringFade=false;for(int i=0;i<500;++i){renderChecked(processor,audio,midi);if(audio.getSample(0,255)<.17f){duringFade=true;break;}juce::Thread::sleep(1);}check(duringFade,"No outgoing fade was available for cue interruption");
        processor.submit({CueProcessor::Action::cue,0,0,.2});renderChecked(processor,audio,midi);check(std::abs(audio.getSample(0,255)-.2f)<.0001f,"A cue inherited the slow song fade");for(int i=0;i<100;++i){renderChecked(processor,audio,midi);juce::Thread::sleep(1);}check((int)processor.nativeSnapshot()["queueIndex"]==0,"A cancelled song transition later overrode the cue");
        processor.setTransitions(juce::JSON::parse(R"({"enabled":false,"seconds":0.2})"));juce::MemoryBlock state;processor.getStateInformation(state);CueProcessor restored;restored.prepareToPlay(rate,256);restored.setStateInformation(state.getData(),(int)state.getSize());check(!(bool)restored.transitions()["enabled"]&&std::abs((double)restored.transitions()["seconds"]-.2)<1e-9,"Song fade choice/duration did not survive host state");
    }
    std::cout<<"PASS: native Next fade-out reaches silence then fade-in, 44.1/48/96 kHz, default On, Instant Off, saved host settings and immediate cue cancellation; no callback allocation\n";
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

static void selectedBankCacheTests(){
    auto source=std::make_unique<CueProcessor::Sample>();source->rate=48000;source->path="bank-cache-fixture:";
    source->paged=std::make_unique<PagedAudio>(std::make_unique<LongToneReader>(),0);
    CueProcessor processor;processor.prepareToPlay(48000,512);processor.installSampleForTest(std::move(source));
    juce::AudioBuffer<float> output(2,512);juce::MidiBuffer midi;renderChecked(processor,output,midi);
    auto banks=std::make_unique<juce::DynamicObject>();
    for(int bank=0;bank<10;++bank){
        auto pads=std::make_unique<juce::DynamicObject>();
        for(int pad=0;pad<16;++pad)pads->setProperty(juce::Identifier(juce::String(pad+1)),2+(bank*16+pad)*3.8);
        banks->setProperty(juce::Identifier(juce::String::charToString((juce::juce_wchar)('A'+bank))),juce::var(pads.release()));
    }
    auto state=std::make_unique<juce::DynamicObject>();state->setProperty("cues",juce::var(banks.release()));
    const auto mapping=juce::var(state.release());
    for(const int bank:{9,4,0}){
        mapping.getDynamicObject()->setProperty("bank",juce::String::charToString((juce::juce_wchar)('A'+bank)));
        processor.syncWebCues(mapping);
        for(int poll=0;poll<1000;++poll){
            juce::Thread::sleep(5);
            if((int)processor.loadDiagnostics()["readyCueHeads"]==16)break;
        }
        if((int)processor.loadDiagnostics()["readyCueHeads"]!=16){std::cerr<<"Cache bank "<<bank<<" selected "<<processor.selectedBank.load()<<" diagnostics "<<juce::JSON::toString(processor.loadDiagnostics(),true)<<"\n";check(false,"Selected bank was not fully warmed");}
        for(const int pad:{0,8,1,9,2,10,3,11,4,12,5,13,6,14,7,15}){
            const double target=2+(bank*16+pad)*3.8;const int misses=processor.loadDiagnostics()["cacheMisses"];
            processor.submit({CueProcessor::Action::pad,bank,pad});renderChecked(processor,output,midi);
            check(processor.playhead.load()>target+.001&&(int)processor.loadDiagnostics()["cacheMisses"]==misses,"Selected bank attack was evicted in favor of an earlier bank");
            const auto lastFrame=(juce::int64)std::llround(processor.playhead.load()*48000)-1;
            check(std::abs(output.getSample(0,511)-.8f*LongToneReader::tone(lastFrame,0))<.0001f,"Bank-priority prefetch changed the source PCM");
        }
    }
    check((juce::int64)processor.loadDiagnostics()["pcmCacheBytes"]==16*1024*1024,"Selected-bank prefetch grew the PCM cache");
    std::cout<<"PASS: all 160 cues set, J/E/A selected-bank attacks resident after prefetch, exact PCM and fixed 16 MiB cache; no callback decode/allocation\n";
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
        for(int channel=1;channel<=16;++channel)for(int bank=0;bank<10;++bank)for(int pad=0;pad<16;++pad){
            const auto linear=CueProcessor::mapNote(3,channel,36+pad,bank);
            check(linear.bank==bank&&linear.pad==pad,"Linear 16 mapping must use ascending notes and current bank on every channel");
        }
        check(CueProcessor::mapNote(3,1,52,0).pad==-1,"Linear 16 accepted an out-of-range note");
        {
            juce::AudioProcessor::setTypeOfNextNewPlugin(juce::AudioProcessor::wrapperType_VST3);CueProcessor hosted;
            juce::AudioProcessor::setTypeOfNextNewPlugin(juce::AudioProcessor::wrapperType_Undefined);
            check(hosted.preset.load()==3&&hosted.padCount()==16,"Fresh hosted plug-in must default to linear 16 pads");
            check(juce::JSON::parse(hosted.sessionUiState())["musike:midi:preset"].toString()=="linear16","Hosted UI default does not match native preset");
            hosted.prepareToPlay(48000,128);hosted.installSampleForTest(sample());block(hosted,128);hosted.selectedBank.store(4);
            juce::AudioBuffer<float> audio(2,128);juce::MidiBuffer midi;midi.addEvent(juce::MidiMessage::noteOn(16,36,(juce::uint8)110),17);renderChecked(hosted,audio,midi);
            check(hosted.getCue(4,0)>=0&&hosted.getCue(9,0)<0,"Linear 16 MIDI changed the selected bank");
            juce::MemoryBlock saved;hosted.getStateInformation(saved);CueProcessor recalled;recalled.setStateInformation(saved.getData(),(int)saved.getSize());
            check(recalled.preset.load()==3&&recalled.selectedBank.load()==4,"Linear 16 preset/bank did not survive host recall");
        }
        std::cout << "PASS: 320 Roland mappings, linear 16 on all channels/current banks, fresh hosted default, saved preset/bank and legacy isolation\n";

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
        sampleStartEditingTests();
        mediaEditingTests();
        recordingTests();
       #if BEATMAKER_PERFORMANCE_FEATURES && !BEATMAKER_DESKTOP_BETA
        hostedInputTests();
       #endif
        emptyTrackTests();
        recordingMidiGuardTests();
        mixerTests();
        padLooperTests();
        permanentLocalEraseTests();
        midiVelocityTests();
        trackPlaybackTests();
        nativePadInputTests();
        rateTransitionTests();
        fxGraphRoutingTests();
        remoteTransportTests();
        songTransitionTests();
        selectedBankCacheTests();
        longTrackTests();
        return 0;
    } catch (const std::exception& error) { std::cerr << "FAIL: " << error.what() << "\n"; return 1; }
}
