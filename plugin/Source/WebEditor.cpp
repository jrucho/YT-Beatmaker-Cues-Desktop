#include "WebEditor.h"
#include "MobileWebAssets.h"
#if JUCE_ANDROID
#include "AndroidStandalone.h"
#include "AndroidCodec.h"
#endif
#if JUCE_MAC || JUCE_IOS
#include "AppleHttp.h"
#endif

namespace {
 #if JUCE_IOS || JUCE_ANDROID
 constexpr int resizeGripSize=0;
 #else
 constexpr int resizeGripSize=18;
 #endif
juce::var object(std::initializer_list<std::pair<juce::Identifier,juce::var>> fields) {
    auto result=std::make_unique<juce::DynamicObject>();
    for(const auto& field:fields)result->setProperty(field.first,field.second);
    return juce::var(result.release());
}
juce::var failure(const juce::String& text) {return object({{"__error",text}});}
 #if JUCE_ANDROID
void registerMediaPickerTypes(){
    static std::once_flag once;std::call_once(once,[]{
        for(const auto& entry:std::initializer_list<std::pair<const char*,const char*>>{{"audio/mp4","m4a"},{"audio/x-m4a","m4a"},{"audio/aac","aac"},{"audio/flac","flac"},{"audio/x-flac","flac"},{"audio/ogg","ogg"},{"application/ogg","ogg"},{"video/mp4","mp4"},{"audio/mp4","mp4"},{"video/webm","webm"},{"video/x-matroska","mkv"}})juce::FileChooser::registerCustomMimeTypeForFileExtension(entry.first,entry.second);
    });
}
 #endif
juce::var bridgeResult(const juce::var& result){
    // JUCE 8.0.12 emits events through repeated String::replace calls. Large JSON
    // strings (catalog pages and library snapshots) contain many backslashes and
    // trigger quadratic copies on the UI thread. Encode on this worker instead;
    // base64 has no characters needing that escaping, and preserves UTF-8.
    const auto json=juce::JSON::toString(result,true);
    if(json.getNumBytesAsUTF8()<16*1024)return result;
    return object({{"__pluginBase64",juce::Base64::toBase64(json.toRawUTF8(),json.getNumBytesAsUTF8())}});
}
}

MobileWebEditor::MobileWebEditor(CueProcessor& processor, bool offline)
    : AudioProcessorEditor(processor), engine(processor), offlineSmoke(offline),
     #if BEATMAKER_DESKTOP_BETA
      webBytes(MobileWebAssets::desktopbetaui_zip,MobileWebAssets::desktopbetaui_zipSize,false), archive(webBytes), browser(options()) {
        const int defaultWidth=1280,defaultHeight=850;
     #else
      webBytes(MobileWebAssets::mobileui_zip,MobileWebAssets::mobileui_zipSize,false), archive(webBytes), browser(options()) {
    const int defaultWidth=440,defaultHeight=800;
     #endif
   #if JUCE_ANDROID
    registerMediaPickerTypes();
   #endif
    const bool standalone=engine.wrapperType==juce::AudioProcessor::wrapperType_Standalone;
    const int width=!standalone&&engine.editorWidth.load()>0?engine.editorWidth.load():defaultWidth,height=!standalone&&engine.editorHeight.load()>0?engine.editorHeight.load():defaultHeight;
    setResizable(true,resizeGripSize>0);
   #if JUCE_IOS || JUCE_ANDROID
    // A desktop minimum height clips a phone's landscape viewport.
    setResizeLimits(240,240,4096,4096);
   #else
    setResizeLimits(320,480,4096,4096);
   #endif
    setSize(width,height);
    engine.openEditors.fetch_add(1);
    previousRestoreRevision=engine.restoreRevision.load();
    addAndMakeVisible(browser);
    if(!standalone&&engine.wrapperType!=juce::AudioProcessor::wrapperType_Undefined)hostedKeyboard=createHostedKeyboard(engine,*this);
   #if (JUCE_MAC || JUCE_IOS || JUCE_WINDOWS) && !BEATMAKER_DESKTOP_BETA
    nativePadInput=std::make_unique<NativePadInput>(engine,browser);
   #endif
   #if BEATMAKER_PERFORMANCE_FEATURES && !BEATMAKER_DESKTOP_BETA
    engine.songPlaybackEnabled.store(true);
   #endif
    browser.goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
    startTimerHz(60);
}
MobileWebEditor::~MobileWebEditor(){setRecordingMidiGuard(false);setFineMidiEditor(false);nativePadInput.reset();hostedKeyboard.reset();stopTimer();cancelled->store(true);requests.removeAllJobs(true,-1);mediaWorker.removeAllJobs(false,-1);engine.clearSamplerPreview();storageWorker.removeAllJobs(false,-1);engine.openEditors.fetch_sub(1);}
void MobileWebEditor::parentHierarchyChanged(){
   #if JUCE_IOS || JUCE_ANDROID
    // Logical-to-physical rounding may leave the last device pixel to the JUCE
    // standalone window. Its default blue-grey background looks like a bright
    // vertical line beside the black WebView, even with full-width HTML.
    if(auto* window=dynamic_cast<juce::ResizableWindow*>(getTopLevelComponent()))window->setBackgroundColour(juce::Colours::black);
   #endif
}
void MobileWebEditor::resized(){
    // Native browser subviews can cover a software JUCE grip. Reserve its own hit area.
    browser.setBounds(getLocalBounds().withTrimmedBottom(resizeGripSize));
    if(nativePadInput)nativePadInput->invalidateLayout();
    engine.editorWidth.store(getWidth());engine.editorHeight.store(getHeight());
}

juce::WebBrowserComponent::Options MobileWebEditor::options() {
    auto configuration=juce::WebBrowserComponent::Options{};
   #if JUCE_WINDOWS
    configuration=configuration.withBackend(juce::WebBrowserComponent::Options::Backend::webview2);
   #endif
    return configuration.withNativeIntegrationEnabled()
       #if BEATMAKER_DESKTOP_BETA
        .withInitialisationData("desktopBeta",true)
       #endif
        .withInitialisationData("appVersion",JucePlugin_VersionString)
        .withInitialisationData("songTransitions",true)
        .withInitialisationData("performanceFeatures",BEATMAKER_PERFORMANCE_FEATURES&&!BEATMAKER_DESKTOP_BETA)
       #if JUCE_ANDROID
        .withInitialisationData("nativePlatform","android")
       #elif JUCE_IOS
        .withInitialisationData("nativePlatform","ios")
       #else
        .withInitialisationData("nativePlatform","desktop")
       #endif
        .withInitialisationData("pluginStorage",engine.sessionUiState())
        .withInitialisationData("hostedPlugin",engine.wrapperType!=juce::AudioProcessor::wrapperType_Standalone&&engine.wrapperType!=juce::AudioProcessor::wrapperType_Undefined)
       #if JUCE_IOS && BEATMAKER_IOS_PREVIEW
        .withInitialisationData("iosPreviewFeatures",engine.wrapperType==juce::AudioProcessor::wrapperType_Standalone||engine.wrapperType==juce::AudioProcessor::wrapperType_Undefined)
       #endif
       #if (JUCE_MAC || JUCE_IOS || JUCE_WINDOWS) && !BEATMAKER_DESKTOP_BETA
        .withInitialisationData("nativePadInput",true)
       #endif
       #if JUCE_IOS || JUCE_ANDROID
        .withInitialisationData("desktopPlatform",false)
       #else
        .withInitialisationData("desktopPlatform",true)
       #endif
        .withUserScript(juce::String::fromUTF8(MobileWebAssets::bridge_js,MobileWebAssets::bridge_jsSize))
        .withResourceProvider([this](const auto& path){return resource(path);})
        .withNativeFunction("audio",[this](const auto& args,auto complete){complete(audio(args[0]));})
        .withNativeFunction("padTouchRegions",[this](const auto& args,auto complete){if(nativePadInput)nativePadInput->configure(args.isEmpty()?juce::var{}:args[0]);complete(true);})
        .withNativeFunction("padTouchClaim",[this](const auto& args,auto complete){complete(nativePadInput?nativePadInput->claim(args[0]):object({{"accepted",false}}));})
        .withNativeFunction("padTouchState",[this](const auto&,auto complete){complete(nativePadInput?nativePadInput->state():object({{"supported",false}}));})
        .withNativeFunction("padTouchDiagnostics",[this](const auto&,auto complete){complete(nativePadInput?nativePadInput->diagnostics():object({{"supported",false}}));})
        .withNativeFunction("cueWorkspace",[this](const auto& args,auto complete){if(nativePadInput)nativePadInput->setPageScrollLocked(!args.isEmpty()&&(bool)args[0]);complete(true);})
        .withNativeFunction("keyboardFocus",[this](const auto& args,auto complete){if(hostedKeyboard&&!args.isEmpty())hostedKeyboard->setUiState((bool)args[0]["editing"],(bool)args[0]["padsActive"]);complete(true);})
        .withNativeFunction("keyboardDiagnostics",[this](const auto&,auto complete){complete(hostedKeyboard?hostedKeyboard->diagnostics():juce::var{});})
        .withNativeFunction("store",[this](const auto& args,auto complete){
            if(engine.backgroundPlayback.load()||uiStateIsStale()){complete(true);return;}
            engine.setWebState(args[0].toString());
            const auto snapshot=engine.getWebState();
            const auto session=engine.getSessionId();
            const int trackRevision=engine.nativeTrackRevision.load(),remoteRevision=engine.remoteTransportRevision.load();
            storageTask([this,snapshot,session,trackRevision,remoteRevision]{if(!engine.backgroundPlayback.load()&&engine.nativeTrackRevision.load()==trackRevision&&engine.remoteTransportRevision.load()==remoteRevision)engine.libraryStore.writePreferences(snapshot,session);return juce::var(true);},std::move(complete));
        })
        .withNativeFunction("initialState",[this](const auto&,auto complete){storageTask([this]{
            engine.libraryStore.migrate(engine.getLegacyState());return object({{"defaults",engine.libraryStore.readPreferences(engine.getSessionId())},{"session",engine.sessionUiState()}});
        },std::move(complete));})
        .withNativeFunction("libraryRead",[this](const auto&,auto complete){storageTask([this]{return juce::var(engine.libraryStore.readLibrary());},std::move(complete));})
        .withNativeFunction("libraryVersion",[this](const auto&,auto complete){storageTask([this]{return juce::var(engine.libraryStore.version());},std::move(complete));})
        .withNativeFunction("librarySnapshot",[this](const auto&,auto complete){storageTask([this]{return engine.libraryStore.readSnapshot();},std::move(complete));})
        .withNativeFunction("libraryCommit",[this](const auto& args,auto complete){const auto baseline=args[0]["base"].toString(), next=args[0]["next"].toString();storageTask([this,baseline,next]{return juce::var(engine.libraryStore.commitLibrary(baseline,next));},std::move(complete));})
        .withNativeFunction("cachedTrack",[this](const auto& args,auto complete){const auto id=args[0].toString();storageTask([this,id]{return engine.cachedTrack(id);},std::move(complete));})
        .withNativeFunction("localMedia",[this](const auto&,auto complete){storageTask([this]{return engine.libraryStore.allMedia();},std::move(complete));})
        .withNativeFunction("renameLocalAudio",[this](const auto& args,auto complete){const auto id=args[0]["id"].toString(),title=args[0]["title"].toString();storageTask([this,id,title]{return engine.libraryStore.renameLocalMedia(id,title);},std::move(complete),true);})
        .withNativeFunction("mixer",[this](const auto& args,auto complete){try{if(!args.isEmpty())engine.setMixer(args[0]);complete(engine.mixerState());}catch(const std::exception& error){complete(failure(error.what()));}})
        .withNativeFunction("transitions",[this](const auto& args,auto complete){try{if(!args.isEmpty())engine.setTransitions(args[0]);complete(engine.transitions());}catch(const std::exception& error){complete(failure(error.what()));}})
        .withNativeFunction("looperState",[this](const auto& args,auto complete){try{complete(engine.looperState(!args.isEmpty()&&(bool)args[0]["events"]));}catch(const std::exception& error){complete(failure(error.what()));}})
        .withNativeFunction("looperPad",[this](const auto& args,auto complete){try{complete(engine.looperAction(args[0]));}catch(const std::exception& error){complete(failure(error.what()));}})
        .withNativeFunction("remapLoopers",[this](const auto& args,auto complete){try{engine.remapLoopers(args[0]["mappings"],args[0]["scope"].toString());complete(true);}catch(const std::exception& error){complete(failure(error.what()));}})
        .withNativeFunction("shareAudio",[this](const auto& args,auto complete){shareAudio(args.isEmpty()?juce::String{}:args[0]["id"].toString(),std::move(complete));})
        .withNativeFunction("eraseLocalAudio",[this](const auto& args,auto complete){const auto id=args[0]["id"].toString();if(engine.nativeSnapshot()["trackId"].toString()==id)engine.unloadSong();storageTask([this,id]{return engine.eraseLocalAudio(id);},std::move(complete),true);})
        .withNativeFunction("audioRoutes",[this](const auto&,auto complete){complete(engine.audioRoutes());})
        .withNativeFunction("configureAudio",[this](const auto& args,auto complete){engine.configureAudio(args.isEmpty()?juce::var{}:args[0],std::move(complete));})
        .withNativeFunction("recordAudio",[this](const auto& args,auto complete){const auto request=args.isEmpty()?juce::var{}:args[0];if(request["cmd"].toString()=="state"){complete(engine.recording(request));return;}storageTask([this,request]{return engine.recording(request);},std::move(complete),true);})
        .withNativeFunction("samplerSource",[this](const auto& args,auto complete){const auto track=args[0];const auto cancel=cancelled;storageTask([this,track,cancel]{return engine.samplerSource(track,[cancel]{return cancel->load();});},std::move(complete),true);})
        .withNativeFunction("samplerPreview",[this](const auto& args,auto complete){auto request=args.isEmpty()?juce::var{}:args[0].clone();if(!request.isObject()){complete(failure("Invalid sampler preview"));return;}if(request["cmd"].toString()=="stop"){engine.clearSamplerPreview();complete(true);return;}request.getDynamicObject()->setProperty("ticket",engine.reserveSamplerPreview());storageTask([this,request]{return engine.previewSamplerSource(request);},std::move(complete),true);})
        .withNativeFunction("chopAudio",[this](const auto& args,auto complete){const auto request=args[0];const auto cancel=cancelled;storageTask([this,request,cancel]{return engine.chopSamplerSource(request,[cancel]{return cancel->load();});},std::move(complete),true);})
        .withNativeFunction("assignPadSamples",[this](const auto& args,auto complete){const auto assignments=args[0];storageTask([this,assignments]{return engine.assignPadSamples(assignments);},std::move(complete),true);})
        .withNativeFunction("loadDiagnostics",[this](const auto&,auto complete){complete(engine.loadDiagnostics());})
        .withNativeFunction("waveform",[this](const auto&,auto complete){complete(engine.waveformSnapshot());})
        .withNativeFunction("waveformRegion",[this](const auto& args,auto complete){const auto request=args[0];storageTask([this,request]{return engine.waveformRegion(request);},std::move(complete));})
        .withNativeFunction("padSamples",[this](const auto&,auto complete){complete(engine.padSamples());})
        .withNativeFunction("remapPadSamples",[this](const auto& args,auto complete){const auto mappings=args.isEmpty()?juce::var{}:args[0];storageTask([this,mappings]{return engine.remapPadSamples(mappings);},std::move(complete));})
        .withNativeFunction("padSample",[this](const auto& args,auto complete){
            const auto request=args.isEmpty()?juce::var{}:args[0];const auto bank=request["bank"].toString();const int pad=(int)request["pad"]-1;
            if(bank.length()!=1||bank[0]<'A'||bank[0]>'J'||pad<0||pad>=16){complete(failure("Invalid sample pad"));return;}
            const int bankIndex=(int)bank[0]-'A';const auto command=request["cmd"].toString();
            if(command=="trigger"){complete(engine.submit({CueProcessor::Action::pad,bankIndex,pad}));return;}
            if(command=="preview"){const double start=(double)request["start"];if(!std::isfinite(start)||start<0){complete(failure("Invalid sample start"));return;}complete(engine.submit({CueProcessor::Action::auditionSample,bankIndex,pad,start}));return;}
            if(command=="remove"){storageTask([this,bankIndex,pad]{return engine.removePadSample(bankIndex,pad);},std::move(complete));return;}
            if(command=="start"){const double start=(double)request["start"];storageTask([this,bankIndex,pad,start]{return engine.editPadSample(bankIndex,pad,start);},std::move(complete));return;}
            if(command=="restore"){const auto descriptor=request["descriptor"];storageTask([this,bankIndex,pad,descriptor]{return engine.restorePadSample(bankIndex,pad,descriptor);},std::move(complete));return;}
            if(command!="load"){complete(failure("Unknown sample command"));return;}
            exporter=std::make_unique<juce::FileChooser>("Load sample into "+bank+juce::String(pad+1),juce::File{},"*.wav;*.aif;*.aiff;*.flac;*.mp3;*.m4a;*.aac;*.ogg");
            juce::Component::SafePointer<MobileWebEditor> safe(this);
            exporter->launchAsync(juce::FileBrowserComponent::openMode|juce::FileBrowserComponent::canSelectFiles,[safe,bankIndex,pad,complete=std::move(complete)](const auto& chooser){
                if(!safe)return;const auto source=chooser.getURLResult();
                if(source.isEmpty()){complete(safe->engine.padSamples());return;}
                safe->storageTask([safe,bankIndex,pad,source]{return safe?safe->engine.importPadSample(bankIndex,pad,source):juce::var{};},std::move(complete));
            });
        })
       #if JUCE_ANDROID
        .withNativeFunction("androidPlatform",[](const auto&,auto complete){complete(androidPlatformState());})
       #if JUCE_DEBUG
        .withNativeFunction("androidDecoderCheck",[this](const auto& args,auto complete){const auto input=juce::File(args[0]["encoded"].toString()),reference=juce::File(args[0]["pcm"].toString());storageTask([input,reference]{return checkAndroidReaderPCM(input,reference);},std::move(complete));})
       #endif
       #endif
        .withNativeFunction("effectKernel",[this](const auto& args,auto complete){
            try{if(!args.isEmpty())engine.setEffectKernel(args[0]);complete(engine.effectKernelState());}
            catch(const std::exception& error){complete(failure(error.what()));}
        })
        .withNativeFunction("fxGraph",[this](const auto& args,auto complete){
            try{if(!args.isEmpty())engine.setFxGraph(args[0]);complete(engine.fxGraphState());}
            catch(const std::exception& error){complete(failure(error.what()));}
        })
        .withNativeFunction("importAudio",[this](const auto& args,auto complete){
            const bool multiple=!args.isEmpty()&&(bool)args[0]["multiple"];
            exporter=std::make_unique<juce::FileChooser>("Import audio",juce::File{},"*.wav;*.aif;*.aiff;*.flac;*.mp3;*.m4a;*.aac;*.ogg;*.mp4;*.mov");
            juce::Component::SafePointer<MobileWebEditor> safe(this);
            exporter->launchAsync(juce::FileBrowserComponent::openMode|juce::FileBrowserComponent::canSelectFiles|(multiple?juce::FileBrowserComponent::canSelectMultipleItems:0),
                [safe,multiple,complete=std::move(complete)](const auto& chooser){
                    if(!safe)return;const auto files=chooser.getURLResults();
                    safe->storageTask([safe,files,multiple]{
                        if(!safe)return juce::var{};if(files.size()>32)throw std::runtime_error("Import up to 32 files at a time");
                        juce::Array<juce::var> tracks,errors;
                        for(const auto& file:files){try{tracks.add(safe->engine.importLocalAudio(file));}catch(const std::exception& error){if(!multiple)throw;errors.add(object({{"file",file.getFileName()},{"message",juce::String(error.what())}}));}}
                        return multiple?object({{"tracks",tracks},{"errors",errors}}):(tracks.size()?tracks[0]:juce::var{});
                    },std::move(complete),true);
                });
        })
        .withNativeFunction("importGallery",[this](const auto&,auto complete){
            if(galleryBusy){complete(failure("A gallery picker is already open"));return;}galleryBusy=true;juce::Component::SafePointer<MobileWebEditor> safe(this);
            gallery=pickGalleryVideo(*this,[safe,complete=std::move(complete)](GallerySelection selection)mutable{
                if(!safe){if(selection.temporaryDirectory!=juce::File{})selection.temporaryDirectory.deleteRecursively();return;}safe->galleryBusy=false;
                auto cleanup=std::shared_ptr<juce::File>(new juce::File(selection.temporaryDirectory),[](juce::File* folder){if(*folder!=juce::File{})folder->deleteRecursively();delete folder;});
                if(selection.error.isNotEmpty()){complete(failure(selection.error));return;}
                if(selection.source.isEmpty()){complete(object({{"tracks",juce::Array<juce::var>{}},{"errors",juce::Array<juce::var>{}}}));return;}
                safe->storageTask([safe,selection,cleanup]{
                    auto track=safe->engine.importLocalAudio(selection.source);
                    const auto name=selection.name.isEmpty()?juce::String{}:juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile(juce::File::createLegalFileName(selection.name)).getFileNameWithoutExtension();
                    if(name.isNotEmpty())track=safe->engine.libraryStore.renameLocalMedia(track["id"].toString(),name)["track"];
                    return object({{"tracks",juce::Array<juce::var>{track}},{"errors",juce::Array<juce::var>{}}});
                },std::move(complete),true);
            });
        })
        .withNativeFunction("syncCues",[this](const auto& args,auto complete){if(!engine.backgroundPlayback.load()&&!uiStateIsStale())engine.syncWebCues(args[0]);complete(true);})
        .withNativeFunction("midiOptions",[this](const auto& args,auto complete){if(args[0].hasProperty("overwrite"))engine.overwrite.store((bool)args[0]["overwrite"]);if(args[0].hasProperty("velocityEnabled"))engine.midiVelocityEnabled.store((bool)args[0]["velocityEnabled"]);if(args[0].hasProperty("suspendPadActions"))setRecordingMidiGuard((bool)args[0]["suspendPadActions"]);if(args[0].hasProperty("fineEdit"))setFineMidiEditor((bool)args[0]["fineEdit"]);complete(true);})
        .withNativeFunction("http",[this](const auto& args,auto complete){if(offlineSmoke)complete(failure("Catalog disabled for offline smoke test"));else http(args[0],std::move(complete));})
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
            // Android exposes scripts through its Java interface rather than
            // injecting them at document start. Bootstrap before importing UI.
            html=html.substring(0,begin)+"<script type=\"module\">if(window.__JUCE__?.getAndroidUserScripts&&!window.__JUCE__.backend){window.inAndroidUserScriptEval=true;try{(0,eval)(window.__JUCE__.getAndroidUserScripts());}finally{delete window.inAndroidUserScriptEval;}}await window.__pluginInit;await import("+juce::JSON::toString(script)+");</script>"+html.substring(end);
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

void MobileWebEditor::shareAudio(const juce::String& id,juce::WebBrowserComponent::NativeFunctionCompletion complete){
    if(audioExportBusy){complete(failure("An audio export is already open"));return;}
    audioExportBusy=true;juce::Component::SafePointer<MobileWebEditor> safe(this);
    storageTask([this,id]{return engine.prepareLocalAudioExport(id);},[safe,complete=std::move(complete)](juce::var prepared)mutable{
        if(!safe)return;
        if(prepared.hasProperty("__error")){safe->audioExportBusy=false;complete(prepared);return;}
        const juce::File file(prepared["path"].toString()),folder(prepared["folder"].toString());
        auto finish=[safe,folder,complete=std::move(complete)](bool success,const juce::String& error)mutable{
            if(!safe)return;safe->audioExportBusy=false;
            juce::MessageManager::callAsync([safe]{if(safe)safe->audioSharer={};});
            safe->mediaWorker.addJob([folder]{folder.deleteRecursively();});
            complete(error.isNotEmpty()?failure(error):object({{"shared",success},{"cancelled",!success}}));
        };
       #if JUCE_IOS || JUCE_ANDROID
        safe->audioSharer=juce::ContentSharer::shareFilesScoped(juce::Array<juce::URL>{juce::URL(file)},std::move(finish),safe);
       #else
        safe->exporter=std::make_unique<juce::FileChooser>("Save audio",juce::File::getSpecialLocation(juce::File::userDocumentsDirectory).getChildFile(file.getFileName()),"*"+file.getFileExtension());
        safe->exporter->launchAsync(juce::FileBrowserComponent::saveMode|juce::FileBrowserComponent::canSelectFiles|juce::FileBrowserComponent::warnAboutOverwriting,[safe,file,finish](const auto& chooser)mutable{
            if(!safe)return;const auto destination=chooser.getResult();if(destination==juce::File{}){finish(false,{});return;}
            safe->mediaWorker.addJob([safe,file,destination,finish]()mutable{const bool copied=file.copyFileTo(destination)&&file.getSize()==destination.getSize();juce::MessageManager::callAsync([safe,copied,finish]()mutable{if(safe)finish(copied,copied?juce::String{}:juce::String("Cannot save the complete audio file"));});});
        });
       #endif
    },true);
}

void MobileWebEditor::storageTask(std::function<juce::var()> action,juce::WebBrowserComponent::NativeFunctionCompletion complete,bool media){
    juce::Component::SafePointer<MobileWebEditor> safe(this);
    const auto cancel=cancelled;
    (media?mediaWorker:storageWorker).addJob([safe,cancel,media,action=std::move(action),complete=std::move(complete)]{
        if(media&&cancel->load())return;
        juce::var result;
        try{result=bridgeResult(action());}catch(const std::exception& error){result=failure(error.what());}
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
        // Keep existing query parameters in the address when sending raw JSON.
        // inPostData is required by Android to enable its output stream.
        auto url=juce::URL::createWithoutParsing(request["url"].toString());
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
        auto stream=url.createInputStream(juce::URL::InputStreamOptions(method=="POST"?juce::URL::ParameterHandling::inPostData:juce::URL::ParameterHandling::inAddress)
            .withConnectionTimeoutMs(15000).withHttpRequestCmd(method.isEmpty()?"GET":method).withExtraHeaders(headers)
            .withStatusCode(&status).withResponseHeaders(&responseHeaders));
       #endif
        juce::var result;
        juce::Logger::outputDebugString("Plugin catalog response HTTP "+juce::String(status));
        if(!stream)result=failure("Catalog connection failed");
        else {
            juce::MemoryBlock body;stream->readIntoMemoryBlock(body,12*1024*1024);
            auto fields=std::make_unique<juce::DynamicObject>();
            for(int i=0;i<responseHeaders.size();++i){
                const auto key=responseHeaders.getAllKeys()[i];
                // HttpURLConnection includes its status line under a null key;
                // JUCE surfaces that as an empty header, invalid in JS Headers.
                if(key.isNotEmpty())fields->setProperty(juce::Identifier(key),responseHeaders.getAllValues()[i]);
            }
             result=bridgeResult(object({{"status",status},{"headers",juce::var(fields.release())},{"data",juce::String::fromUTF8((const char*)body.getData(),(int)body.getSize())}}));
        }
        juce::MessageManager::callAsync([safe,complete=std::move(complete),result]{if(safe)complete(result);});
    });
}

juce::var MobileWebEditor::audio(const juce::var& message) {
    const auto command=message["cmd"].toString();
    if(command!="snapshot"&&command!="position"&&engine.backgroundPlayback.load()&&uiStateIsStale())return true;
    if(command=="load") {
        if(nativePadInput)nativePadInput->setSource(0,{});
        engine.setNativeQueue(message["queue"]);
        sourceId=(int)message["sourceId"];sourceUrl=message["url"].toString();announced=false;pendingLoad=true;
       #if JUCE_ANDROID
        engine.androidBridgeSourceId.store(0);
       #endif
        lastPosition=(double)message["startAt"];previousPlaying=false;
        const auto queue=message["queue"];const auto tracks=queue["tracks"];const int index=(int)queue["index"];
        const auto id=tracks.isArray()&&index>=0&&index<tracks.size()?tracks[index]["id"].toString():juce::String{};
        if(sourceUrl.isNotEmpty())engine.loadRemote(sourceUrl,lastPosition,id);
        else {
            const auto previous=engine.unloadSong();pendingLoad=false;
            if(nativePadInput)nativePadInput->setSource(sourceId,{});
           #if JUCE_ANDROID
            engine.androidBridgeSourceId.store(sourceId);
           #endif
            return object({{"previousCues",previous}});
        }
        if(nativePadInput)nativePadInput->setSource(sourceId,id);
       #if JUCE_ANDROID
        engine.androidBridgeSourceId.store(sourceId);
       #endif
    } else if(command=="navigate") {
        const auto action=message["action"].toString();const bool accepted=action=="next"?engine.performRemoteAction(CueProcessor::RemoteAction::next):action=="previous"?engine.performRemoteAction(CueProcessor::RemoteAction::previous):engine.navigateTo((int)message["index"],message["autoplay"].isVoid()||bool(message["autoplay"]));return object({{"accepted",accepted}});
    } else if(command=="play") {engine.requestedPlay.store(true);engine.playIntentRevision.fetch_add(1);if(engine.ready.load())engine.submit({CueProcessor::Action::play});}
    else if(command=="pause") {engine.requestedPlay.store(false);engine.playIntentRevision.fetch_add(1);engine.submit({CueProcessor::Action::pause});}
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
        return snapshot;
    }
    else if(command=="volume") {
        auto* parameter=engine.parameters.getParameter("gain");const auto target=(float)message["value"];if(std::abs(parameter->getValue()-target)>0.00001f)parameter->setValueNotifyingHost(target);
    } else if(command=="muted")engine.muted.store((bool)message["value"]);
    else if(command=="rate") {
        if(engine.songPlaybackEnabled.load()&&message["trackId"].isString()){
            engine.setTrackPlayback(message["trackId"].toString(),object({{"speed",((double)message["value"]-1)*100},
                {"speedMode",message["preservePitch"].isVoid()||(bool)message["preservePitch"]?"speed":"pitch"},{"tuning",message["semitones"]}}));
            return object({});
        }
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

bool MobileWebEditor::uiStateIsStale() const {return engine.remoteTransportRevision.load()!=previousRemoteRevision||engine.nativeTrackRevision.load()!=previousTrackRevision;}
void MobileWebEditor::timerCallback() {
    // Native playback/Now Playing continues independently while the app is
    // backgrounded. Reconcile the latest revisions when its WebView returns.
    if(engine.backgroundPlayback.load())return;
    if(nativePadInput){
        nativePadInput->poll();const auto state=nativePadInput->state();const auto encoded=juce::JSON::toString(state,true);
        if(encoded!=previousPadInputState){previousPadInputState=encoded;browser.emitEventIfBrowserIsVisible("pluginPadInputState",state);}
    }
    if(previousSampleRevision!=engine.padSampleRevision().load()){
        previousSampleRevision=engine.padSampleRevision().load();browser.emitEventIfBrowserIsVisible("pluginPadSamples",engine.padSamples());
    }
   #if JUCE_ANDROID
    const auto generation=engine.androidAudioGeneration(),bridgeSource=engine.androidBridgeSourceId.load(),insets=androidInsetsRevision();
    // Timing counters do not need a 60 Hz round trip through the WebView.
    // Source/layout changes still reach the native touch map on the next tick.
    if(timerTicks%6==0||generation!=previousAndroidGeneration||bridgeSource!=previousAndroidSource||insets!=previousAndroidInsets){
        previousAndroidGeneration=generation;previousAndroidSource=bridgeSource;previousAndroidInsets=insets;
        const auto platform=androidPlatformState();const auto encodedPlatform=juce::JSON::toString(platform,true);
        if(encodedPlatform!=previousAndroidPlatform){previousAndroidPlatform=encodedPlatform;browser.emitEventIfBrowserIsVisible("pluginAndroidPlatform",platform);}
    }
   #endif
    previousRemoteRevision=engine.remoteTransportRevision.load();
    if(previousRestoreRevision!=engine.restoreRevision.load()){
        previousRestoreRevision=engine.restoreRevision.load();announced=false;pendingLoad=false;
        if(engine.editorWidth.load()>0&&engine.editorHeight.load()>0)setSize(engine.editorWidth.load(),engine.editorHeight.load());
        if(nativePadInput)nativePadInput->invalidateLayout();browser.refresh();return;
    }
    if(previousTrackRevision!=engine.nativeTrackRevision.load()){
        previousTrackRevision=engine.nativeTrackRevision.load();announced=false;pendingLoad=true;lastRevision=-1;emit("track",engine.nativeSnapshot());
    }
    if(lastRevision!=engine.cueRevision.load()){lastRevision=engine.cueRevision.load();browser.emitEventIfBrowserIsVisible("pluginCues",engine.getWebCues());}
    juce::Array<juce::var> padEvents;
    for(int index=0;index<160;++index){
        const auto state=engine.padStates[(size_t)index].load(std::memory_order_relaxed), previous=previousPads[(size_t)index];
        const auto midi=engine.midiPadHits[(size_t)index].load(std::memory_order_relaxed);if(state==previous&&midi==previousMidiPads[(size_t)index])continue;
        padEvents.add(object({{"bank",juce::String::charToString((juce::juce_wchar)('A'+index/16))},{"pad",index%16+1},
            {"pressed",(state&1u)!=0},{"heldChanged",(state&1u)!=(previous&1u)},{"triggered",(state>>1)!=(previous>>1)},
            {"velocity",engine.padVelocities[(size_t)index].load(std::memory_order_relaxed)},{"lastTriggered",engine.lastTriggeredPad.load()==index},{"midiTriggered",midi!=previousMidiPads[(size_t)index]},{"lastMidiTriggered",engine.lastMidiPad.load()==index}}));
        previousPads[(size_t)index]=state;
        previousMidiPads[(size_t)index]=midi;
    }
    if(!padEvents.isEmpty())browser.emitEventIfBrowserIsVisible("pluginPads",juce::var(padEvents));
    if(++timerTicks%6!=0)return; // 60 Hz pad feedback, 10 Hz playhead/metadata.
    const auto parameters=object({{"speed",std::round((engine.parameters.getRawParameterValue("speed")->load()-1.0f)*100.0f)},{"volume",engine.parameters.getRawParameterValue("gain")->load()},
        {"speedMode",engine.preservePitch.load()?"speed":"pitch"},{"tuning",engine.semitones.load()}});
    if(engine.songPlaybackEnabled.load()){parameters.getDynamicObject()->setProperty("trackId",engine.nativeSnapshot()["trackId"]);parameters.getDynamicObject()->setProperty("playbackReady",!engine.nativeAdvancing.load());}
    const auto encoded=juce::JSON::toString(parameters,true);
    if(encoded!=previousParameters){previousParameters=encoded;browser.emitEventIfBrowserIsVisible("pluginParameters",parameters);}
    if(previousErrorRevision!=engine.nativeErrorRevision.load()){
        previousErrorRevision=engine.nativeErrorRevision.load();pendingLoad=false;announced=false;emit("error",object({{"message",engine.getStatus()}}));
    }
    const bool isReady=engine.ready.load(), isPlaying=engine.playing.load();
    if(pendingLoad&&isReady&&!announced) {announced=true;pendingLoad=false;emit("ready",object({{"duration",engine.getDuration()}}));}
    if(isPlaying!=previousPlaying){emit(isPlaying?"playing":"pause",object({}));previousPlaying=isPlaying;}
    const auto at=engine.playhead.load();
    if(announced){const auto clock=engine.nativeSnapshot();emit("time",object({{"position",at},{"duration",engine.getDuration()},{"buffered",engine.getDuration()},{"rate",clock["rate"]},{"advancing",isPlaying&&!(bool)clock["buffering"]}}));
        if(engine.nativeEnded.exchange(false)){engine.requestedPlay.store(false);emit("ended",object({}));}}
    if(pendingLoad){const auto status=engine.getStatus();if(status.containsIgnoreCase("failed")||status.containsIgnoreCase("cannot")||status.containsIgnoreCase("cancelled")||status.containsIgnoreCase("missing")||status.containsIgnoreCase("unavailable")){pendingLoad=false;emit("error",object({{"message",status}}));}}
    lastPosition=at;
}
