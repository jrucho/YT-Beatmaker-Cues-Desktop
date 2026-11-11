// Real simulator standalone device callbacks/session routing, not acoustic or
// physical USB verification. Runs in an isolated private library.
#include "Processor.h"
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_audio_plugin_client/Standalone/juce_StandaloneFilterWindow.h>
#include <iostream>
#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>

namespace {
class Fixture final:public juce::JUCEApplication,private juce::Timer {
public:
    const juce::String getApplicationName() override{return "Beatmaker Recording Tests";}
    const juce::String getApplicationVersion() override{return JucePlugin_VersionString;}
    void initialise(const juce::String& arguments) override {
        speakerOnly=arguments.contains("--speaker-only")&&!arguments.contains("--full");
        const auto root=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("RecordingFixture",{});root.createDirectory();
        setenv("BEATMAKER_PLUGIN_DATA_DIR",root.getFullPathName().toRawUTF8(),1);setenv("BEATMAKER_SHARED_LIBRARY_DIR","",1);
        window=std::make_unique<juce::DocumentWindow>(getApplicationName(),juce::Colours::black,0);window->setFullScreen(true);window->setVisible(true);startTimer(1000);
    }
    void shutdown() override{holder.reset();window.reset();}
private:
    void pump(int ms){const auto end=juce::Time::getMillisecondCounterHiRes()+ms;while(juce::Time::getMillisecondCounterHiRes()<end)CFRunLoopRunInMode(kCFRunLoopDefaultMode,.01,true);}
    void check(bool value,const char* message){if(!value){passed=false;std::cerr<<"FAIL: "<<message<<"\n";}}
    juce::var configure(CueProcessor& engine,const char* json){juce::var result;bool done=false;engine.configureAudio(juce::JSON::parse(json),[&](juce::var value){result=value;done=true;});for(int i=0;i<1000&&!done;++i)pump(10);check(done,"Native audio configuration did not complete");if(result.hasProperty("__error"))std::cerr<<juce::JSON::toString(result)<<"\n";return result;}
    void timerCallback() override {
        if(!holder){holder=std::make_unique<juce::StandalonePluginHolder>(nullptr,false);return;}
        stopTimer();auto& engine=*dynamic_cast<CueProcessor*>(holder->processor.get());
        const auto initial=engine.audioRoutes();check((bool)initial["supported"]&&!(bool)initial["monitor"],"Standalone route service is unavailable or monitoring did not default off");
        const auto speakerRoute=configure(engine,R"({"inputEnabled":false,"output":"speaker","monitor":false})");pump(150);
        check(!speakerRoute.hasProperty("__error")&&engine.inputChannels.load()==0&&!(bool)engine.audioRoutes()["inputEnabled"],"Speaker selection incorrectly required/enabled microphone capture");
        check(engine.audioRoutes()["actualOutput"].toString()=="iPhone speaker", "Output-only speaker selection was not accepted by the simulator");
        if(!speakerOnly){const auto unsupported=configure(engine,R"({"inputEnabled":true,"input":"usb","output":"speaker","monitor":false})");check(unsupported.hasProperty("__error"),"Unavailable USB input with speaker output silently selected the phone microphone");}
        const auto usb=configure(engine,R"({"inputEnabled":false,"output":"usb","monitor":false})");pump(150);
        check(usb.hasProperty("__error")&&engine.audioRoutes()["output"].toString()=="speaker"&&engine.audioRoutes()["actualOutput"].toString()=="iPhone speaker"&&(bool)engine.audioRoutes()["outputAccepted"],"Unavailable USB output was falsely accepted or did not restore the previous speaker route");
        engine.loadDemo();for(int i=0;i<500&&!engine.ready.load();++i)pump(10);engine.submit({CueProcessor::Action::play});pump(100);
        check(engine.audioRoutes()["actualOutput"].toString()=="iPhone speaker"&&[[AVAudioSession sharedInstance].category isEqualToString:AVAudioSessionCategoryPlayAndRecord],"Now Playing activation reset the output-only speaker route");
        engine.recording(juce::JSON::parse(R"({"cmd":"start","source":"playback"})"));pump(350);
        check((double)engine.recorder.state()["seconds"]>.1,"Actual standalone output callbacks did not feed the recorder");
        const auto captured=engine.recording(juce::JSON::parse(R"({"cmd":"stop"})"));juce::AudioFormatManager formats;formats.registerBasicFormats();
        auto reader=std::unique_ptr<juce::AudioFormatReader>(formats.createReaderFor(juce::File(captured["track"]["path"].toString())));
        check(reader&&reader->lengthInSamples>1000,"Standalone playback take was not finalized/registered");
        if(reader){juce::AudioBuffer<float> pcm(2,(int)juce::jmin((juce::int64)48000,reader->lengthInSamples));reader->read(&pcm,0,pcm.getNumSamples(),0,true,true);check(pcm.getMagnitude(0,pcm.getNumSamples())>.001f,"Recorded standalone playback was silent");}
        if(speakerOnly){check(engine.audioRoutes()["permission"].toString()==initial["permission"].toString(),"Speaker-only routing changed microphone permission state");std::cout<<(passed?"PASS":"FAIL")<<": speaker-only output and native playback recording with microphone permission "<<initial["permission"].toString()<<", no enabled input\n"<<std::flush;std::exit(passed?0:1);}
        const auto input=configure(engine,R"({"inputEnabled":true,"input":"microphone","output":"automatic","monitor":false})");pump(250);
        check(!input.hasProperty("__error")&&engine.inputChannels.load()>0,"Simulator microphone input did not enable on the existing audio device");
        for(AVAudioSessionPortDescription* port in [AVAudioSession sharedInstance].currentRoute.inputs)if([port.portType isEqualToString:AVAudioSessionPortBuiltInMic]){
            bool bottom=false;for(AVAudioSessionDataSourceDescription* source in port.dataSources)if([source.orientation isEqualToString:AVAudioSessionOrientationBottom])bottom=true;
            if(bottom)check([port.preferredDataSource.orientation isEqualToString:AVAudioSessionOrientationBottom],"Bottom built-in microphone was exposed but not preferred");
            if(port.selectedDataSource)check(engine.audioRoutes()["microphoneDataSource"].toString()==juce::String(port.selectedDataSource.dataSourceName.UTF8String),"Route status did not expose the actual selected microphone data source");
        }
        if(engine.inputChannels.load()>0){
            engine.recording(juce::JSON::parse(R"({"cmd":"start","source":"input"})"));pump(150);
            check((double)engine.recorder.state()["seconds"]>0,"Actual input callback did not feed the recording FIFO");
            const auto midiHits=engine.padStates[0].load()>>1;const double captureBefore=(double)engine.recorder.state()["seconds"];
            const auto sendMidi=[&](juce::MidiMessage message){message.setTimeStamp(juce::Time::getMillisecondCounterHiRes()*.001);holder->player.handleIncomingMidiMessage(nullptr,message);};
            engine.recordingMidiGuards.store(1);sendMidi(juce::MidiMessage::noteOn(1,48,(juce::uint8)127));pump(120);
            check((engine.padStates[0].load()>>1)==midiHits&&(double)engine.recorder.state()["seconds"]>captureBefore&&(bool)engine.recorder.state()["recording"],"MIDI suspension triggered a pad or stopped actual microphone capture");
            sendMidi(juce::MidiMessage::noteOff(1,48));pump(50);
            engine.recordingMidiGuards.store(0);sendMidi(juce::MidiMessage::noteOn(1,48,(juce::uint8)127));pump(120);
            check((engine.padStates[0].load()>>1)==midiHits+1&&(bool)engine.recorder.state()["recording"],"MIDI restoration did not resume native pad input during an ongoing take");
            const auto monitored=configure(engine,R"({"monitor":true,"monitorLevel":0.2})");pump(50);
            check(!monitored.hasProperty("__error")&&(bool)engine.recorder.state()["recording"]&&engine.monitorInput.load(),"Changing monitor level restarted/interrupted the recording device");
            const auto blocked=configure(engine,R"({"output":"speaker"})");check(blocked.hasProperty("__error"),"Route changes were accepted during an unfinished take");
            const auto take=engine.recording(juce::JSON::parse(R"({"cmd":"stop"})"));check(take["track"].isObject(),"Input take did not become retained local audio");
            [[NSNotificationCenter defaultCenter] postNotificationName:AVAudioSessionRouteChangeNotification object:[AVAudioSession sharedInstance] userInfo:@{AVAudioSessionRouteChangeReasonKey:@(AVAudioSessionRouteChangeReasonOldDeviceUnavailable)}];
            const auto muted=engine.audioRoutes();check(!(bool)muted["monitor"]&&(bool)muted["monitorRequested"]&&(bool)muted["monitorSuspended"],"Route departure did not immediately mute monitoring while retaining its requested state");
            pump(450);check(engine.monitorInput.load(),"Monitoring did not resume after the same accepted route settled");
            configure(engine,R"({"monitor":false})");
            [[NSNotificationCenter defaultCenter] postNotificationName:AVAudioSessionRouteChangeNotification object:[AVAudioSession sharedInstance] userInfo:@{AVAudioSessionRouteChangeReasonKey:@(AVAudioSessionRouteChangeReasonNewDeviceAvailable)}];
            pump(450);check(!engine.monitorInput.load()&&!(bool)engine.audioRoutes()["monitorRequested"],"Manual monitoring Off was overridden by a new device notification");
        }
        const auto speaker=configure(engine,R"({"inputEnabled":true,"output":"speaker","monitor":false})");pump(100);
        check(!speaker.hasProperty("__error")&&engine.audioRoutes()["actualOutput"].toString().isNotEmpty(),"Speaker preference did not report an accepted output");
        configure(engine,R"({"inputEnabled":false,"monitor":false,"output":"automatic"})");pump(100);
        check(engine.inputChannels.load()==0&&!engine.monitorInput.load(),"Input/monitor disable did not return to output-only playback");
        std::cout<<(passed?"PASS":"FAIL")<<": simulator native recording/routes, input-off speaker selection and retention during playback, microphone data-source policy, monitor-only updates and output-only restore\n"<<std::flush;
        std::exit(passed?0:1);
    }
    std::unique_ptr<juce::StandalonePluginHolder> holder;std::unique_ptr<juce::DocumentWindow> window;bool passed=true,speakerOnly=false;
};
}
START_JUCE_APPLICATION(Fixture)
