// Simulator-only integration of the real UIKit observer, WKWebView and engine.
// Injected UITouch objects are not a measurement of hardware touch latency.
#include "WebEditor.h"
#import <UIKit/UIKit.h>
#import <UIKit/UIGestureRecognizerSubclass.h>
#import <WebKit/WebKit.h>
#import <PhotosUI/PhotosUI.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include <iostream>

@interface BeatmakerFixtureTouch : UITouch {
@public UIView* target;CGPoint point;NSTimeInterval time;
}
@end
@implementation BeatmakerFixtureTouch
-(UIView*)view{return target;}
-(NSTimeInterval)timestamp{return time;}
-(CGPoint)locationInView:(UIView*)view{return [target convertPoint:point toView:view];}
@end

// Use the real NSItemProvider path without requiring access to the simulator's Photos library.
@interface BeatmakerFixturePhotoResult : NSObject {
@public NSItemProvider* provider;
}
-(NSItemProvider*)itemProvider;
@end
@implementation BeatmakerFixturePhotoResult
-(NSItemProvider*)itemProvider{return provider;}
@end

namespace {
UIActivityViewController* findShareController(UIViewController* controller){
    if([controller isKindOfClass:[UIActivityViewController class]])return (UIActivityViewController*)controller;
    for(UIViewController* child in controller.childViewControllers)if(auto* found=findShareController(child))return found;
    return controller.presentedViewController?findShareController(controller.presentedViewController):nil;
}
UIActivityViewController* currentShareController(){
    for(UIScene* scene in [UIApplication sharedApplication].connectedScenes)if([scene isKindOfClass:[UIWindowScene class]])
        for(UIWindow* window in ((UIWindowScene*)scene).windows)if(auto* found=findShareController(window.rootViewController))return found;
    return nil;
}
WKWebView* webView(juce::Component& component){
    id view=(id)juce::AccessibilityHandler::getNativeChildForComponent(component);
    if([view isKindOfClass:[WKWebView class]])return (WKWebView*)view;
    for(auto* child:component.getChildren())if(auto* found=webView(*child))return found;
    return nil;
}
PHPickerViewController* findGalleryController(UIViewController* controller){if([controller isKindOfClass:PHPickerViewController.class])return (PHPickerViewController*)controller;for(UIViewController* child in controller.childViewControllers)if(auto* found=findGalleryController(child))return found;return controller.presentedViewController?findGalleryController(controller.presentedViewController):nil;}
PHPickerViewController* currentGalleryController(){for(UIScene* scene in [UIApplication sharedApplication].connectedScenes)if([scene isKindOfClass:UIWindowScene.class])for(UIWindow* window in ((UIWindowScene*)scene).windows)if(auto* found=findGalleryController(window.rootViewController))return found;return nil;}
UIDocumentPickerViewController* findFilesController(UIViewController* controller){
    if([controller isKindOfClass:UIDocumentPickerViewController.class])return (UIDocumentPickerViewController*)controller;
    for(UIViewController* child in controller.childViewControllers)if(auto* found=findFilesController(child))return found;
    return controller.presentedViewController?findFilesController(controller.presentedViewController):nil;
}
UIDocumentPickerViewController* currentFilesController(){
    for(UIScene* scene in [UIApplication sharedApplication].connectedScenes)if([scene isKindOfClass:UIWindowScene.class])
        for(UIWindow* window in ((UIWindowScene*)scene).windows)if(auto* found=findFilesController(window.rootViewController))return found;
    return nil;
}
class InputFixture final:public juce::JUCEApplication,private juce::Timer {
public:
    const juce::String getApplicationName() override{return "Beatmaker Input Tests";}
    const juce::String getApplicationVersion() override{return JucePlugin_VersionString;}
    void initialise(const juce::String&) override {
        const auto root=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("NativeInputFixture",{});root.createDirectory();
        setenv("BEATMAKER_PLUGIN_DATA_DIR",root.getFullPathName().toRawUTF8(),1);setenv("BEATMAKER_AUDIO_CACHE_DIR",root.getChildFile("AudioCache").getFullPathName().toRawUTF8(),1);setenv("BEATMAKER_SHARED_LIBRARY_DIR","",1);
        processor=std::make_unique<CueProcessor>();processor->prepareToPlay(48000,128);
        editor=std::make_unique<MobileWebEditor>(*processor,true);
        window=std::make_unique<juce::DocumentWindow>(getApplicationName(),juce::Colours::black,0);
        window->setContentNonOwned(editor.get(),false);window->setUsingNativeTitleBar(true);window->setFullScreen(true);window->setVisible(true);
        startTimer(1500);
    }
    void shutdown() override {window.reset();editor.reset();processor.reset();}
private:
    std::unique_ptr<CueProcessor> processor;std::unique_ptr<MobileWebEditor> editor;std::unique_ptr<juce::DocumentWindow> window;
    juce::AudioBuffer<float> output{2,128};juce::MidiBuffer midi;bool passed=true;
    void pump(int milliseconds){const auto end=juce::Time::getMillisecondCounterHiRes()+milliseconds;while(juce::Time::getMillisecondCounterHiRes()<end){CFRunLoopRunInMode(kCFRunLoopDefaultMode,.005,true);processor->processBlock(output,midi);}}
    juce::var evaluate(const juce::String& script){juce::var result;bool done=false;editor->evaluate(script,[&](auto value){if(value.getResult())result=*value.getResult();done=true;});for(int i=0;i<100&&!done;++i)pump(20);return result;}
    juce::var diagnostics(){evaluate("window.__padDiagnostics=null;window.__pluginInvoke('padTouchDiagnostics').then(value=>window.__padDiagnostics=value);true");for(int i=0;i<100;++i){pump(10);const auto value=evaluate("JSON.stringify(window.__padDiagnostics)").toString();if(value!="null"&&!value.isEmpty())return juce::JSON::parse(value);}return {};}
    void check(bool value,const char* message){if(!value){passed=false;std::cerr<<"FAIL: "<<message<<"\n";}}
    bool waitFor(const juce::String& script){
        for(int i=0;i<150;++i){if((bool)evaluate(script))return true;pump(20);}
        return false;
    }
    void clickText(const juce::String& selector,const juce::String& label){
        evaluate("[...document.querySelectorAll("+juce::JSON::toString(selector)+")].find(node=>node.textContent.trim()==="+juce::JSON::toString(label)+")?.click();true");
    }
    void checkGuardedHistory(){
        const auto folder=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("LibraryUndoFixture",{});
        LibraryStore store(folder);
        const auto initial=store.commitLibrary(store.readLibrary(),R"({"favorites":[],"history":[],"playlists":[{"id":"first-list","name":"Target","tracks":[{"id":"loc00000001","title":"Local"}]},{"id":"second-list","name":"Neighbor","tracks":[]}]})");
        const auto external=store.commitLibrary(initial,R"({"favorites":[],"history":[],"playlists":[{"id":"first-list","name":"Target","tracks":[{"id":"loc00000001","title":"Local"}]},{"id":"second-list","name":"Renamed elsewhere","tracks":[]}]})");
        juce::String before;
        const auto after=store.commitLibrary(initial,R"({"favorites":[],"history":[],"playlists":[{"id":"second-list","name":"Neighbor","tracks":[]}]})",&before);
        check(before==external,"Undo captured a stale baseline instead of the native commit's previous library");
        const auto changed=store.commitLibrary(after,R"({"favorites":[],"history":[{"id":"latest00001"}],"playlists":[{"id":"added-list","name":"Newer list","tracks":[]},{"id":"second-list","name":"Newest rename","tracks":[]}]})");
        const auto restored=juce::JSON::parse(store.commitLibrary(after,before,nullptr,true));
        check(restored["history"].size()==1&&restored["playlists"].size()==3&&
            restored["playlists"][0]["id"].toString()=="added-list"&&restored["playlists"][1]["id"].toString()=="first-list"&&
            restored["playlists"][2]["name"].toString()=="Newest rename","Undo did not preserve unrelated and newer library edits");
        check(store.commitLibrary(before,after,nullptr,true)==changed,"Redo did not remove just the original playlist");
        const auto back=store.commitLibrary(after,before,nullptr,true);
        auto conflict=juce::JSON::parse(back);conflict["playlists"][1].getDynamicObject()->setProperty("name","Edited after restore");
        const auto current=store.commitLibrary(back,juce::JSON::toString(conflict));
        bool rejected=false;
        try{store.commitLibrary(before,after,nullptr,true);}catch(const std::exception&){rejected=true;}
        check(rejected&&store.readLibrary()==current,"A stale redo clobbered a newer change to the same playlist");
        store.commitLibrary(current,changed);
        store.eraseLocalMedia("loc00000001",{});
        const auto erased=store.readLibrary();
        rejected=false;
        try{store.commitLibrary(after,before,nullptr,true);}catch(const std::exception&){rejected=true;}
        check(rejected&&store.readLibrary()==erased,"Undo restored an intentionally erased audio reference");
    }
    void checkCatalogPagination(){
        const auto* resource=[[NSBundle mainBundle] pathForResource:@"catalog-search" ofType:@"mjs"];
        if(!resource){check(false,"iOS catalog fixture resource is missing");return;}
        const auto script=juce::File(juce::String::fromUTF8([resource UTF8String])).loadFileAsString()
            .replace("export function catalogFixture","function catalogFixture");
        check((bool)evaluate("(()=>{"+script+R"js(
            const backend=window.__JUCE__.backend, emit=backend.emitEvent;
            backend.emitEvent=function(event,payload){
                if(event==='__juce__invoke'&&payload.name==='http'){
                    const {url,data}=payload.params[0];
                    const result={status:200,headers:{},data:JSON.stringify(catalogFixture({url,body:data}))};
                    queueMicrotask(()=>backend.emitByBackend('__juce__complete',JSON.stringify({promiseId:payload.resultId,result})));
                }else emit.call(backend,event,payload);
            };
            const search=document.querySelector('#search-input');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,'fixture');
            search.dispatchEvent(new Event('input',{bubbles:true}));
            search.form.requestSubmit();
            return true;
        })())js"),"Could not inject the deterministic catalog HTTP fixture");
        const juce::String tabNames[]={"Songs","Videos","Albums"},kinds[]={"song","video","album"};
        for(int i=0;i<3;++i){
            clickText("main [role=tab]",tabNames[i]);
            const auto title=juce::JSON::toString("Fixture "+kinds[i]+" 3");
            check(waitFor("[...document.querySelectorAll('main button')].some(b=>b.textContent.trim()==='Show more')"),
                "Continued YouTube Music results were unavailable in native iOS Search");
            clickText("main button","Show more");
            check(waitFor("[...document.querySelectorAll('main .track-title, main a span')].some(n=>n.textContent.trim()==="+title+")"),
                "Native iOS Search did not append the next page");
        }
        // Clear the query before checking the placeholder in another language.
        evaluate("document.querySelector('main button[aria-label=\"Clear search\"]')?.click();document.activeElement?.blur();true");
    }
    void checkPlaylistCover(const juce::File& directory){
        const auto file=directory.getChildFile("cover-photo.png");
        const auto photo=juce::Image(juce::Image::RGB,1100,750,true);
        juce::Graphics graphics(photo);
        graphics.fillAll(juce::Colours::navy);
        graphics.setColour(juce::Colours::orange);
        graphics.fillRect(90,0,780,450);
        {auto output=file.createOutputStream();if(!output||!juce::PNGImageFormat{}.writeImageToStream(photo,*output)){
            check(false,"Could not write the cover image fixture");return;
        }}
        const auto openMenu=[&]{
            evaluate("document.querySelector('.playlist-cover-edit')?.click();true");
            return waitFor("Boolean(document.querySelector('[role=dialog][aria-label=\"Edit playlist cover\"]'))");
        };
        check(openMenu(),"The playlist cover did not open its edit menu");
        clickText("[role=dialog] button","Choose from Photos");
        for(int i=0;i<150&&!currentGalleryController();++i)pump(20);
        auto* picker=currentGalleryController();
        check(picker!=nil,"Playlist covers did not open the native Photos picker");
        if(picker)[picker.delegate picker:picker didFinishPicking:@[]];
        check(waitFor("!document.querySelector('[role=dialog]')"),"Cancelling Photos did not close the cover menu");
        check((bool)evaluate("!window.__pluginStores.library.getState().playlists.find(p=>p.id===window.__libraryFixtureId)?.cover"),
            "Cancelling Photos changed the playlist cover");

        check(openMenu(),"Could not reopen the cover menu for Files");
        clickText("[role=dialog] button","Choose from Files");
        for(int i=0;i<150&&!currentFilesController();++i)pump(20);
        auto* documents=currentFilesController();
        check(documents&&!documents.allowsMultipleSelection,"Playlist cover did not open a single-file picker");
        if(documents)[documents.delegate documentPicker:documents didPickDocumentsAtURLs:@[[NSURL fileURLWithPath:[NSString stringWithUTF8String:file.getFullPathName().toRawUTF8()]]]];
        check(waitFor("document.querySelector('.playlist-cover-edit img[src^=\"data:image/jpeg;base64,\"]')?.naturalWidth===640"),
            "The chosen file did not become a downsampled JPEG cover in WKWebView");
        const auto library=juce::JSON::parse(processor->libraryStore.readLibrary());
        bool persisted=false;
        for(const auto& row:*library["playlists"].getArray())if(row["id"].toString()==evaluate("window.__libraryFixtureId").toString()){
            const auto cover=row["cover"].toString();
            persisted=cover.startsWith("data:image/jpeg;base64,/9j/")&&cover.length()<175000&&row["tracks"].size()==1;
        }
        check(persisted,"Re-encoded cover was not saved durably alongside the original tracks");
        const auto firstCover=evaluate("document.querySelector('.playlist-cover-edit img').src").toString();
        graphics.fillAll(juce::Colours::red);
        auto picked=directory.getChildFile("cover-photo-replacement.png");
        {auto output=picked.createOutputStream();if(!output||!juce::PNGImageFormat{}.writeImageToStream(photo,*output)){
            check(false,"Could not write the Photos replacement fixture");return;
        }}
        check(waitFor("!document.querySelector('[role=dialog]')")&&openMenu(),"Could not reopen the cover menu for Photos replacement");
        clickText("[role=dialog] button","Choose from Photos");
        // The old Files controller can finish its dismissal asynchronously.
        for(int i=0;i<150&&!currentGalleryController();++i)pump(20);
        if(auto* photos=currentGalleryController()){
            auto* photoResult=[[[BeatmakerFixturePhotoResult alloc] init] autorelease];
            photoResult->provider=[[[NSItemProvider alloc] initWithContentsOfURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:picked.getFullPathName().toRawUTF8()]]] autorelease];
            [photos.delegate picker:photos didFinishPicking:(NSArray<PHPickerResult*>*)@[photoResult]];
            check(waitFor("(()=>{const image=document.querySelector('.playlist-cover-edit img');return image?.naturalWidth===640&&image.src!=="+juce::JSON::toString(firstCover)+";})()"),
                "Photos did not replace the playlist's Files cover");
        }else check(false,"Native Photos picker did not reopen for cover replacement");
        check(waitFor("!document.querySelector('[role=dialog]')")&&openMenu(),"Could not reopen the saved cover menu");
        clickText("[role=dialog] button","Use automatic cover");
        check(waitFor("!document.querySelector('.playlist-cover-edit img[src^=\"data:image/jpeg;base64,\"]')&&!document.querySelector('[role=dialog]')"),
            "Removing a custom cover did not restore the automatic one");
        evaluate("document.querySelector('main button[aria-label=\"Undo edit\"]')?.click();true");
        check(waitFor("document.querySelector('.playlist-cover-edit img[src^=\"data:image/jpeg;base64,\"]')?.naturalWidth===640"),
            "Undo did not safely restore the saved image");
    }
    void checkPlaylistTools(const juce::File& file){
        checkGuardedHistory();
        evaluate("window.__libraryFixtureId=null;window.__pluginStores.library.getState().createPlaylist('Files fixture').then(p=>window.__libraryFixtureId=p?.id);true");
        check(waitFor("Boolean(window.__libraryFixtureId&&document.querySelector('main a[href=\"/playlist/'+window.__libraryFixtureId+'\"]'))"),"iOS playlist tools fixture failed to create its playlist");
        evaluate("document.querySelector('main a[href=\"/playlist/'+window.__libraryFixtureId+'\"]')?.click();true");
        check(waitFor("Boolean(document.querySelector('.collection-add-tracks'))"),"The playlist did not expose Add tracks");
        evaluate("document.querySelector('.collection-add-tracks')?.click();true");
        const auto openFiles=[&]{
            clickText("[role=dialog] button",juce::String::fromUTF8("Import audio files…"));
            for(int i=0;i<150&&!currentFilesController();++i)pump(20);
            auto* picker=currentFilesController();
            check(picker&&picker.allowsMultipleSelection,"Playlist import did not open the native multi-file picker");
            return picker;
        };
        const auto initialMedia=processor->libraryStore.allMedia().size();
        if(auto* picker=openFiles())[picker.delegate documentPickerWasCancelled:picker];
        for(int i=0;i<100&&currentFilesController();++i)pump(20);
        check(waitFor("!document.querySelector('[role=dialog] [role=status]')")&&processor->libraryStore.allMedia().size()==initialMedia,
            "Cancel imported audio or left the playlist picker busy");
        if(auto* picker=openFiles())
            [picker.delegate documentPicker:picker didPickDocumentsAtURLs:@[[NSURL fileURLWithPath:[NSString stringWithUTF8String:file.getFullPathName().toRawUTF8()]]]];
        check(waitFor("window.__pluginStores.library.getState().playlists.find(p=>p.id===window.__libraryFixtureId)?.tracks.length===1"),
            "Selected file was not added to the intended playlist");
        const auto track=juce::JSON::parse(evaluate("JSON.stringify(window.__pluginStores.library.getState().playlists.find(p=>p.id===window.__libraryFixtureId)?.tracks[0]||{})").toString());
        const auto audioPath=processor->libraryStore.media(track["id"].toString())["path"].toString();
        if(audioPath.isEmpty()){check(false,"Playlist import did not retain a managed audio file");return;}
        const juce::File audioFile(audioPath);
        check(audioFile.existsAsFile()&&processor->libraryStore.allMedia().size()==initialMedia+1,
            "Playlist import did not preserve exactly one retained copy");
        check((bool)evaluate("!window.__pluginStores.library.getState().playlists.find(p=>p.name==='Imports')?.tracks.some(track=>track.id===window.__pluginStores.library.getState().playlists.find(p=>p.id===window.__libraryFixtureId)?.tracks[0]?.id)"),
            "Playlist import was wrongly added to Imports");
        check(waitFor("!document.querySelector('[role=dialog]')"),"Successful file import did not close its dialog");
        evaluate("document.querySelector('main .track-row button')?.click();true");
        check(waitFor("window.__pluginStores.player.getState().status==='playing'"),"Imported playlist file did not play through the native engine");
        evaluate("document.querySelector('.mini-player button')?.click();true");
        check(waitFor("document.querySelector('[aria-label=\"Now playing\"]')?.textContent.includes('Playing from: Files fixture')"),
            "Native Now Playing did not show the original playlist");
        check((bool)evaluate("getComputedStyle(document.querySelector('[aria-label=\"Now playing\"] a[href^=\"/playlist/\"]')).textDecorationLine==='none'"),
            "The playlist source in Now Playing still has an underline");
        evaluate("document.querySelector('[aria-label=\"Now playing\"] button[aria-label=Close]')?.click();true");
        waitFor("!document.querySelector('[role=dialog]')");
        evaluate("document.querySelector('main button[aria-label=\"Undo edit\"]')?.click();true");
        check(waitFor("window.__pluginStores.library.getState().playlists.find(p=>p.id===window.__libraryFixtureId)?.tracks.length===0")&&audioFile.existsAsFile(),
            "Undo did not remove only the playlist entry and keep its audio");
        evaluate("document.querySelector('main button[aria-label=\"Redo edit\"]')?.click();true");
        check(waitFor("window.__pluginStores.library.getState().playlists.find(p=>p.id===window.__libraryFixtureId)?.tracks.length===1"),
            "Redo did not restore the track with the same retained id");
        checkPlaylistCover(audioFile.getParentDirectory());
        clickText("main button","Back");
        check(waitFor("location.pathname==='/library'")&&
            (bool)evaluate("!(/Playing from:|Current playlist|Library health/.test(document.querySelector('main').textContent))"),
            "The Library still displays playback source or health controls");
        check(waitFor(R"js((()=>{
            const label=document.querySelector('main a[href="/playlist/'+window.__libraryFixtureId+'"] .playlist-playing-label');
            if(label?.textContent.trim()!=='Playing')return false;
            const count=label.previousElementSibling,title=label.parentElement.previousElementSibling,style=getComputedStyle(label);
            const l=label.getBoundingClientRect(),c=count.getBoundingClientRect(),n=title.getBoundingClientRect();
            const probe=document.createElement('span');probe.style.color='var(--accent-text)';label.append(probe);
            const accent=getComputedStyle(probe).color;probe.remove();
            return style.color===accent&&getComputedStyle(title).color===accent&&style.backgroundColor==='rgba(0, 0, 0, 0)'
                &&count.textContent.trim()==='1 track'&&l.top>=n.bottom-1&&l.left>=c.right&&Math.abs(l.bottom-c.bottom)<=4;
        })())js"),"Playing must use the app accent next to the track count, below the playlist name");
        evaluate("document.querySelector('.mini-player button')?.click();true");
        check(waitFor("document.querySelector('[aria-label=\"Now playing\"]')?.textContent.includes('Playing from: Files fixture')"),
            "Now Playing lost its playlist source after returning to Library");
        check(waitFor(R"js((()=>{const sheet=document.querySelector('.native-now-playing-docked'),nav=document.querySelector('nav.playback-tabbar');if(!sheet||!nav)return false;const a=sheet.getBoundingClientRect(),b=nav.getBoundingClientRect();return Math.abs(a.bottom-b.top)<=1&&a.top<=1&&a.left<=1&&a.right>=innerWidth-1&&getComputedStyle(sheet).backgroundColor===getComputedStyle(nav).backgroundColor;})())js"),
            "Now Playing did not meet the opaque iOS tab bar");
        evaluate("document.querySelector('[aria-label=\"Now playing\"] button[aria-label=Close]')?.click();true");
        waitFor("!document.querySelector('[role=dialog]')");
        const auto held=audioFile.getSiblingFile(audioFile.getFileName()+".fixture-hold");
        const bool moved=audioFile.moveFileTo(held);
        evaluate("window.__mediaUnavailable=false;window.__pluginInvoke('localAudioStatus').then(status=>window.__mediaUnavailable=status.tracks.some(t=>t.id==="+
            juce::JSON::toString(track["id"])+"&&!t.available));true");
        const bool detected=waitFor("window.__mediaUnavailable");
        const bool returned=moved&&held.moveFileTo(audioFile);
        check(moved&&detected&&returned,"The media picker did not detect unavailable local audio");

        evaluate("document.querySelector('nav a[href=\"/cues\"]')?.click();true");
        check(waitFor("document.querySelector('a.cue-track-label')?.getAttribute('href')==='/playlist/'+window.__libraryFixtureId"),
            "The Cues song title did not link to its own playlist");
        evaluate("document.querySelector('a.cue-track-label')?.click();true");
        check(waitFor("location.pathname==='/playlist/'+window.__libraryFixtureId&&window.__pluginStores.player.getState().status==='playing'"),
            "The Cues song title did not open the playlist while continuing playback");

        evaluate("void (async()=>{const {library,player}=window.__pluginStores;const rows=Array.from({length:139},(_,i)=>({id:'test-'+String(i).padStart(6,'0'),title:'Dummy '+i,artist:'Fixture',duration:30,kind:'song',thumb:'',art:''}));"
            "rows.push("+juce::JSON::toString(track)+");const p=await library.getState().createPlaylist('Scroll fixture',rows);"
            "for(let i=0;i<14;i++)await library.getState().createPlaylist('Other list '+i);"
            "window.__scrollFixtureId=p.id;player.getState().playList(p.tracks,139,{kind:'playlist',id:p.id});})();true");
        check(waitFor("Boolean(window.__scrollFixtureId&&window.__pluginStores.player.getState().index===139&&window.__pluginStores.player.getState().status==='playing')"),
            "Could not select a deep row to test playlist scroll");
        const juce::String trackInView=R"js((()=>{if(location.pathname!=='/playlist/'+window.__scrollFixtureId)return false;const main=document.querySelector('main'), row=main.querySelector('.track-row[data-index="139"]'), player=document.querySelector('.mini-player');if(!row||!player||main.scrollTop<100)return false;const r=row.getBoundingClientRect(),header=main.querySelector('header.sticky')?.offsetHeight??0;return r.top>=main.getBoundingClientRect().top+header-1&&r.bottom<=player.getBoundingClientRect().top+1;})())js";
        evaluate("document.querySelector('.mini-player button')?.click();true");
        check(waitFor("Boolean(document.querySelector('[role=dialog] a[href=\"/playlist/'+window.__scrollFixtureId+'\"]'))"),"Now Playing lost the deep playlist's source");
        evaluate("document.querySelector('[role=dialog] a[href=\"/playlist/'+window.__scrollFixtureId+'\"]')?.click();true");
        check(waitFor(trackInView),"Native Now Playing did not scroll to the actual playlist row");
        check(waitFor("!document.querySelector('[role=dialog]')"),"Now Playing did not close on navigation");
        evaluate("document.querySelector('nav a[href=\"/cues\"]')?.click();true");
        check(waitFor("document.querySelector('a.cue-track-label')?.getAttribute('href')==='/playlist/'+window.__scrollFixtureId"),"Cues lost the deep playlist's source");
        evaluate("if(!document.querySelector('.cue-song-list'))document.querySelector('.cue-queue-toggle')?.click();true");
        check(waitFor(R"js((()=>{const list=document.querySelector('.cue-song-list'),row=list?.querySelector('.track-row[data-index="139"]');if(!list?.scrollTop||!row)return false;const a=list.getBoundingClientRect(),b=row.getBoundingClientRect();return b.top>=a.top-1&&b.bottom<=a.bottom+1;})())js"),
            "Opening the Cues playlist panel did not reveal the playing row");
        evaluate("document.querySelector('.cue-queue-toggle')?.click();true");
        evaluate("document.querySelector('a.cue-track-label')?.click();true");
        check(waitFor(trackInView),"Native Cues did not scroll to the actual playlist row");

        clickText("main button","Back");
        check(waitFor(R"js((()=>{
            if(location.pathname!=='/library')return false;
            const main=document.querySelector('main'),card=main.querySelector('a[href="/playlist/'+window.__scrollFixtureId+'"]');
            if(!card||main.scrollTop<100)return false;
            const r=card.getBoundingClientRect(),header=main.querySelector('header.sticky').getBoundingClientRect();
            return r.top>=header.bottom-1&&r.bottom<=document.querySelector('.mini-player').getBoundingClientRect().top+1;
        })())js"),"Back from the playing playlist did not reveal its Library card");
        evaluate("document.querySelector('main a[href=\"/playlist/'+window.__scrollFixtureId+'\"]')?.click();true");
        check(waitFor(trackInView),"Entering the playing playlist from Library did not reveal the current song");

        evaluate("window.__pluginStores.player.getState().playList(["+juce::JSON::toString(track)+"],0,{kind:'radio'});document.querySelector('.mini-player button')?.click();true");
        check(waitFor("Boolean(document.querySelector('[role=dialog] a[href=\"/radio\"]'))"),"Now Playing did not link to its radio lineup");
        check((bool)evaluate("getComputedStyle(document.querySelector('[role=dialog] a[href=\"/radio\"]')).textDecorationLine==='none'"),
            "The radio source link still has an underline");
        evaluate("document.querySelector('[role=dialog] a[href=\"/radio\"]')?.click();true");
        check(waitFor("location.pathname==='/radio'&&Boolean(document.querySelector('main .track-row'))"),"The radio link did not open the active radio tracks");
        clickText("main button","Save as playlist");
        check(waitFor("Boolean(document.querySelector('[aria-label=\"Save as playlist\"] input'))"),"Radio did not offer a named playlist copy");
        clickText("[role=dialog] button","Save");
        check(waitFor("location.pathname.startsWith('/playlist/')&&window.__pluginStores.library.getState().playlists.some(list=>location.pathname==='/playlist/'+list.id&&list.name.startsWith('Radio')&&list.tracks.length===1)")&&
            (bool)evaluate("window.__pluginStores.player.getState().source.kind==='radio'"),"Saving radio did not create a separate playlist while keeping its queue");
        evaluate("window.dispatchEvent(new Event('plugin-preferences-changed'));true");pump(120);
        const auto savedPlayer=juce::JSON::parse(juce::JSON::parse(processor->sessionUiState())["musike:player"].toString());
        check(savedPlayer["source"]["kind"].toString()=="radio"&&savedPlayer["queue"][(int)savedPlayer["index"]]["id"].toString()==track["id"].toString(),
            "The native session snapshot did not keep the last song's radio origin for a restart");

        evaluate("document.querySelector('nav a[href=\"/search\"]')?.click();true");
        check(waitFor("Boolean(document.querySelector('#search-input'))"),"Could not open iOS Search for placeholder verification");
        checkCatalogPagination();
        evaluate("document.querySelector('main button[aria-label=Settings]')?.click();true");
        check(waitFor("Boolean(document.querySelector('[role=dialog] [lang=fr]'))"),"Could not open the language controls for Search");
        evaluate("document.querySelector('[role=dialog] [lang=fr]')?.closest('button')?.click();true");
        check(waitFor(R"js((()=>{const el=document.querySelector('#search-input');if(!el?.placeholder.endsWith('YouTube')||document.documentElement.lang!=='fr')return false;const style=getComputedStyle(el),ctx=document.createElement('canvas').getContext('2d');ctx.font=`${style.fontSize} ${style.fontFamily}`;const available=el.getBoundingClientRect().width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-parseFloat(style.borderLeftWidth)-parseFloat(style.borderRightWidth);return available>=ctx.measureText(el.placeholder).width;})())js"),
            "The French Search placeholder is clipped in iOS WebKit");
        if(passed)std::cout<<"PASS: iPhone theme accent and active playlist navigation, flush Now Playing, durable covers via native Photos and Files pickers, radio save, Search pagination, safe undo/redo and French search hint\n"<<std::flush;
    }
    juce::var pointForPad(int pad){return juce::JSON::parse(evaluate("JSON.stringify((()=>{const r=document.querySelector('.cue-pad[data-pad-number=\""+juce::String(pad)+"\"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})())").toString());}
    void choosePreset(const juce::String& preset){evaluate("(()=>{const select=document.querySelector('[aria-label=\"Pad layout preset\"]');select.value="+juce::JSON::toString(preset)+";select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");pump(200);}
    void chooseOrder(const juce::String& order){
        evaluate("document.querySelector('.cue-midi-settings').click();true");pump(100);
        check((int)diagnostics()["mappedPads"]==0,"MIDI settings did not invalidate native pad regions");
        evaluate("(()=>{const select=document.querySelector('[aria-label=\"Pad numbering\"]');if(!select)return false;select.value="+juce::JSON::toString(order)+";select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");pump(50);
        evaluate("document.querySelector('[role=\"dialog\"] button[aria-label=\"Close\"]').click();true");
        for(int i=0;i<100&&(bool)evaluate("Boolean(document.querySelector('[role=\"dialog\"]'))");++i)pump(20);
        for(int i=0;i<100&&(int)diagnostics()["mappedPads"]==0;++i)pump(20);
        check((int)diagnostics()["mappedPads"]>0,"Closing MIDI settings did not restore the native pad map");
    }
    void pointer(UIGestureRecognizer* observer,WKWebView* web,const juce::var& point,int pad,bool compatibilityClick=true,double webClockOffset=0,bool repeatNativeBegan=false){
        auto* touch=[BeatmakerFixtureTouch new];touch->target=web;touch->point=CGPointMake((double)point["x"],(double)point["y"]);touch->time=[[NSProcessInfo processInfo] systemUptime];
        const double epoch=juce::Time::currentTimeMillis();const auto before=processor->padStates[(size_t)pad-1].load()>>1;const int accepted=processor->nativePadInputAccepted.load();
        [observer touchesBegan:[NSSet setWithObject:touch] withEvent:nil];processor->processBlock(output,midi);
        if(repeatNativeBegan){[observer touchesBegan:[NSSet setWithObject:touch] withEvent:nil];processor->processBlock(output,midi);}
        check(processor->nativePadInputAccepted.load()==accepted+1&&(processor->padStates[(size_t)pad-1].load()>>1)==before+1,"UIKit touch did not queue/render before JavaScript");
        evaluate("(()=>{const button=document.querySelectorAll('.cue-pad')["+juce::String(pad-1)+"];for(const type of ['pointerdown','pointerup']){const event=new PointerEvent(type,{pointerId:1,pointerType:'touch',button:0,bubbles:true});Object.defineProperty(event,'timeStamp',{value:"+juce::String(epoch+webClockOffset,3)+"-performance.timeOrigin});button.dispatchEvent(event);}if(window.__pluginIOSPreview&&"+juce::String(compatibilityClick?"true":"false")+")for(let i=0;i<3;i++)button.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:0}));return true;})()");pump(150);
        [observer touchesEnded:[NSSet setWithObject:touch] withEvent:nil];[touch release];
        check((processor->padStates[(size_t)pad-1].load()>>1)==before+1,"UIKit/WebKit reconciliation duplicated the native hit");
        processor->submit({CueProcessor::Action::pause});processor->processBlock(output,midi);
    }
    void timerCallback() override {
        stopTimer();
        for(int i=0;i<100&&!(bool)evaluate("Boolean(window.__pluginStores&&document.querySelector('a[href=\"/cues\"]'))");++i)pump(50);
        const BOOL originalBounce=[webView(*editor).scrollView bounces];
        const auto file=juce::File(juce::String::fromUTF8([[[NSBundle mainBundle] pathForResource:@"tone" ofType:@"m4a"] UTF8String]));const auto track=processor->importLocalFile(file);
        evaluate("window.__pluginStores.player.setState({repeat:'one'});window.__pluginStores.player.getState().playList(["+juce::JSON::toString(track)+"]);document.querySelector('a[href=\"/cues\"]')?.click();true");
        for(int i=0;i<100&&!(bool)evaluate("Boolean(window.__musikeAudioEl?.readyState>0&&document.querySelector('.cue-pad'))");++i)pump(50);
        evaluate("window.__pluginStores.cues.getState().setCue(1,.125);true");pump(250);
        auto* web=webView(*editor);UIGestureRecognizer* observer=nil;
        for(UIGestureRecognizer* candidate in [web gestureRecognizers])if([candidate isKindOfClass:NSClassFromString(@"BeatmakerPadTouchObserver")])observer=candidate;
        check(web&&observer,"UIKit observer is not attached to the correct WKWebView");
        const auto state=diagnostics();check((bool)state["supported"]&&(int)state["mappedPads"]==1,"UIKit native map is not ready");
        if(observer){
            check(!observer.cancelsTouchesInView&&!observer.delaysTouchesBegan&&!observer.delaysTouchesEnded,"UIKit observer delays/consumes ordinary WebKit touches");
            if((bool)evaluate("window.__pluginIOSPreview===true"))check(!web.scrollView.bounces,"Cues page bounce was not disabled");
            pointer(observer,web,pointForPad(1),1);
            check((int)diagnostics()["claimed"]==1,"UIKit event epoch did not match the WebKit receipt");
            if((bool)evaluate("window.__pluginIOSPreview===true")){
                for(const auto& preset:juce::StringArray{"linear16","legacy12"}){
                    choosePreset(preset);
                    for(const auto& order:juce::StringArray{"top-left","bottom-left"}){
                        chooseOrder(order);const auto first=pointForPad(1),last=pointForPad(preset=="legacy12"?12:16);
                        evaluate("window.__pluginStores.cues.getState().setCue(1,.125);true");pump(150);
                        check((double)first["x"]<(double)last["x"]&&(order=="bottom-left"?(double)first["y"]>(double)last["y"]:(double)first["y"]<(double)last["y"]),"Numbering origin did not match actual WKWebView pad positions");
                        const int claimed=diagnostics()["claimed"];pointer(observer,web,first,1);
                        check((int)diagnostics()["claimed"]==claimed+1,"Reordered UIKit pad did not claim exactly one logical-pad hit");
                    }
                }
                for(const auto& preset:juce::StringArray{"sp404mkii-a","sp404mkii-b"}){
                    choosePreset(preset);const auto first=pointForPad(1),last=pointForPad(16);
                    check((double)first["y"]<(double)last["y"],"SP-404 pad order changed with a saved alternate origin");
                }
                choosePreset("linear16");
                check(evaluate("document.querySelector('.cue-pad-grid').dataset.padOrder").toString()=="bottom-left","16-pad origin was not restored after switching presets");
                evaluate("document.querySelector('.cue-midi-settings').click();true");pump(100);
                evaluate("(()=>{document.querySelector('[role=\"switch\"][aria-label=\"MIDI velocity\"]').click();const select=document.querySelector('[aria-label=\"Bank buttons\"]');select.value='paired';select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");pump(150);
                check(!processor->midiVelocityEnabled.load(),"iOS MIDI velocity control did not reach the native renderer");
                check(evaluate("localStorage.getItem('musike:midi:velocity')").toString()=="off","iOS velocity choice was not retained in session storage");
                evaluate("document.querySelector('[role=\"dialog\"] button[aria-label=\"Close\"]').click();true");
                for(int i=0;i<100&&(bool)evaluate("Boolean(document.querySelector('[role=\"dialog\"]'))");++i)pump(20);
                evaluate("document.querySelector('.cue-bank-pair').click();true");pump(150);
                check(processor->selectedBank.load()==5,"iOS A/F button did not select native bank F");
                evaluate("document.querySelector('.cue-bank-pair').click();true");pump(150);
                check(processor->selectedBank.load()==0,"iOS A/F button did not return to native bank A");
             }
             const auto second=processor->importLocalFile(file);
             evaluate("window.__pluginStores.player.getState().setSpeed(25);window.__pluginStores.player.getState().setSpeedMode('speed');window.__pluginStores.player.getState().setTuning(4);true");pump(150);
             check((double)processor->nativeSnapshot()["playback"]["speed"]==25&&processor->preservePitch.load()&&processor->semitones.load()==4,"iOS speed/mode/tuning edit did not reach native song settings");
             evaluate("window.__pluginStores.player.getState().playList(["+juce::JSON::toString(track)+","+juce::JSON::toString(second)+"]);window.__pluginStores.player.getState().jumpTo(1);true");
             for(int i=0;i<100;++i){pump(30);if(processor->ready.load()&&processor->nativeSnapshot()["trackId"].toString()==second["id"].toString())break;}
             check((double)processor->nativeSnapshot()["playback"]["speed"]==0&&!processor->preservePitch.load()&&processor->semitones.load()==0,"A new iOS song did not default to neutral Pitch");
             check(waitFor("document.querySelector('button[aria-label=\"Pitch (varispeed)\"]')?.getAttribute('aria-pressed')==='true'"),"iOS Cues did not show the Pitch fader by default");
             evaluate("window.__pluginStores.player.getState().jumpTo(0);true");
             for(int i=0;i<100;++i){pump(30);if(processor->ready.load()&&processor->nativeSnapshot()["trackId"].toString()==track["id"].toString())break;}
             check((double)processor->nativeSnapshot()["playback"]["speed"]==25&&processor->preservePitch.load()&&processor->semitones.load()==4,"Returning to an iOS song did not recall its native controls");
             evaluate("window.__pluginStores.player.getState().setSpeed(0);window.__pluginStores.player.getState().setTuning(0);true");pump(100);
            const int beforeSampleClaim=diagnostics()["claimed"];
            processor->importPadSample(0,0,file);evaluate("window.__musikeAudioEl.removeAttribute('src');true");pump(300);
            pointer(observer,web,pointForPad(1),1);check((int)diagnostics()["claimed"]==beforeSampleClaim+1,"Sample-only UIKit input did not claim its native receipt");
            if((bool)evaluate("window.__pluginIOSPreview===true")){
                evaluate("document.querySelector('.cue-fine-toggle').click();true");pump(150);
                check((int)diagnostics()["mappedPads"]>0,"Fine waveform mode disabled pad playback");
                const int fineClaimed=diagnostics()["claimed"];pointer(observer,web,pointForPad(1),1);
                check((int)diagnostics()["claimed"]==fineClaimed+1,"Fine-mode pad plus zero-detail compatibility click did not reconcile one native hit");
                check(processor->padSamples()[0]["peaks"].size()==256,"Ready sample did not include an immediate waveform overview");
                check((bool)evaluate("(()=>{const canvas=document.querySelector('.cue-fine-waveform canvas'),pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;return pixels.some((value,index)=>index%4===3&&value>0);})()"),"Native Fine selection showed an empty waveform despite resident sample audio");
                check((bool)evaluate("(()=>{const marker=document.querySelector('.cue-fine-marker'),probe=document.createElement('span');probe.style.color='var(--accent)';marker.parentElement.append(probe);const matches=getComputedStyle(marker).backgroundColor===getComputedStyle(probe).color&&getComputedStyle(marker).width==='1.5px'&&getComputedStyle(marker,'::before').content==='none';probe.remove();return matches;})()"),"Native zoom marker did not use the thinner accent-coloured line");
                evaluate("window.__sampleStartUpdated=null;window.__pluginInvoke('padSample',{cmd:'start',bank:'A',pad:1,start:.1}).then(pads=>window.__sampleStartUpdated=pads[0].start);true");
                for(int i=0;i<100&&!(bool)evaluate("window.__sampleStartUpdated===.1");++i)pump(20);
                check(std::abs((double)processor->padSamples()[0]["start"]-.1)<1e-6,"iOS sample-start edit did not reach native/persisted sample state");
                evaluate("window.__regionPeaks=0;window.__pluginInvoke('waveformRegion',{sample:true,bank:'A',pad:1,from:.08,to:.12,bins:256}).then(data=>window.__regionPeaks=data.peaks.length);true");
                for(int i=0;i<100&&(int)evaluate("window.__regionPeaks")!=256;++i)pump(20);
                check((int)evaluate("window.__regionPeaks")==256,"iOS fine waveform did not receive native zoomed PCM peaks");
                evaluate("document.querySelector('.cue-fine-toggle').click();true");pump(200);
                evaluate("window.__historyPlaylistSaved=false;window.__pluginStores.api.createPlaylist('Native undo fixture',[]).then(()=>window.__historyPlaylistSaved=true);true");
                for(int i=0;i<100&&!(bool)evaluate("window.__historyPlaylistSaved");++i)pump(20);
                const auto hasPlaylist=[&]{const auto value=juce::JSON::parse(processor->libraryStore.readLibrary());if(const auto* list=value["playlists"].getArray())for(const auto& playlist:*list)if(playlist["name"].toString()=="Native undo fixture")return true;return false;};
                check(hasPlaylist(),"Native library edit did not commit before undo");
                evaluate("document.querySelector('button[aria-label=\"Undo edit\"]').click();true");for(int i=0;i<100&&hasPlaylist();++i)pump(20);
                check(!hasPlaylist(),"Shared history did not undo the native playlist edit");
                evaluate("document.querySelector('button[aria-label=\"Redo edit\"]').click();true");for(int i=0;i<100&&!hasPlaylist();++i)pump(20);
                check(hasPlaylist(),"Shared history did not redo the native playlist edit");
                evaluate("window.__pluginStores.player.getState().playList(["+juce::JSON::toString(track)+"]);window.__pluginStores.cues.getState().setCue(3,.125);true");
                for(int i=0;i<100&&!(bool)evaluate("window.__musikeAudioEl.readyState>0");++i)pump(25);pump(150);
                evaluate("document.querySelector('.cue-fine-toggle').click();true");pump(100);
                midi.addEvent(juce::MidiMessage::noteOn(1,38,(juce::uint8)127),0);midi.addEvent(juce::MidiMessage::noteOff(1,38),1);processor->processBlock(output,midi);pump(150);
                check((bool)evaluate("document.querySelector('.cue-fine-tools')?.textContent.includes('A3')"),"A quick MIDI cue tap/release did not select the zoomed cue");
                midi.addEvent(juce::MidiMessage::noteOn(1,36,(juce::uint8)127),0);midi.addEvent(juce::MidiMessage::noteOff(1,36),1);processor->processBlock(output,midi);pump(150);
                check((bool)evaluate("document.querySelector('.cue-fine-tools')?.textContent.includes('A1')"),"MIDI sample-pad selection did not update the zoomed sample waveform");
                evaluate("document.querySelector('.cue-fine-toggle').click();true");pump(100);
                auto* held=[BeatmakerFixtureTouch new];held->target=web;const auto heldPoint=pointForPad(3);held->point=CGPointMake((double)heldPoint["x"],(double)heldPoint["y"]);held->time=[[NSProcessInfo processInfo] systemUptime];
                const double heldEpoch=juce::Time::currentTimeMillis();[observer touchesBegan:[NSSet setWithObject:held] withEvent:nil];processor->processBlock(output,midi);
                // A synthetic held pointer also exercises capture-unavailable reconciliation.
                evaluate("(()=>{const button=document.querySelector('.cue-pad[data-pad-number=\"3\"]');const event=new PointerEvent('pointerdown',{pointerId:99,pointerType:'touch',button:0,bubbles:true});Object.defineProperty(event,'timeStamp',{value:"+juce::String(heldEpoch,3)+"-performance.timeOrigin});button.dispatchEvent(event);return true;})()");pump(100);
                const auto drumHits=processor->padStates[0].load()>>1;for(int i=0;i<3;++i)pointer(observer,web,pointForPad(1),1,false,-2500,true);
                check((processor->padStates[0].load()>>1)==drumHits+3,"Holding a cue while tapping a sample produced extra drum triggers");
                evaluate("document.querySelector('.cue-pad[data-pad-number=\"3\"]').dispatchEvent(new PointerEvent('pointerup',{pointerId:99,pointerType:'touch',button:0,bubbles:true}));true");
                [observer touchesEnded:[NSSet setWithObject:held] withEvent:nil];[held release];pump(100);
                evaluate("(()=>{const button=document.querySelector('.cue-pad[data-pad-number=\"1\"]');for(let i=0;i<9;i++)button.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:0}));return true;})()");pump(100);
                check((processor->padStates[0].load()>>1)==drumHits+3,"Delayed multi-touch compatibility clicks retriggered the drum pad");
                evaluate("window.__pluginStores.cues.getState().setCue(3,.125);document.querySelector('.cue-fine-toggle').click();true");pump(100);
                pointer(observer,web,pointForPad(3),3);
                const auto savedCue=processor->getCue(0,2);
                evaluate("(()=>{window.__fixtureCueCommands=0;const send=window.__pluginAudioBridge.postMessage;window.__pluginAudioBridge.postMessage=message=>{if(message.cmd==='cue')window.__fixtureCueCommands++;return send(message);};return true;})()");
                const auto waveformPointer=[&](const juce::String& type,double fraction){evaluate("(()=>{const node=document.querySelector('.cue-fine-waveform'),r=node.getBoundingClientRect();window.__liveTarget=Number(node.dataset.windowFrom)+(Number(node.dataset.windowTo)-Number(node.dataset.windowFrom))*"+juce::String(fraction,3)+";node.dispatchEvent(new PointerEvent("+juce::JSON::toString(type)+",{pointerId:71,pointerType:'touch',button:0,clientX:r.x+r.width*"+juce::String(fraction,3)+",clientY:r.y+r.height/2,bubbles:true}));return true;})()");};
                waveformPointer("pointerdown",.6);pump(50);
                check(!processor->playing.load()&&(int)evaluate("window.__fixtureCueCommands")==0&&processor->getCue(0,2)==savedCue,"Default unheld zoom dragging auditioned audio or committed before release");
                waveformPointer("pointerup",.6);pump(100);
                check((int)evaluate("window.__fixtureCueCommands")==0&&std::abs(processor->getCue(0,2)-(double)evaluate("window.__liveTarget"))<.001,"Silent zoom edit did not commit without sounding");
                evaluate("window.__pluginStores.cues.getState().setCue(3,.125);true");pump(100);
                midi.addEvent(juce::MidiMessage::noteOn(1,38,(juce::uint8)127),0);processor->processBlock(output,midi);midi.clear();pump(150);
                waveformPointer("pointerdown",.2);pump(50);
                check((int)evaluate("window.__fixtureCueCommands")>0&&processor->playing.load()&&std::abs(processor->getCue(0,2)-.125)<.001,"Holding the selected MIDI pad did not enable live zoom audition");
                midi.addEvent(juce::MidiMessage::noteOff(1,38),0);processor->processBlock(output,midi);midi.clear();pump(150);
                const int releasedCommands=evaluate("window.__fixtureCueCommands");waveformPointer("pointermove",.1);pump(50);waveformPointer("pointerup",.1);pump(100);
                check((int)evaluate("window.__fixtureCueCommands")==releasedCommands,"Zoom audition continued after MIDI pad release");
                check(std::abs(processor->getCue(0,2)-(double)evaluate("window.__liveTarget"))<.001,"Post-release silent drag did not save its new marker");
                evaluate("document.querySelector('button[aria-label=\"Settings\"]').click();true");pump(100);
                check(!(bool)evaluate("document.querySelector('[role=\"switch\"][aria-label=\"Always audition while dragging\"]').getAttribute('aria-checked')==='true'"),"Always-audition setting was enabled by default");
                evaluate("document.querySelector('[role=\"switch\"][aria-label=\"Always audition while dragging\"]').click();document.querySelector('[role=\"dialog\"] button[aria-label=\"Close\"]').click();true");pump(150);
                check(juce::JSON::parse(processor->getWebState())["musike:waveform:drag-audition"].toString()=="always","Always-audition preference did not reach native session storage");
                const int optionalCommands=evaluate("window.__fixtureCueCommands");waveformPointer("pointerdown",.25);pump(50);waveformPointer("pointerup",.25);pump(100);
                check((int)evaluate("window.__fixtureCueCommands")>optionalCommands,"Optional always-audition did not sound an unheld zoom drag");
                evaluate("document.querySelector('button[aria-label=\"Settings\"]').click();true");pump(100);
                evaluate("document.querySelector('[role=\"switch\"][aria-label=\"Always audition while dragging\"]').click();document.querySelector('[role=\"dialog\"] button[aria-label=\"Close\"]').click();true");pump(150);
                evaluate("document.querySelector('.cue-fine-toggle').click();true");pump(100);
                const auto fixedFirst=pointForPad(1);
                evaluate("(()=>{const b=document.querySelector('.cue-pad[data-pad-number=\"1\"]'),r=b.getBoundingClientRect();b.dispatchEvent(new PointerEvent('pointerdown',{pointerId:72,pointerType:'touch',button:0,clientX:r.x+r.width/2,clientY:r.y+r.height/2,bubbles:true}));return true;})()");pump(3100);
                check((bool)evaluate("document.querySelector('.cue-pad-grid').dataset.arranging==='true'"),"Native UI did not enter content-move mode");
                evaluate("(()=>{const b=document.querySelector('.cue-pad[data-pad-number=\"1\"]'),r=document.querySelector('.cue-pad[data-pad-number=\"4\"]').getBoundingClientRect();for(const type of ['pointermove','pointerup'])b.dispatchEvent(new PointerEvent(type,{pointerId:72,pointerType:'touch',button:0,clientX:r.x+r.width/2,clientY:r.y+r.height/2,bubbles:true}));return true;})()");
                for(int i=0;i<100&&!(bool)evaluate("(()=>{const b=document.querySelector('.cue-pad[data-pad-number=\"4\"]');return b.dataset.padKind==='sample'&&!b.disabled;})()");++i)pump(20);
                const auto stillFirst=pointForPad(1);
                check(!processor->hasPadSample(0,0)&&processor->hasPadSample(0,3)&&std::abs((double)stillFirst["x"]-(double)fixedFirst["x"])<1&&std::abs((double)stillFirst["y"]-(double)fixedFirst["y"])<1,"Moving a sample changed the numbered pad position or lost its native assignment");
                evaluate("document.querySelector('button[aria-label=\"Finish rearranging pads\"]').click();document.querySelector('button[aria-label=\"Undo edit\"]').click();true");
                for(int i=0;i<100&&!processor->hasPadSample(0,0);++i)pump(20);
                check(processor->hasPadSample(0,0)&&!processor->hasPadSample(0,3),"Native content move did not undo");
                chooseOrder("top-left");
                const int relabelled=(int)evaluate("Number(document.elementFromPoint("+juce::String((double)fixedFirst["x"],3)+","+juce::String((double)fixedFirst["y"],3)+").closest('.cue-pad').dataset.padNumber)")-1;
                check(relabelled>=0&&processor->hasPadSample(0,relabelled),"Native numbering change moved the already placed sample instead of relabelling its position");
                chooseOrder("bottom-left");check(processor->hasPadSample(0,0),"Inverse numbering change did not retain sample position/assignment");
                evaluate("document.querySelector('.cue-song-import').click();true");pump(100);
                check((int)diagnostics()["mappedPads"]==0,"Media dialog did not disable native performance regions");
                check((bool)evaluate("!Array.from(document.querySelectorAll('[role=\"dialog\"] button')).some(button=>button.textContent==='Chop current song'||button.textContent==='Library songs & videos')&&!!document.querySelector('button[aria-label=\"Import gallery video\"]')"),"Import audio did not use the requested gallery-only media source menu");
                evaluate("document.querySelector('[role=\"dialog\"] button[aria-label=\"Close\"]').click();true");pump(350);
                evaluate("document.querySelector('.cue-sample-edit').click();true");pump(100);evaluate("document.querySelector('.cue-pad[data-pad-number=\"2\"]').click();true");pump(100);
                evaluate("Array.from(document.querySelectorAll('[role=\"dialog\"] button')).find(button=>button.textContent.startsWith('Chop current song')).click();true");pump(350);
                for(int i=0;i<200&&!(bool)evaluate("Boolean(document.querySelector('[aria-label=\"Chop source waveform\"]'))");++i)pump(20);
                check((bool)evaluate("Boolean(document.querySelector('[aria-label=\"Chop source waveform\"]'))"),"Native library audio did not open in the chopper");
                evaluate("(()=>{const dialog=document.querySelector('[role=\"dialog\"][aria-label=\"Chop audio\"]');const set=(name,value)=>{const select=dialog.querySelector('[aria-label=\"'+name+'\"]');select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));};set('Chop destination bank','C');set('Chop first pad','5');set('Chop slices','2');return true;})()");pump(100);
                evaluate("Array.from(document.querySelectorAll('[role=\"dialog\"] button')).find(button=>button.textContent.startsWith('Assign C5')).click();true");
                for(int i=0;i<200&&(!(processor->hasPadSample(2,4)&&processor->hasPadSample(2,5))||(bool)evaluate("Boolean(document.querySelector('[role=\"dialog\"]'))"));++i)pump(20);
                check(processor->hasPadSample(2,4)&&processor->hasPadSample(2,5)&&!(bool)evaluate("Boolean(document.querySelector('[role=\"dialog\"]'))"),"Native chopper did not commit both fixed-pad assignments and close");
                evaluate("document.querySelector('.cue-sample-edit').click();true");pump(100);
                evaluate("document.querySelector('button[aria-label=\"Undo edit\"]').click();true");
                for(int i=0;i<100&&(processor->hasPadSample(2,4)||processor->hasPadSample(2,5));++i)pump(20);
                check(!processor->hasPadSample(2,4)&&!processor->hasPadSample(2,5),"Shared Undo did not restore the native pre-chop assignments");
                check((bool)evaluate("Boolean(document.querySelector('.cue-sample-edit svg[data-icon=\"drum\"]'))"),"Sample-management button did not use a drum icon");
                check((bool)evaluate("(()=>{const a=document.querySelector('.cue-record').getBoundingClientRect(),row=document.querySelector('.cue-overwrite-row').getBoundingClientRect(),banks=document.querySelector('.cue-bankbar').getBoundingClientRect();return Math.abs(a.right-row.right)<2&&Math.abs(row.x-banks.x)<2&&Math.abs(row.width-banks.width)<2;})()"),"Recorder/control row did not align to the far-right bank-row edge");
                evaluate("document.querySelector('.cue-record').click();true");pump(100);
                check(processor->recordingMidiGuards.load()==0,"Beatmaker-playback recorder panel incorrectly blocked MIDI");
                evaluate("(()=>{const select=document.querySelector('[aria-label=\"Recording source\"]');select.value='input';select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");pump(150);
                check(processor->recordingMidiGuards.load()==1,"Microphone/USB recorder panel did not suspend native MIDI");
                processor->submit({CueProcessor::Action::pause});processor->processBlock(output,midi);const auto blockedHits=processor->padStates[0].load()>>1;const auto blockedCues=juce::JSON::toString(processor->getWebCues());
                midi.addEvent(juce::MidiMessage::noteOn(1,36,(juce::uint8)127),0);midi.addEvent(juce::MidiMessage::noteOn(1,38,(juce::uint8)127),10);processor->processBlock(output,midi);pump(100);
                check((processor->padStates[0].load()>>1)==blockedHits&&!processor->playing.load()&&juce::JSON::toString(processor->getWebCues())==blockedCues,"External-input panel allowed an SP-404 MIDI press to retrigger/mark the loaded song");
                evaluate("Array.from(document.querySelectorAll('[role=\"dialog\"] button')).find(button=>button.textContent==='Audio input & output').click();true");pump(100);
                evaluate("Array.from(document.querySelectorAll('[role=\"dialog\"] button')).find(button=>button.textContent==='Audio input & output').click();true");pump(100);
                check(processor->recordingMidiGuards.load()==1,"Closing nested routing controls prematurely released the recorder MIDI guard");
                evaluate("(()=>{const select=document.querySelector('[aria-label=\"Recording source\"]');select.value='playback';select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");pump(150);
                check(processor->recordingMidiGuards.load()==0,"Switching to Beatmaker playback did not restore MIDI");
                processor->selectedBank.store(0);midi.addEvent(juce::MidiMessage::noteOn(1,36,(juce::uint8)127),0);processor->processBlock(output,midi);
                check((processor->padStates[0].load()>>1)==blockedHits+1,"Beatmaker-playback recorder panel did not permit native sample-pad performance");
                evaluate("(()=>{const select=document.querySelector('[aria-label=\"Recording source\"]');select.value='input';select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");pump(100);
                evaluate("document.querySelector('[role=\"dialog\"] button[aria-label=\"Close\"]').click();true");pump(300);check(processor->recordingMidiGuards.load()==0,"Closing the recorder left native MIDI suspended");
                evaluate("document.querySelector('.cue-record').click();true");pump(100);check(processor->recordingMidiGuards.load()==1,"Saved external-input selection did not restore its scoped MIDI guard");
                evaluate("(()=>{const select=document.querySelector('[aria-label=\"Recording source\"]');select.value='playback';select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");pump(100);
                evaluate("Array.from(document.querySelectorAll('[role=\"dialog\"] button')).find(button=>button.textContent==='Start recording').click();true");
                for(int i=0;i<100&&!processor->recorder.hasTake();++i)pump(20);pump(250);
                check(processor->recorder.hasTake()&&(double)processor->recorder.state()["seconds"]>0,"Native recorder UI did not start/capture rendered playback");
                const auto recordedMidiHits=processor->padStates[0].load()>>1;midi.addEvent(juce::MidiMessage::noteOn(1,36,(juce::uint8)127),23);processor->processBlock(output,midi);pump(100);
                check(processor->recordingMidiGuards.load()==0&&(processor->padStates[0].load()>>1)==recordedMidiHits+1&&(bool)processor->recorder.state()["recording"],"Beatmaker-playback recording blocked MIDI pad performance or interrupted capture");
                evaluate("Array.from(document.querySelectorAll('[role=\"dialog\"] button')).find(button=>button.textContent==='Finish & play in Cues').click();true");
                for(int i=0;i<200&&(bool)evaluate("Boolean(document.querySelector('[role=\"dialog\"]'))");++i)pump(20);
                check(!(bool)evaluate("Boolean(document.querySelector('[role=\"dialog\"]'))")&&(bool)evaluate("(()=>{const library=window.__pluginStores.library.getState(),player=window.__pluginStores.player.getState(),track=player.queue[player.index];return track?.id.startsWith('loc')&&library.playlists.find(p=>p.name==='Imports')?.tracks.some(t=>t.id===track.id);})()"),"Finished native take did not automatically save to Imports and load in Cues");
                evaluate("window.__beforeEmpty=window.__pluginStores.cues.getState().trackId;window.__beforeEmptyBank=window.__pluginStores.cues.getState().bank;window.__pluginStores.cues.getState().setCue(4,.01);document.querySelector('.cue-song-import').click();true");pump(100);
                evaluate("Array.from(document.querySelectorAll('[role=\"dialog\"] button')).find(button=>button.textContent.includes('New empty track')).click();true");
                for(int i=0;i<100&&(bool)evaluate("window.__pluginStores.player.getState().queue.length>0");++i)pump(20);pump(100);
                check(!processor->ready.load()&&!processor->playing.load()&&processor->getDuration()==0&&(bool)evaluate("window.__pluginStores.cues.getState().trackId===null&&window.__musikeAudioEl.readyState===0&&Object.keys(window.__pluginStores.cues.getState().cues).length===0"),"New empty track left native song playback or cue bindings behind");
                check((bool)evaluate("JSON.parse(localStorage.getItem('musike:cues:v1'))[window.__beforeEmpty][window.__beforeEmptyBank][4]===.01"),"Native song unload erased its saved cue");
                check((bool)evaluate("Boolean(document.querySelector('[aria-label=\"Recording source\"]'))"),"Empty-track action did not open the recorder");
                evaluate("document.querySelector('[role=\"dialog\"] button[aria-label=\"Close\"]').click();window.__pluginStores.cues.getState().setBank('A');true");pump(200);
                pointer(observer,web,pointForPad(1),1);check(!processor->ready.load(),"Sample playback in the empty workspace reloaded the previous song");
                evaluate("document.querySelector('.cue-looper-edit').click();true");pump(50);evaluate("document.querySelector('.cue-pad[data-pad-number=\"16\"]').click();true");
                for(int i=0;i<100&&!processor->hasPadLooper(0,15);++i)pump(20);pump(150);check(processor->hasPadLooper(0,15),"Native looper assignment UI did not create an event-loop pad");
                evaluate("document.querySelector('.cue-looper-edit').click();true");pump(100);
                const int loopClaims=diagnostics()["claimed"];pointer(observer,web,pointForPad(16),16);pointer(observer,web,pointForPad(1),1);pointer(observer,web,pointForPad(16),16);
                check((int)diagnostics()["claimed"]==loopClaims+3,"Looper touch controls did not use one-time native receipts");
                const auto loopData=processor->looperState(true);bool recordedLoop=false;for(const auto& pad:*loopData["pads"].getArray())if(pad["bank"].toString()=="A"&&(int)pad["pad"]==16)recordedLoop=(int)pad["mode"]==PadLooper::playing&&pad["events"].size()>=1;
                check(recordedLoop,"Native control/sample touch performance did not become a playing MIDI-style pad loop");
                processor->looperAction(juce::JSON::parse(R"({"cmd":"stop","bank":"A","pad":16})"));pump(100);
                const auto sharedId=evaluate("window.__beforeEmpty").toString();const juce::File managed(processor->libraryStore.media(sharedId)["path"].toString());
                evaluate("window.__audioShareFinished=false;window.__pluginInvoke('shareAudio',{id:window.__beforeEmpty}).then(result=>{window.__audioShareResult=result;window.__audioShareFinished=true;},error=>{window.__audioShareError=error.message;window.__audioShareFinished=true;});true");
                for(int i=0;i<200&&!currentShareController()&&!(bool)evaluate("window.__audioShareFinished");++i)pump(20);
                auto* share=currentShareController();check(share!=nil,"Native audio export did not present the iOS file share sheet");
                if(share){void (^completion)(UIActivityType,BOOL,NSArray*,NSError*)=[share.completionWithItemsHandler copy];share.completionWithItemsHandler=nil;[share dismissViewControllerAnimated:NO completion:nil];if(completion)completion(nil,NO,nil,nil);[completion release];}
                for(int i=0;i<100&&!(bool)evaluate("window.__audioShareFinished");++i)pump(20);
                check((bool)evaluate("window.__audioShareResult?.cancelled===true")&&managed.existsAsFile(),"Cancelling native audio sharing failed or removed the retained original");
                for(int i=0;i<100&&currentShareController();++i)pump(20);pump(350);const int mediaBefore=processor->libraryStore.allMedia().size();
                evaluate("window.__galleryDone=false;window.__pluginInvoke('importGallery').then(value=>{window.__galleryResult=value;window.__galleryDone=true;},error=>{window.__galleryError=error.message;window.__galleryDone=true;});true");
                for(int i=0;i<500&&!currentGalleryController()&&!(bool)evaluate("window.__galleryDone");++i)pump(20);
                auto* gallery=currentGalleryController();if(!gallery)std::cerr<<"Gallery diagnostic: "<<evaluate("JSON.stringify({done:window.__galleryDone,result:window.__galleryResult,error:window.__galleryError})").toString()<<"\n";check(gallery!=nil,"Phone gallery did not present the native Photos video picker");if(gallery)[gallery.delegate picker:gallery didFinishPicking:@[]];
                for(int i=0;i<100&&!(bool)evaluate("window.__galleryDone");++i)pump(20);
                check((bool)evaluate("window.__galleryResult?.tracks?.length===0")&&processor->libraryStore.allMedia().size()==mediaBefore,"Cancelling the Photos gallery added media or failed to complete");pump(350);
            }
            evaluate("document.querySelector('button[aria-label=\"Settings\"]')?.click();true");pump(150);
            check((int)diagnostics()["mappedPads"]==0,"Modal dialog did not clear the UIKit input regions");
            evaluate("document.querySelector('[role=\"dialog\"] button[aria-label=\"Close\"]').click();true");pump(200);
            evaluate("document.querySelector('nav a[href=\"/library\"]')?.click();true");pump(200);
            if((bool)evaluate("window.__pluginIOSPreview===true"))
                check(web.scrollView.bounces==originalBounce,"Leaving Cues did not restore the browser's original bounce behavior");
            if((bool)evaluate("window.__pluginLibraryTools===true"))checkPlaylistTools(file);
        }
        std::cout<<(passed?"PASS":"FAIL")<<": iOS simulator UIKit observer/WKWebView/native audio, one-time cue/sample receipts, non-cancelling gesture and modal exclusion (injected touch, hardware latency not measured)\n"<<std::flush;
        std::exit(passed?0:1);
    }
};
}
START_JUCE_APPLICATION(InputFixture)
