#include "Processor.h"
#include "MonitorRouteGuard.h"
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_audio_plugin_client/Standalone/juce_StandaloneFilterWindow.h>
#if JUCE_ANDROID
#include "AndroidStandalone.h"
#include "AndroidAudioOutput.h"
#endif

namespace {
juce::var fields(std::initializer_list<std::pair<juce::Identifier,juce::var>> values){auto* result=new juce::DynamicObject;for(const auto& value:values)result->setProperty(value.first,value.second);return juce::var(result);}
class DeviceAudio final:public StandaloneNowPlaying,private juce::Timer,private juce::AudioIODeviceCallback {
public:
    explicit DeviceAudio(CueProcessor& value):engine(value){
        lifetime->store(this);const auto saved=juce::JSON::parse(engine.libraryStore.readPreferences(engine.getSessionId()));preferences=juce::JSON::parse(saved["musike:audio:routes"].toString());
        if(!preferences.isObject())preferences=juce::JSON::parse(R"({"inputEnabled":false,"input":"automatic","output":"automatic","monitor":false,"monitorLevel":0.5})");
        monitor.restore((bool)preferences["monitor"],preferences["monitorRoute"]);startTimer(200);
    }
    ~DeviceAudio() override{stopTimer();lifetime->store(nullptr);engine.monitorInput.store(false);engine.recorder.interrupt();if(manager)manager->removeAudioCallback(this);}
    juce::var audioRoutes() override{
        updateMonitor();auto result=preferences.clone();auto* out=result.getDynamicObject();out->setProperty("supported",true);
       #if JUCE_ANDROID
        out->setProperty("platform","android");
       #else
        out->setProperty("platform","desktop");
       #endif
        out->setProperty("inputActive",engine.inputChannels.load()>0);out->setProperty("sampleRate",engine.inputRate.load()>0?engine.inputRate.load():engine.playbackRate.load());out->setProperty("permission",juce::RuntimePermissions::isGranted(juce::RuntimePermissions::recordAudio)?"granted":"undetermined");
        out->setProperty("inputs",ports(true));out->setProperty("outputs",ports(false));out->setProperty("driver",manager?manager->getCurrentAudioDeviceType():juce::String{});juce::Array<juce::var> drivers;if(manager)for(auto* type:manager->getAvailableDeviceTypes())drivers.add(type->getTypeName());out->setProperty("drivers",drivers);
        const auto input=actual(true),output=actual(false);out->setProperty("actualInput",engine.inputChannels.load()>0?input["name"].toString():"Off");out->setProperty("actualOutput",output["name"]);out->setProperty("activeOutput",output["kind"].toString()=="usb"?"usb":output["kind"].toString()=="speaker"?"speaker":"other");
        out->setProperty("inputAccepted",accepted(preferences,true));out->setProperty("outputAccepted",accepted(preferences,false));out->setProperty("monitorRequested",monitor.requested());out->setProperty("monitor",engine.monitorInput.load());out->setProperty("monitorSuspended",monitor.requested()&&!engine.monitorInput.load());
        out->setProperty("message",monitor.requested()&&!engine.monitorInput.load()?juce::String("Monitoring muted · reconnect the audio device to resume, or turn monitoring off"):message);return result;
    }
    void configureAudio(const juce::var& request,std::function<void(juce::var)> complete) override{
        if(!attach()){complete(fields({{"__error","Standalone audio device is not ready"}}));return;}
        auto next=preferences.clone();for(const auto* name:{"inputEnabled","input","output","driver","monitor","monitorLevel"})if(request.hasProperty(name))next.getDynamicObject()->setProperty(name,request[name]);
        const double level=next["monitorLevel"].isVoid()?.5:(double)next["monitorLevel"];if(!std::isfinite(level)||level<0||level>1){complete(fields({{"__error","Invalid monitor level"}}));return;}
        if((bool)next["monitor"])next.getDynamicObject()->setProperty("inputEnabled",true);
        const bool routeRequest=request.hasProperty("inputEnabled")||request.hasProperty("input")||request.hasProperty("output")||request.hasProperty("driver");
        bool changed=false;for(const auto* name:{"inputEnabled","input","output","driver"})if(next[name].toString()!=preferences[name].toString())changed=true;
        changed=changed||(routeRequest&&(!accepted(next,true)||!accepted(next,false)));
        if(changed&&engine.recorder.hasTake()){complete(fields({{"__error","Finish the recording before changing audio routes"}}));return;}
        if((bool)next["inputEnabled"]&&!juce::RuntimePermissions::isGranted(juce::RuntimePermissions::recordAudio)){
            const auto weak=lifetime;
            juce::RuntimePermissions::request(juce::RuntimePermissions::recordAudio,[weak,next,complete](bool granted){
                juce::MessageManager::callAsync([weak,next,complete,granted]{if(auto* self=weak->load()){if(granted)self->configureAudio(next,complete);else complete(fields({{"__error","Microphone permission was not granted"}}));}});
            });return;
        }
        try{
            if(changed){const auto previous=preferences.clone();const auto setup=manager->getAudioDeviceSetup();const auto driver=manager->getCurrentAudioDeviceType();try{apply(next,true,false);}catch(...){if(manager->getCurrentAudioDeviceType()!=driver)manager->setCurrentAudioDeviceType(driver,true);manager->setAudioDeviceSetup(setup,false);preferences=previous;monitor.restore((bool)previous["monitor"],previous["monitorRoute"]);throw;}}
            else{preferences=next;monitor.configure((bool)next["monitor"],external(true),external(false));engine.monitorLevel.store((float)level);updateMonitor();}
            finishRoutes(std::move(complete),40);
        }catch(const std::exception& error){engine.monitorInput.store(false);complete(fields({{"__error",juce::String(error.what())}}));}
    }
private:
    static juce::String kind(const juce::String& name,bool input){const auto lower=name.toLowerCase();if(lower.contains("usb")||lower.removeCharacters(" -_").contains("sp404"))return "usb";if(lower.contains("built-in")||lower.contains("builtin")||lower.contains("macbook")||lower.contains("microphone array"))return input?"microphone":"speaker";return "other";}
    juce::AudioIODeviceType* type() const{return manager?manager->getCurrentDeviceTypeObject():nullptr;}
    juce::var ports(bool input) const{
        juce::Array<juce::var> result;
       #if JUCE_ANDROID
        const auto devices=androidAudioDevices();if(auto* rows=devices.getArray())for(const auto& row:*rows)if((bool)row["input"]==input)result.add(row.clone());
       #else
        if(auto* current=type())for(const auto& name:current->getDeviceNames(input))result.add(fields({{"id",name},{"name",name},{"stableId",current->getTypeName()+":"+name},{"kind",kind(name,input)},{"type",kind(name,input)=="usb"?"USBAudio":input?"AudioInput":"AudioOutput"}}));
       #endif
        return juce::var(result);
    }
    juce::var actual(bool input) const{
        if(!manager||!manager->getCurrentAudioDevice())return fields({{"name","Not ready"},{"kind","other"}});
       #if JUCE_ANDROID
        const auto stream=input?androidAudioInputInfo():androidAudioOutputInfo();const auto rows=ports(input);if(auto* list=rows.getArray())for(const auto& row:*list)if(stream.active&&(int)row["deviceId"]==stream.device)return row;
        return fields({{"name",stream.active?"System audio route":"Not ready"},{"kind","other"}});
       #else
        const auto setup=manager->getAudioDeviceSetup();const auto name=input?setup.inputDeviceName:setup.outputDeviceName;const auto rows=ports(input);if(auto* list=rows.getArray())for(const auto& row:*list)if(row["id"].toString()==name)return row;
        return fields({{"id",name},{"name",name},{"stableId",manager->getCurrentAudioDeviceType()+":"+name},{"kind",kind(name,input)}});
       #endif
    }
    juce::StringArray external(bool input) const{juce::StringArray result;const auto port=actual(input);const auto category=port["kind"].toString(),id=port["stableId"].toString();if(id.isNotEmpty()&&category!=(input?"microphone":"speaker"))result.add(id);return result;}
    bool accepted(const juce::var& settings,bool input) const{
        if(input&&!(bool)settings["inputEnabled"])return true;if(!manager||!manager->getCurrentAudioDevice())return false;
        const auto value=settings[input?"input":"output"].toString();const auto port=actual(input);if(value.isEmpty()||value=="automatic")return !input||engine.inputChannels.load()>0;
        if(value=="usb")return port["kind"].toString()=="usb";if(value=="microphone"||value=="speaker")return port["kind"].toString()==value;return value==port["id"].toString();
    }
    juce::String resolve(const juce::String& value,bool input,bool fallback){
        auto* current=type();if(!current)throw std::runtime_error("Audio driver is not ready");const auto names=current->getDeviceNames(input);
        if(names.isEmpty())throw std::runtime_error(input?"No audio input is available":"No audio output is available");
        if(value.isEmpty()||value=="automatic")return names[juce::jlimit(0,juce::jmax(0,names.size()-1),current->getDefaultDeviceIndex(input))];
        if(names.contains(value))return value;
        for(const auto& name:names)if(kind(name,input)==value)return name;
        if(fallback)return names[juce::jlimit(0,juce::jmax(0,names.size()-1),current->getDefaultDeviceIndex(input))];
        throw std::runtime_error(input?"The selected audio input is unavailable":"The selected audio output is unavailable");
    }
    void apply(const juce::var& next,bool rebind,bool fallback){
        engine.monitorInput.store(false);const auto driver=next["driver"].toString();if(driver.isNotEmpty()&&driver!=manager->getCurrentAudioDeviceType())manager->setCurrentAudioDeviceType(driver,true);if(auto* current=type())current->scanForDevices();
        const bool enabled=(bool)next["inputEnabled"];const auto in=enabled?resolve(next["input"].toString(),true,fallback):juce::String{},out=resolve(next["output"].toString(),false,fallback);auto setup=manager->getAudioDeviceSetup();
        std::unique_ptr<juce::AudioIODevice> candidate(type()->createDevice(out,in));if(!candidate)throw std::runtime_error("This input/output pair is unavailable");
        setup.inputDeviceName=in;setup.outputDeviceName=out;setup.useDefaultInputChannels=false;setup.inputChannels.clear();if(enabled)setup.inputChannels.setRange(0,juce::jmin(2,candidate->getInputChannelNames().size()),true);setup.useDefaultOutputChannels=true;
        const auto rates=candidate->getAvailableSampleRates();if(!rates.contains(setup.sampleRate))setup.sampleRate=0;const auto sizes=candidate->getAvailableBufferSizes();if(!sizes.contains(setup.bufferSize))setup.bufferSize=0;
        const auto error=manager->setAudioDeviceSetup(setup,true);if(error.isNotEmpty())throw std::runtime_error(error.toStdString());
        preferences=next.clone();monitor.configure((bool)next["monitor"],external(true),external(false),rebind);engine.monitorLevel.store((float)(double)next["monitorLevel"]);message={};
        if(!fallback&&(!accepted(next,true)||!accepted(next,false)))throw std::runtime_error("The device did not accept the requested input/output pair");acceptedEpoch.store(revision());updateMonitor();
    }
    uint64_t revision() const{
       #if JUCE_ANDROID
        return deviceEpoch.load()+androidAudioRouteRevision();
       #else
        return deviceEpoch.load();
       #endif
    }
    void updateMonitor(){
        const auto epoch=revision();if(epoch!=observed){observed=epoch;settleUntil=juce::Time::getMillisecondCounterHiRes()+250;}
        const bool active=monitor.update(external(true),external(false),manager&&engine.inputChannels.load()>0&&(bool)preferences["inputEnabled"]&&juce::Time::getMillisecondCounterHiRes()>=settleUntil&&accepted(preferences,true)&&accepted(preferences,false));
        preferences.getDynamicObject()->setProperty("monitorRoute",monitor.route());if(manager&&manager->getCurrentAudioDevice()&&juce::Time::getMillisecondCounterHiRes()>=settleUntil)acceptedEpoch.store(epoch);engine.monitorInput.store(active);
    }
    void finishRoutes(std::function<void(juce::var)> complete,int attempts){updateMonitor();if(acceptedEpoch.load()==revision()){complete(audioRoutes());return;}if(attempts<=0){complete(fields({{"__error","Audio device is still changing; try again"}}));return;}const auto weak=lifetime;juce::Timer::callAfterDelay(25,[weak,complete,attempts]{if(auto* self=weak->load())self->finishRoutes(complete,attempts-1);});}
    bool attach(){
        if(manager)return true;auto* holder=juce::StandalonePluginHolder::getInstance();if(!holder||holder->processor.get()!=&engine)return false;manager=&holder->deviceManager;manager->addAudioCallback(this);return true;
    }
    void timerCallback() override{
        if(!attach())return;
        if(!restored){restored=true;auto initial=preferences.clone();if(!juce::RuntimePermissions::isGranted(juce::RuntimePermissions::recordAudio)){initial.getDynamicObject()->setProperty("inputEnabled",false);initial.getDynamicObject()->setProperty("monitor",false);}try{apply(initial,false,true);}catch(const std::exception& error){message=error.what();}}
       #if JUCE_ANDROID
        const auto current=androidAudioRouteRevision();if(current!=platformRevision){platformRevision=current;engine.monitorInput.store(false);engine.recorder.interrupt();try{apply(preferences,false,true);}catch(const std::exception& error){message=error.what();}}
       #endif
        updateMonitor();
    }
    void audioDeviceIOCallbackWithContext(const float* const* input,int inputs,float* const* output,int outputs,int frames,const juce::AudioIODeviceCallbackContext&) override{
        const bool sameRoute=acceptedEpoch.load()==revision();if(!sameRoute)engine.recorder.interrupt();engine.recorder.capture(input,inputs,frames,engine.inputRate.load(),false);float peak=0;
        for(int c=0;c<inputs;++c)if(input[c])for(int i=0;i<frames;++i)if(std::isfinite(input[c][i]))peak=juce::jmax(peak,std::abs(input[c][i]));engine.inputPeak.store(juce::jmax(peak,engine.inputPeak.load()*(float)std::exp(-frames/(juce::jmax(8000.0,engine.inputRate.load())*.3))));
        const float gain=engine.monitorInput.load()&&sameRoute?engine.monitorLevel.load():0;for(int c=0;c<outputs;++c)if(output[c]){const auto* source=inputs>0?input[juce::jmin(c,inputs-1)]:nullptr;for(int i=0;i<frames;++i)output[c][i]=source&&std::isfinite(source[i])?source[i]*gain:0;}
    }
    void audioDeviceAboutToStart(juce::AudioIODevice* device) override{engine.monitorInput.store(false);++deviceEpoch;engine.inputRate.store(device->getCurrentSampleRate());engine.inputChannels.store(device->getActiveInputChannels().countNumberOfSetBits());}
    void audioDeviceStopped() override{engine.monitorInput.store(false);++deviceEpoch;engine.inputChannels.store(0);engine.inputPeak.store(0);engine.recorder.interrupt();}
    CueProcessor& engine;juce::AudioDeviceManager* manager=nullptr;juce::var preferences;MonitorRouteGuard monitor;juce::String message;bool restored=false;
    std::atomic<uint64_t> deviceEpoch{0},acceptedEpoch{~uint64_t{0}};uint64_t observed=0,platformRevision=0;double settleUntil=0;
    std::shared_ptr<std::atomic<DeviceAudio*>> lifetime=std::make_shared<std::atomic<DeviceAudio*>>(nullptr);
};
std::unique_ptr<StandaloneNowPlaying> create(CueProcessor& engine){return std::make_unique<DeviceAudio>(engine);}
const bool registered=[] {registerStandaloneAudioRoutesFactory(create);return true;}();
}
