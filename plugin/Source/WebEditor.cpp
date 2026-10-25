#include "WebEditor.h"
#include "MobileWebAssets.h"
#if JUCE_MAC || JUCE_IOS
#include "AppleHttp.h"
#endif

namespace {
juce::var object(std::initializer_list<std::pair<juce::Identifier,juce::var>> fields) {
    auto result=std::make_unique<juce::DynamicObject>();
    for(const auto& field:fields)result->setProperty(field.first,field.second);
    return juce::var(result.release());
}
juce::var failure(const juce::String& text) {return object({{"__error",text}});}
}

MobileWebEditor::MobileWebEditor(CueProcessor& processor)
    : AudioProcessorEditor(processor), engine(processor),
     #if BEATMAKER_DESKTOP_BETA
      webBytes(MobileWebAssets::desktopbetaui_zip,MobileWebAssets::desktopbetaui_zipSize,false), archive(webBytes), browser(options()) {
        setSize(1280,850);setResizable(true,true);setResizeLimits(950,650,1800,1400);
     #else
      webBytes(MobileWebAssets::mobileui_zip,MobileWebAssets::mobileui_zipSize,false), archive(webBytes), browser(options()) {
    setSize(440,800);setResizable(true,true);setResizeLimits(320,480,1200,1400);
     #endif
    engine.openEditors.fetch_add(1);
    previousRestoreRevision=engine.restoreRevision.load();
    addAndMakeVisible(browser);
    browser.goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
    startTimerHz(60);
}
MobileWebEditor::~MobileWebEditor(){stopTimer();cancelled->store(true);requests.removeAllJobs(true,-1);storageWorker.removeAllJobs(false,-1);engine.openEditors.fetch_sub(1);}
void MobileWebEditor::resized(){browser.setBounds(getLocalBounds());}

juce::WebBrowserComponent::Options MobileWebEditor::options() {
    auto configuration=juce::WebBrowserComponent::Options{};
   #if JUCE_WINDOWS
    configuration=configuration.withBackend(juce::WebBrowserComponent::Options::Backend::webview2);
   #endif
    return configuration.withNativeIntegrationEnabled()
       #if BEATMAKER_DESKTOP_BETA
        .withInitialisationData("desktopBeta",true)
       #endif
        .withInitialisationData("pluginStorage",engine.sessionUiState())
        .withUserScript(juce::String::fromUTF8(MobileWebAssets::bridge_js,MobileWebAssets::bridge_jsSize))
        .withResourceProvider([this](const auto& path){return resource(path);})
        .withNativeFunction("audio",[this](const auto& args,auto complete){complete(audio(args[0]));})
        .withNativeFunction("store",[this](const auto& args,auto complete){
            engine.setWebState(args[0].toString());
            const auto snapshot=engine.getWebState();
            const auto session=engine.getSessionId();
            storageTask([this,snapshot,session]{engine.libraryStore.writePreferences(snapshot,session);return juce::var(true);},std::move(complete));
        })
        .withNativeFunction("initialState",[this](const auto&,auto complete){storageTask([this]{
            engine.libraryStore.migrate(engine.getLegacyState());return object({{"defaults",engine.libraryStore.readPreferences(engine.getSessionId())},{"session",engine.sessionUiState()}});
        },std::move(complete));})
        .withNativeFunction("libraryRead",[this](const auto&,auto complete){storageTask([this]{return juce::var(engine.libraryStore.readLibrary());},std::move(complete));})
        .withNativeFunction("libraryCommit",[this](const auto& args,auto complete){const auto baseline=args[0]["base"].toString(), next=args[0]["next"].toString();storageTask([this,baseline,next]{return juce::var(engine.libraryStore.commitLibrary(baseline,next));},std::move(complete));})
        .withNativeFunction("cachedTrack",[this](const auto& args,auto complete){const auto id=args[0].toString();storageTask([this,id]{return engine.cachedTrack(id);},std::move(complete));})
        .withNativeFunction("importAudio",[this](const auto&,auto complete){
            exporter=std::make_unique<juce::FileChooser>("Import audio",juce::File{},"*.wav;*.aif;*.aiff;*.flac;*.mp3;*.m4a");
            juce::Component::SafePointer<MobileWebEditor> safe(this);
            exporter->launchAsync(juce::FileBrowserComponent::openMode|juce::FileBrowserComponent::canSelectFiles,
                [safe,complete=std::move(complete)](const auto& chooser){
                    if(!safe)return;const auto file=chooser.getResult();if(!file.existsAsFile()){complete(juce::var{});return;}
                    safe->storageTask([safe,file]{return safe?safe->engine.importLocalFile(file):juce::var{};},std::move(complete));
                });
        })
        .withNativeFunction("syncCues",[this](const auto& args,auto complete){engine.syncWebCues(args[0]);complete(true);})
        .withNativeFunction("midiOptions",[this](const auto& args,auto complete){engine.overwrite.store((bool)args[0]["overwrite"]);complete(true);})
        .withNativeFunction("http",[this](const auto& args,auto complete){http(args[0],std::move(complete));})
        .withNativeFunction("diagnostic",[](const auto& args,auto complete){juce::Logger::outputDebugString("Plugin UI: "+args[0].toString());complete(true);})
        .withNativeFunction("exportText",[this](const auto& args,auto complete){
            const auto name=juce::File::createLegalFileName(args[0]["name"].toString());
            const auto text=args[0]["text"].toString();
            exporter=std::make_unique<juce::FileChooser>("Save Beatmaker library",juce::File::getSpecialLocation(juce::File::userDocumentsDirectory).getChildFile(name),"*.json");
            exporter->launchAsync(juce::FileBrowserComponent::saveMode|juce::FileBrowserComponent::canSelectFiles,
                [text,complete=std::move(complete)](const auto& chooser){const auto file=chooser.getResult();complete(file==juce::File{}?failure("Cancelled"):juce::var(file.replaceWithText(text)));});
        });
}

std::optional<juce::WebBrowserComponent::Resource> MobileWebEditor::resource(const juce::String& requested) {
    auto path=requested.upToFirstOccurrenceOf("?",false,false).trimCharactersAtStart("/");
    if(path.isEmpty()||!path.containsChar('.'))path="index.html";
    const int index=archive.getIndexOfFileName(path);
    if(index<0)return std::nullopt;
    std::unique_ptr<juce::InputStream> input(archive.createStreamForEntry(index));
    if(!input)return std::nullopt;
    juce::MemoryBlock bytes;input->readIntoMemoryBlock(bytes);
    if(path=="index.html"){
        auto html=juce::String::fromUTF8((const char*)bytes.getData(),(int)bytes.getSize());
        const auto begin=html.indexOf("<script type=\"module\"");
        if(begin>=0){const auto end=html.indexOf(begin,"</script>")+9;const auto tag=html.substring(begin,end);
            const auto script=tag.fromFirstOccurrenceOf("src=\"",false,false).upToFirstOccurrenceOf("\"",false,false);
            html=html.substring(0,begin)+"<script type=\"module\">await window.__pluginInit;await import("+juce::JSON::toString(script)+");</script>"+html.substring(end);
            bytes.replaceAll(html.toRawUTF8(),html.getNumBytesAsUTF8());
        }
    }
    juce::String mime="application/octet-stream";
    if(path.endsWith(".html"))mime="text/html";
    if(path.endsWith(".js"))mime="text/javascript";
    if(path.endsWith(".css"))mime="text/css";
    if(path.endsWith(".png"))mime="image/png";
    if(path.endsWith(".svg"))mime="image/svg+xml";
    if(path.endsWith(".woff2"))mime="font/woff2";
    std::vector<std::byte> data(bytes.getSize());std::memcpy(data.data(),bytes.getData(),bytes.getSize());
    return juce::WebBrowserComponent::Resource{std::move(data),mime};
}

void MobileWebEditor::storageTask(std::function<juce::var()> action,juce::WebBrowserComponent::NativeFunctionCompletion complete){
    juce::Component::SafePointer<MobileWebEditor> safe(this);
    storageWorker.addJob([safe,action=std::move(action),complete=std::move(complete)]{
        juce::var result;
        try{result=action();}catch(const std::exception& error){result=failure(error.what());}
        juce::MessageManager::callAsync([safe,result,complete=std::move(complete)]{if(safe)complete(result);});
    });
}

void MobileWebEditor::http(const juce::var& request,juce::WebBrowserComponent::NativeFunctionCompletion complete) {
    const juce::URL url(request["url"].toString());
    const auto host=url.getDomain();
    juce::Logger::outputDebugString("Plugin catalog request: "+host+url.getSubPath().upToFirstOccurrenceOf("?",false,false));
    const bool allowed=url.getScheme()=="https"&&(host=="www.youtube.com"||host=="music.youtube.com"||host=="youtubei.googleapis.com"||host=="raw.githubusercontent.com"||host=="suggestqueries.google.com");
    if(!allowed){complete(failure("Unsupported catalog URL: "+host));return;}
    juce::Component::SafePointer<MobileWebEditor> safe(this);const auto cancel=cancelled;
    engine.networkWorkers.addJob([safe,cancel,request,complete=std::move(complete)] {
        if(cancel->load())return;
        juce::URL url(request["url"].toString());
        const auto method=request["method"].toString().toUpperCase();
        auto data=request["data"];
        if(!data.isVoid()&&!data.isString())data=juce::JSON::toString(data);
        if(method=="POST")url=url.withPOSTData(data.toString());
        juce::String headers;
        if(auto* fields=request["headers"].getDynamicObject())for(const auto& field:fields->getProperties())
            headers+=field.name.toString()+": "+field.value.toString()+"\r\n";
        int status=0;juce::StringPairArray responseHeaders;
       #if JUCE_MAC || JUCE_IOS
        const auto response=appleHttp(request["url"].toString(),method.isEmpty()?"GET":method,headers,data.toString(),15,[cancel]{return cancel->load();});
        status=response.status;responseHeaders=response.headers;
        auto stream=std::make_unique<juce::MemoryInputStream>(response.data,true);
       #else
        auto stream=url.createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
            .withConnectionTimeoutMs(15000).withHttpRequestCmd(method.isEmpty()?"GET":method).withExtraHeaders(headers)
            .withStatusCode(&status).withResponseHeaders(&responseHeaders));
       #endif
        juce::var result;
        juce::Logger::outputDebugString("Plugin catalog response HTTP "+juce::String(status));
        if(!stream)result=failure("Catalog connection failed");
        else {
            juce::MemoryBlock body;stream->readIntoMemoryBlock(body,12*1024*1024);
            auto fields=std::make_unique<juce::DynamicObject>();
            for(int i=0;i<responseHeaders.size();++i)fields->setProperty(juce::Identifier(responseHeaders.getAllKeys()[i]),responseHeaders.getAllValues()[i]);
            result=object({{"status",status},{"headers",juce::var(fields.release())},{"data",juce::String::fromUTF8((const char*)body.getData(),(int)body.getSize())}});
        }
        juce::MessageManager::callAsync([safe,complete=std::move(complete),result]{if(safe)complete(result);});
    });
}

juce::var MobileWebEditor::audio(const juce::var& message) {
    const auto command=message["cmd"].toString();
    if(command=="load") {
        engine.setNativeQueue(message["queue"]);
        sourceId=(int)message["sourceId"];sourceUrl=message["url"].toString();announced=false;pendingLoad=true;
        lastPosition=(double)message["startAt"];previousPlaying=false;
        const auto queue=message["queue"];const auto tracks=queue["tracks"];const int index=(int)queue["index"];
        const auto id=tracks.isArray()&&index>=0&&index<tracks.size()?tracks[index]["id"].toString():juce::String{};
        if(sourceUrl.isNotEmpty())engine.loadRemote(sourceUrl,lastPosition,id);
        else {engine.requestedPlay.store(false);engine.submit({CueProcessor::Action::pause});pendingLoad=false;}
    } else if(command=="play") {engine.requestedPlay.store(true);if(engine.ready.load())engine.submit({CueProcessor::Action::play});}
    else if(command=="pause") {engine.requestedPlay.store(false);engine.submit({CueProcessor::Action::pause});}
    else if(command=="seek"||command=="cue") {
        if((int)message["sourceId"]!=sourceId)return failure("Audio source changed");
        const double target=(double)message["to"];
        if(command=="cue")engine.requestedPlay.store(true);
        const auto bank=message["bank"].toString();const int pad=message["pad"].isVoid()?-1:(int)message["pad"]-1;
        engine.submit({command=="cue"?CueProcessor::Action::cue:CueProcessor::Action::seek,bank.isEmpty()?0:(int)bank[0]-'A',pad,target});
        emit("seeked",object({{"position",target}}));
    } else if(command=="queue")engine.setNativeQueue(message["queue"]);
    else if(command=="position")return object({{"position",engine.playhead.load()}});
    else if(command=="snapshot") {
        auto snapshot=engine.nativeSnapshot();snapshot.getDynamicObject()->setProperty("sourceId",sourceId);
        if((bool)snapshot["ready"])announced=true;
        return snapshot;
    }
    else if(command=="volume") {
        auto* parameter=engine.parameters.getParameter("gain");const auto target=(float)message["value"];if(std::abs(parameter->getValue()-target)>0.00001f)parameter->setValueNotifyingHost(target);
    } else if(command=="muted")engine.muted.store((bool)message["value"]);
    else if(command=="rate") {
        engine.preservePitch.store(message["preservePitch"].isVoid()?true:(bool)message["preservePitch"]);
        engine.semitones.store(juce::jlimit(-12.0f,12.0f,(float)message["semitones"]));
        auto* parameter=engine.parameters.getParameter("speed");
        const auto target=parameter->convertTo0to1((float)message["value"]);if(std::abs(parameter->getValue()-target)>0.00001f)parameter->setValueNotifyingHost(target);
    } else if(command=="loop") {
        engine.loopIn.store(message["from"].isVoid()?-1:(double)message["from"]);
        engine.loopOut.store(message["to"].isVoid()?-1:(double)message["to"]);
        engine.loopEnabled.store((bool)message["on"]&&engine.loopOut.load()>engine.loopIn.load());
    }
    return object({});
}

void MobileWebEditor::emit(const juce::String& event,juce::var payload) {
    if(auto* fields=payload.getDynamicObject())fields->setProperty("sourceId",sourceId);
    browser.emitEventIfBrowserIsVisible("pluginAudio",object({{"event",event},{"payload",payload}}));
}

void MobileWebEditor::timerCallback() {
    if(previousRestoreRevision!=engine.restoreRevision.load()){
        previousRestoreRevision=engine.restoreRevision.load();announced=false;pendingLoad=false;browser.refresh();return;
    }
    if(previousTrackRevision!=engine.nativeTrackRevision.load()){
        previousTrackRevision=engine.nativeTrackRevision.load();announced=false;pendingLoad=true;lastRevision=-1;emit("track",engine.nativeSnapshot());
    }
    if(lastRevision!=engine.cueRevision.load()){lastRevision=engine.cueRevision.load();browser.emitEventIfBrowserIsVisible("pluginCues",engine.getWebCues());}
    juce::Array<juce::var> padEvents;
    for(int index=0;index<160;++index){
        const auto state=engine.padStates[(size_t)index].load(std::memory_order_relaxed), previous=previousPads[(size_t)index];
        if(state==previous)continue;
        padEvents.add(object({{"bank",juce::String::charToString((juce::juce_wchar)('A'+index/16))},{"pad",index%16+1},
            {"pressed",(state&1u)!=0},{"heldChanged",(state&1u)!=(previous&1u)},{"triggered",(state>>1)!=(previous>>1)},
            {"velocity",engine.padVelocities[(size_t)index].load(std::memory_order_relaxed)}}));
        previousPads[(size_t)index]=state;
    }
    if(!padEvents.isEmpty())browser.emitEventIfBrowserIsVisible("pluginPads",juce::var(padEvents));
    if(++timerTicks%6!=0)return; // 60 Hz pad feedback, 10 Hz playhead/metadata.
    const auto parameters=object({{"speed",(engine.parameters.getRawParameterValue("speed")->load()-1.0f)*100.0f},{"volume",engine.parameters.getRawParameterValue("gain")->load()},
        {"speedMode",engine.preservePitch.load()?"speed":"pitch"},{"tuning",engine.semitones.load()}});
    const auto encoded=juce::JSON::toString(parameters,true);
    if(encoded!=previousParameters){previousParameters=encoded;browser.emitEventIfBrowserIsVisible("pluginParameters",parameters);}
    if(previousErrorRevision!=engine.nativeErrorRevision.load()){
        previousErrorRevision=engine.nativeErrorRevision.load();emit("error",object({{"message",engine.getStatus()}}));
    }
    const bool isReady=engine.ready.load(), isPlaying=engine.playing.load();
    if(pendingLoad&&isReady&&!announced) {announced=true;pendingLoad=false;emit("ready",object({{"duration",engine.getDuration()}}));}
    if(isPlaying!=previousPlaying){emit(isPlaying?"playing":"pause",object({}));previousPlaying=isPlaying;}
    const auto at=engine.playhead.load();
    if(announced){emit("time",object({{"position",at},{"duration",engine.getDuration()},{"buffered",engine.getDuration()}}));
        if(engine.nativeEnded.exchange(false)){engine.requestedPlay.store(false);emit("ended",object({}));}}
    if(pendingLoad){const auto status=engine.getStatus();if(status.containsIgnoreCase("failed")||status.containsIgnoreCase("cannot")||status.containsIgnoreCase("cancelled")||status.containsIgnoreCase("missing")||status.containsIgnoreCase("unavailable")){pendingLoad=false;emit("error",object({{"message",status}}));}}
    lastPosition=at;
}
