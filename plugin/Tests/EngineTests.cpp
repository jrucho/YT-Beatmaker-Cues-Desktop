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
        return 0;
    } catch (const std::exception& error) { std::cerr << "FAIL: " << error.what() << "\n"; return 1; }
}
