// Actual standalone device callbacks, isolated data, no microphone permission request.
#include "Processor.h"
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_audio_plugin_client/Standalone/juce_StandaloneFilterWindow.h>
#include <iostream>

namespace {
class Fixture final:public juce::JUCEApplication,private juce::Timer {
public:
    const juce::String getApplicationName() override{return "Beatmaker Device Recording Tests";}
    const juce::String getApplicationVersion() override{return JucePlugin_VersionString;}
    void initialise(const juce::String&) override{
        root=juce::File(BEATMAKER_TEST_WORK_DIR).getNonexistentChildFile("standalone-device-fixture",{});root.createDirectory();
       #if JUCE_WINDOWS
        _putenv_s("BEATMAKER_PLUGIN_DATA_DIR",root.getFullPathName().toRawUTF8());_putenv_s("BEATMAKER_SHARED_LIBRARY_DIR","");
       #else
        setenv("BEATMAKER_PLUGIN_DATA_DIR",root.getFullPathName().toRawUTF8(),1);setenv("BEATMAKER_SHARED_LIBRARY_DIR","",1);
       #endif
        window=std::make_unique<juce::DocumentWindow>(getApplicationName(),juce::Colours::black,0);window->setBounds(40,40,360,160);window->setVisible(true);startTimer(500);
    }
    void shutdown() override{holder.reset();window.reset();root.deleteRecursively();}
private:
    void pump(int ms){const auto end=juce::Time::getMillisecondCounterHiRes()+ms;while(juce::Time::getMillisecondCounterHiRes()<end)juce::MessageManager::getInstance()->runDispatchLoopUntil(10);}
    void check(bool value,const char* message){if(!value){passed=false;std::cerr<<"FAIL: "<<message<<"\n";}}
    juce::var configure(CueProcessor& engine,const juce::var& request){bool done=false;juce::var result;engine.configureAudio(request,[&](juce::var value){result=value;done=true;});for(int i=0;i<500&&!done;++i)pump(10);check(done,"Standalone audio configuration timed out");return result;}
    void timerCallback() override{
        if(!holder){holder=std::make_unique<juce::StandalonePluginHolder>(nullptr,false);return;}
        stopTimer();auto& engine=*dynamic_cast<CueProcessor*>(holder->processor.get());pump(500);const auto initial=engine.audioRoutes();
        check((bool)initial["supported"]&&initial["platform"].toString()=="desktop"&&!(bool)initial["inputEnabled"]&&!engine.monitorInput.load()&&engine.inputChannels.load()==0,"Standalone device service did not start in output-only/monitor-Off mode");
        const auto previousOutput=initial["actualOutput"].toString();const auto rejected=configure(engine,juce::JSON::parse(R"({"output":"Beatmaker missing fixture device"})"));pump(300);
        check(rejected.hasProperty("__error")&&engine.audioRoutes()["actualOutput"].toString()==previousOutput&&engine.inputChannels.load()==0,"Unavailable output did not reject and restore the previous device");
        engine.loadDemo();for(int i=0;i<500&&!engine.ready.load();++i)pump(10);engine.submit({CueProcessor::Action::play});pump(150);
        engine.recording(juce::JSON::parse(R"({"cmd":"start","source":"playback"})"));pump(500);check((double)engine.recorder.state()["seconds"]>.2&&(bool)engine.recorder.state()["recording"],"Real standalone output callbacks did not feed the recorder");
        const auto take=engine.recording(juce::JSON::parse(R"({"cmd":"stop"})"));juce::AudioFormatManager formats;formats.registerBasicFormats();auto reader=std::unique_ptr<juce::AudioFormatReader>(formats.createReaderFor(juce::File(take["track"]["path"].toString())));
        check(reader&&reader->lengthInSamples>1000,"Standalone callback recording did not finalize a retained WAV");if(reader){juce::AudioBuffer<float> pcm(2,(int)juce::jmin((juce::int64)48000,reader->lengthInSamples));reader->read(&pcm,0,pcm.getNumSamples(),0,true,true);check(pcm.getMagnitude(0,pcm.getNumSamples())>.001f,"Recorded standalone device playback was silent");}
        check(engine.inputChannels.load()==0&&!engine.monitorInput.load()&&engine.audioRoutes()["permission"].toString()==initial["permission"].toString(),"Playback recording changed microphone/input/monitor permission state");
        std::cout<<(passed?"PASS":"FAIL")<<": real desktop standalone device callbacks, output-only startup, unavailable-output rollback and retained non-silent playback WAV without microphone capture\n"<<std::flush;setApplicationReturnValue(passed?0:1);quit();
    }
    juce::File root;std::unique_ptr<juce::StandalonePluginHolder> holder;std::unique_ptr<juce::DocumentWindow> window;bool passed=true;
};
}
START_JUCE_APPLICATION(Fixture)
