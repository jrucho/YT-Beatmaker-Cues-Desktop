#include "WebEditor.h"
#if JUCE_MAC
#include <CoreFoundation/CoreFoundation.h>
#endif
#include <cstdlib>
#include <iostream>

int main(int argc,char** argv) {
    std::cout<<std::unitbuf;
    const bool sharedOffline=argc>1&&juce::String(argv[1])=="--shared-offline";
    const bool offline=sharedOffline||(argc>1&&juce::String(argv[1])=="--offline");
    const bool profilePlaylist=argc>2&&juce::String(argv[1])=="--profile-playlist";
    juce::ScopedJuceInitialiser_GUI initialise;
    const auto testData=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("beatmaker-web-test",{});
    testData.createDirectory();
   #if JUCE_WINDOWS
     _putenv_s("BEATMAKER_PLUGIN_DATA_DIR",testData.getFullPathName().toRawUTF8());
     _putenv_s("BEATMAKER_SHARED_LIBRARY_DIR",sharedOffline?testData.getChildFile("Shared").getFullPathName().toRawUTF8():"");
     _putenv_s("BEATMAKER_AUDIO_CACHE_DIR",testData.getChildFile("AudioCache").getFullPathName().toRawUTF8());
   #else
     setenv("BEATMAKER_PLUGIN_DATA_DIR",testData.getFullPathName().toRawUTF8(),1);
     setenv("BEATMAKER_SHARED_LIBRARY_DIR",sharedOffline?testData.getChildFile("Shared").getFullPathName().toRawUTF8():"",1);
     setenv("BEATMAKER_AUDIO_CACHE_DIR",testData.getChildFile("AudioCache").getFullPathName().toRawUTF8(),1);
   #endif
    struct Cleanup{juce::File file;~Cleanup(){file.deleteRecursively();}}cleanup{testData};
    CueProcessor processor;processor.prepareToPlay(48000,512);
    auto editor=std::make_unique<MobileWebEditor>(processor,offline);
    editor->addToDesktop(juce::ComponentPeer::windowIsTemporary);editor->setVisible(true);
    juce::AudioBuffer<float> output(2,512);juce::MidiBuffer midi;
    bool renderedAudio=false;
    const auto pump=[&](int milliseconds){const auto end=juce::Time::getMillisecondCounter()+milliseconds;
        while(juce::Time::getMillisecondCounter()<end){
           #if JUCE_MAC
            CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.01,true);
           #else
            juce::MessageManager::getInstance()->runDispatchLoopUntil(1);
           #endif
            processor.processBlock(output,midi);renderedAudio=renderedAudio||output.getMagnitude(0,output.getNumSamples())>0.0001f;}};
    const auto evaluate=[&](juce::String script){juce::var result;bool completed=false;
        editor->evaluate(script,[&](auto value){if(value.getResult())result=*value.getResult();else if(value.getError())std::cerr<<value.getError()->message<<"\n";completed=true;});
        for(int i=0;i<100&&!completed;++i)pump(50);return result;};
    for(int i=0;i<100;++i){pump(100);if((bool)evaluate("Boolean(window.__pluginStores)"))break;}
    // Exported stores become available before React's first commit and before
    // fonts/ResizeObserver have established virtual row measurements on CI.
    for(int i=0;i<100;++i){pump(50);if((bool)evaluate("Boolean(document.querySelector('.bm-app[data-engine-ready=\"true\"],.music-app main'))"))break;}
    if(!(bool)evaluate("Boolean(document.querySelector('.bm-app[data-engine-ready=\"true\"],.music-app main'))")){std::cerr<<"Editor UI did not mount\n";return 1;}
    evaluate("document.fonts.ready.then(()=>window.__pluginFontsReady=true);true");
    for(int i=0;i<100&&!(bool)evaluate("Boolean(window.__pluginFontsReady)");++i)pump(50);
    std::cout<<"DOM: "<<evaluate("document.body.innerText").toString()<<"\n";
    std::cout<<"Bridge: "<<evaluate("JSON.stringify({platform:Capacitor.getPlatform(),resolver:!!window.webkit?.messageHandlers?.musikeResolve,ready:window.__pluginReady})").toString()<<"\n";
    if(!(bool)evaluate("Boolean(window.__pluginStores)")){std::cerr<<"Mobile app failed to initialise\n";return 1;}
    if(profilePlaylist){
        const auto link=juce::JSON::toString(juce::String(argv[2]));
        const auto selection=argc>3?juce::JSON::toString(juce::String(argv[3])):"new URL("+link+").searchParams.get('v')";
        evaluate("window.__pluginTest={started:performance.now(),progress:[]};(async()=>{const t=window.__pluginTest,api=window.__pluginStores.api;const metadata=await api.searchPlaylists("+link+");t.metadataMs=performance.now()-t.started;const page=await api.youtubePlaylist(metadata[0].id,undefined,p=>t.progress.push({ms:performance.now()-t.started,tracks:p.tracks.length}));t.completeMs=performance.now()-t.started;t.title=page.title;t.tracks=page.tracks.length;t.truncated=page.truncated;const selected="+selection+";t.track=selected==='short'?page.tracks.find(track=>track.duration>0&&track.duration<300):page.tracks.find(track=>track.id===selected)||page.tracks[0];const warm=performance.now();await api.youtubePlaylist(metadata[0].id);t.warmMs=performance.now()-warm;t.done=true;})().catch(error=>window.__pluginTest.error=String(error));true");
        const auto deadline=juce::Time::getMillisecondCounterHiRes()+90000;
        while(juce::Time::getMillisecondCounterHiRes()<deadline&&!(bool)evaluate("Boolean(window.__pluginTest.done||window.__pluginTest.error)"))pump(100);
        std::cout<<"Live WebView playlist: "<<evaluate("JSON.stringify(window.__pluginTest)").toString()<<"\n";
        if(!(bool)evaluate("Boolean(window.__pluginTest.done)"))return 1;
        for(const auto* label:{"cold","warm"}){
            const int before=processor.loadDiagnostics()["generation"];
            const int errorBefore=processor.nativeErrorRevision.load();
            const auto started=juce::Time::getMillisecondCounterHiRes();
            evaluate("window.__pluginStores.player.setState({repeat:'one',autoRadio:false});window.__pluginStores.player.getState().playList([window.__pluginTest.track]);true");
            bool audible=false;
            const auto audioDeadline=started+90000;
            while(juce::Time::getMillisecondCounterHiRes()<audioDeadline&&!audible&&processor.nativeErrorRevision.load()==errorBefore){pump(100);audible=processor.ready.load()&&(int)processor.loadDiagnostics()["generation"]!=before&&output.getMagnitude(0,output.getNumSamples())>0.0001f;}
            std::cout<<"Live "<<label<<" song: "<<juce::JSON::toString(processor.loadDiagnostics(),true)<<" resolver: "<<evaluate("JSON.stringify(window.__pluginLastResolution||{})").toString()<<" observedMs: "<<juce::Time::getMillisecondCounterHiRes()-started<<"\n";
            if(!audible){std::cerr<<"Playlist song did not render: "<<processor.getStatus()<<"\n";return 1;}
        }
        const double duration=processor.getDuration();
        for(const double target:{duration*0.5,juce::jmax(0.0,duration-15),1.0}){
            const auto started=juce::Time::getMillisecondCounterHiRes();
            processor.submit({CueProcessor::Action::cue,0,0,target});
            bool arrived=false;
            for(int i=0;i<1000&&!arrived;++i){pump(5);arrived=processor.playhead.load()>target+0.001&&processor.playhead.load()<target+3&&!(bool)processor.loadDiagnostics()["buffering"]&&output.getMagnitude(0,output.getNumSamples())>0.0001f;}
            std::cout<<"Live cue target "<<target<<"s observedMs "<<juce::Time::getMillisecondCounterHiRes()-started<<" profile "<<juce::JSON::toString(processor.loadDiagnostics(),true)<<"\n";
            if(!arrived){std::cerr<<"Live late/mid/start cue did not resume at the requested position: "<<processor.getStatus()<<"\n";return 1;}
        }
        juce::MemoryBlock recalledState;processor.getStateInformation(recalledState);
        const double savedPosition=processor.playhead.load();
        CueProcessor recalled;recalled.prepareToPlay(48000,512);recalled.setStateInformation(recalledState.getData(),(int)recalledState.getSize());
        juce::AudioBuffer<float> recalledAudio(2,512);juce::MidiBuffer recalledMidi;
        for(int i=0;i<1000&&!recalled.ready.load();++i){pump(5);recalled.processBlock(recalledAudio,recalledMidi);}
        if(!recalled.ready.load()||std::abs(recalled.getDuration()-duration)>0.01||std::abs(recalled.playhead.load()-savedPosition)>0.001){std::cerr<<"Long-song host recall lost duration or saved position\n";return 1;}
        recalled.submit({CueProcessor::Action::play});recalled.processBlock(recalledAudio,recalledMidi);
        if(recalledAudio.getMagnitude(0,512)<=0.0001f){std::cerr<<"Recalled long song did not produce host-bus audio\n";return 1;}
        std::cout<<"PASS: live playlist, cold/warm native song playback, mid/late/start cues and long-song host-state recall (device output latency excluded)\n";
        return 0;
    }
    if(offline){
        const auto track=processor.importLocalFile(juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a"));
        evaluate("window.__pluginTest={};window.__pluginStores.player.setState({repeat:'one'});window.__pluginStores.player.getState().playList(["+juce::JSON::toString(track)+"]);true");
        for(int i=0;i<200&&!renderedAudio;++i)pump(50);
        if(!renderedAudio){std::cerr<<"Offline WebView produced no native host-bus audio: "<<processor.getStatus()<<"\n";return 1;}
        for(int i=0;i<100&&!(bool)evaluate("Boolean(window.__musikeAudioEl?.readyState>0&&window.__pluginStores.player.getState().status!=='loading')");++i)pump(50);
        if(!(bool)evaluate("Boolean(window.__musikeAudioEl?.readyState>0&&window.__pluginStores.player.getState().status!=='loading')")){std::cerr<<"Native audio rendered but the WebView did not reconcile ready state\n";return 1;}
        evaluate("window.__pluginStores.cues.getState().setCue(1,0.125);window.__pluginStores.player.getState().cue(0.125,{bank:'A',pad:1});true");pump(200);
        if(processor.getCue(0,0)!=0.125||(processor.padStates[0].load()>>1)==0){std::cerr<<"Offline cue bridge did not reach native renderer\n";return 1;}
        auto second=processor.importLocalFile(juce::File(BEATMAKER_TEST_FIXTURES).getChildFile("tone.m4a"));second.getDynamicObject()->setProperty("title","Background second track");
        evaluate("window.__pluginStores.player.setState({repeat:'one',autoRadio:false});window.__pluginStores.player.getState().playList(["+juce::JSON::toString(track)+","+juce::JSON::toString(second)+"]);true");
        for(int i=0;i<100&&!processor.ready.load();++i)pump(25);pump(200);
        processor.backgroundPlayback.store(true);
        if(!processor.performRemoteAction(CueProcessor::RemoteAction::next)){std::cerr<<"Background native Next was rejected\n";return 1;}
        for(int i=0;i<200;++i){pump(25);if(processor.ready.load()&&processor.nativeSnapshot()["trackId"].toString()==second["id"].toString())break;}
        if(!processor.ready.load()||processor.nativeSnapshot()["trackId"].toString()!=second["id"].toString()){std::cerr<<"Background queue advance depended on WebView event delivery\n";return 1;}
        processor.backgroundPlayback.store(false);
        for(int i=0;i<100;++i){pump(25);if(evaluate("window.__pluginStores.player.getState().queue[window.__pluginStores.player.getState().index]?.id").toString()==second["id"].toString())break;}
        if(evaluate("window.__pluginStores.player.getState().queue[window.__pluginStores.player.getState().index]?.id").toString()!=second["id"].toString()){std::cerr<<"Foreground WebView did not reconcile native background navigation\n";return 1;}
        std::cout<<"PASS: background native navigation with WebView events suspended; foreground player reconciliation\n";
        evaluate("window.__pluginStores.player.getState().playList(["+juce::JSON::toString(track)+"]);true");pump(300);
        evaluate("window.__pluginStores.cues.getState().setCue(1,0.125);window.__pluginStores.player.getState().cue(0.125,{bank:'A',pad:1});true");pump(200);
        evaluate("(async()=>{const t=window.__pluginTest;t.kernel=await window.__pluginInvoke('effectKernel',{type:'twelveBit'});try{await window.__pluginInvoke('effectKernel',{type:'reverb'});}catch(error){t.kernelRejected=error.message.includes('not implemented');}await window.__pluginInvoke('effectKernel',{type:'none'});t.kernelReady=true;})().catch(error=>window.__pluginTest.kernelError=String(error));true");
        for(int i=0;i<100&&!(bool)evaluate("window.__pluginTest.kernelReady||false");++i)pump(50);
        if(!(bool)evaluate("Boolean(window.__pluginTest.kernelReady&&window.__pluginTest.kernel.type==='twelveBit'&&window.__pluginTest.kernelRejected)")){std::cerr<<"Native effect-kernel bridge/unsupported-feature validation failed\n";return 1;}
        std::cout<<"PASS: native kernel bridge configures DSP and rejects unported effects explicitly\n";
        evaluate("(async()=>{const t=window.__pluginTest;t.graph=await window.__pluginInvoke('fxGraph',{enabled:true,multi:true,effects:['delay','isolator','centerCancel','duckComp'],x:0.3,y:0.7});try{await window.__pluginInvoke('fxGraph',{effects:['none','none','none','reverb']});}catch(error){t.graphRejected=error.message.includes('not implemented');}await window.__pluginInvoke('fxGraph',{enabled:false});t.graphReady=true;})().catch(error=>window.__pluginTest.graphError=String(error));true");
        for(int i=0;i<100&&!(bool)evaluate("window.__pluginTest.graphReady||false");++i)pump(50);
        if(!(bool)evaluate("Boolean(window.__pluginTest.graphReady&&window.__pluginTest.graph.enabled&&window.__pluginTest.graph.effects.length===4&&window.__pluginTest.graphRejected)")||processor.getLatencySamples()!=0){std::cerr<<"Native four-corner FX bridge validation/bypass failed\n";return 1;}
        std::cout<<"PASS: native four-corner FX bridge, control validation and host latency reset\n";
        juce::Array<juce::var> large;
        const auto unicode=juce::String::fromUTF8(" · 日本語 🎵 ' \" \\");
        for(int index=0;index<500;++index){auto item=track.clone();item.getDynamicObject()->setProperty("id","bench"+juce::String(index).paddedLeft('0',6));item.getDynamicObject()->setProperty("title","Large track "+juce::String(index)+unicode);large.add(item);}
        evaluate("window.__pluginStores.api.createPlaylist('Large offline library',"+juce::JSON::toString(juce::var(large))+").then(async playlist=>{window.__pluginTest.largeId=playlist.id;await window.__pluginStores.library.getState().load();const library=await window.__pluginStores.api.library();window.__pluginTest.roundtripTitle=library.playlists.find(p=>p.id===playlist.id)?.tracks[499]?.title;window.__pluginTest.largeReady=true;});true");
        for(int i=0;i<100&&!(bool)evaluate("window.__pluginTest.largeReady||false");++i)pump(50);
        if(!(bool)evaluate("window.__pluginTest.largeReady||false")){std::cerr<<"500-track library did not commit/load\n";return 1;}
        if(evaluate("window.__pluginTest.roundtripTitle").toString()!=large[499]["title"].toString()){std::cerr<<"Large bridge response corrupted UTF-8, quotes or backslashes\n";return 1;}
       #if !BEATMAKER_DESKTOP_BETA
        evaluate("document.querySelector('a[href=\"/library\"]')?.click();true");pump(200);
        evaluate("document.querySelector('a[href=\"/playlist/'+window.__pluginTest.largeId+'\"]')?.click();true");pump(200);
       #endif
        const std::array<std::pair<int,int>,5> shapes{{{360,760},{1280,600},{760,760},{1600,480},{480,1400}}};
        for(const auto [width,height]:shapes){
            editor->setSize(width,height);pump(250);
            juce::String layout;bool bounded=false;
            for(int attempt=0;attempt<40;++attempt){
                layout=evaluate("JSON.stringify({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth-innerWidth,rows:document.querySelectorAll('[data-virtual-list] [data-index],[data-virtual-grid] [data-index]').length,gridHeight:document.querySelector('[data-virtual-grid]')?.clientHeight,cardHeight:document.querySelector('[data-virtual-grid] [data-index]')?.getBoundingClientRect().height})").toString();
                const auto values=juce::JSON::parse(layout);
                bounded=(int)values["width"]>0&&(int)values["overflow"]<=2&&(int)values["rows"]>0&&(int)values["rows"]<=80;
                if(bounded)break;pump(50);
            }
            if(!bounded){std::cerr<<"Responsive 500-track layout failed at "<<width<<"x"<<height<<": "<<layout<<"\n";return 1;}
            if(!dynamic_cast<juce::ResizableCornerComponent*>(editor->getComponentAt(width-3,height-3))){std::cerr<<"Native resize grip is not reachable\n";return 1;}
        }
       #if !BEATMAKER_DESKTOP_BETA
        evaluate("document.querySelector('a[href=\"/cues\"]')?.click();true");pump(200);
       #endif
        std::cout<<"PASS: 500-track real WebView stays windowed across portrait, landscape, square, wide and tall sizes; native grip reachable\n";
        evaluate("window.__pluginStores.api.createPlaylist('Offline saved playlist',["+juce::JSON::toString(track)+"]).then(()=>window.__pluginTest.saved=true);true");
        for(int i=0;i<100&&!(bool)evaluate("window.__pluginTest.saved||false");++i)pump(50);
        if(!(bool)evaluate("window.__pluginTest.saved||false")){std::cerr<<"Offline playlist commit failed\n";return 1;}
        juce::MemoryBlock saved;processor.getStateInformation(saved);editor.reset();processor.setStateInformation(saved.getData(),(int)saved.getSize());
        editor=std::make_unique<MobileWebEditor>(processor,true);editor->addToDesktop(juce::ComponentPeer::windowIsTemporary);editor->setVisible(true);
        if(editor->getWidth()!=480||editor->getHeight()!=1400){std::cerr<<"Editor dimensions were not restored\n";return 1;}
        for(int i=0;i<100;++i){pump(100);if((bool)evaluate("Boolean(window.__pluginStores)"))break;}
        if((double)evaluate("window.__pluginStores.cues.getState().cues[1]||0")!=0.125){std::cerr<<"Offline editor recall lost cues\n";return 1;}
        CueProcessor cold;bool found=false;const auto library=juce::JSON::parse(cold.libraryStore.readLibrary());
        if(const auto* playlists=library["playlists"].getArray())for(const auto& item:*playlists)found=found||item["name"].toString()=="Offline saved playlist";
        editor.reset();
        if(!found){std::cerr<<"Offline fresh processor lost durable library\n";return 1;}
        std::cout<<"PASS: real offline WebView initialisation, local AAC, host-bus audio, native cue feedback, editor recall and durable library\n";
        return 0;
    }
    evaluate("window.__pluginTest={};window.__pluginInvoke('http',{url:'https://www.youtube.com/youtubei/v1/visitor_id?prettyPrint=false',method:'POST',headers:{'content-type':'application/json'},data:JSON.stringify({context:{client:{clientName:'VISIONOS',clientVersion:'1.02',hl:'en',gl:'US'}}})}).then(r=>window.__pluginTest.http=r.status).catch(e=>window.__pluginTest.error=e.message);true");
    for(int i=0;i<100;++i){pump(100);if((int)evaluate("window.__pluginTest.http||0")!=0)break;}
    std::cout<<"HTTP: "<<evaluate("JSON.stringify(window.__pluginTest)").toString()<<"\n";
    if((int)evaluate("window.__pluginTest.http||0")!=200)return 1;
    evaluate("window.__pluginStores.api.search('Nujabes','song').then(r=>window.__pluginTest.search=Array.isArray(r)?r.length:r.tracks?.length||0).catch(e=>window.__pluginTest.error=e.message);true");
    for(int i=0;i<200;++i){pump(100);if((int)evaluate("window.__pluginTest.search||0")>0)break;}
    if((int)evaluate("window.__pluginTest.search||0")<=0){std::cerr<<"Search failed: "<<evaluate("JSON.stringify(window.__pluginTest)").toString()<<"\n";return 1;}
    std::cout<<"PASS: live YouTube catalog search through mobile API\n";
   #if BEATMAKER_DESKTOP_BETA
    pump(500);
    if(!(bool)evaluate("Boolean(document.querySelector('.bm-app[data-engine-ready=\"true\"]'))")){std::cerr<<"Desktop beta studio did not initialize\n";return 1;}
    const juce::String inputSelector="[aria-label=\"Search music\"]",formSelector=".bm-search-row";
   #else
    const juce::String inputSelector="#search-input",formSelector="form[role=\"search\"]";
    evaluate("document.querySelector('a[href=\"/search\"]')?.click();true");
   #endif
    pump(300);
    const auto typingStarted=juce::Time::getMillisecondCounter();
    for(const auto& text : juce::StringArray{"N","Nu","Nuj","Nuja","Nujab","Nujabe","Nujabes"}) {
        evaluate("(()=>{const input=document.querySelector("+juce::JSON::toString(inputSelector)+");if(!input)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,"+juce::JSON::toString(text)+");input.dispatchEvent(new Event('input',{bubbles:true}));return true})()");pump(25);
    }
    pump(700);
    if(evaluate("document.querySelector("+juce::JSON::toString(inputSelector)+")?.value").toString()!="Nujabes"||juce::Time::getMillisecondCounter()-typingStarted>5000){std::cerr<<"Typing responsiveness failed\n";return 1;}
    if((bool)evaluate("location.search.includes('q=')")){std::cerr<<"Typing unexpectedly started catalog search\n";return 1;}
    evaluate("document.querySelector("+juce::JSON::toString(formSelector)+")?.requestSubmit();true");
    pump(1500);
   #if BEATMAKER_DESKTOP_BETA
    for(int i=0;i<100&&!(bool)evaluate("Boolean(document.querySelector('.bm-track'))");++i)pump(100);
    if(!(bool)evaluate("Boolean(document.querySelector('.bm-track'))")){std::cerr<<"Desktop beta search did not return tracks\n";return 1;}
   #else
    if(!(bool)evaluate("location.search.includes('q=Nujabes')")){std::cerr<<"Explicit Search did not submit\n";return 1;}
   #endif
    std::cout<<"PASS: rapid typing remains responsive without per-keystroke catalog work; explicit Search submits\n";
    evaluate("window.__pluginStores.player.getState().playList([{id:'00ud2TX3aFE',title:'Plugin integration song',artist:'Test',duration:230,kind:'song',thumb:'',art:''}]);true");
    bool audible=false;
    for(int i=0;i<300&&!audible;++i){pump(100);audible=output.getMagnitude(0,output.getNumSamples())>0.0001f;if(i%50==0)std::cout<<"Player: "<<evaluate("JSON.stringify({status:window.__pluginStores.player.getState().status,note:window.__pluginStores.player.getState().statusText})").toString()<<" Native: "<<processor.getStatus()<<"\n";}
    if(!audible){std::cerr<<"No rendered song audio: "<<processor.getStatus()<<" Resolver client: "<<evaluate("window.__pluginResolverClient||'none'").toString()<<"\n";return 1;}
    std::cout<<"Load profile: "<<juce::JSON::toString(processor.loadDiagnostics(),true)<<" UI resolver: "<<evaluate("JSON.stringify(window.__pluginLastResolution||{})").toString()<<"\n";
    evaluate("window.__pluginStores.cues.getState().setTrack('00ud2TX3aFE');window.__pluginStores.cues.getState().setCue(1,4.25);window.__pluginStores.player.getState().cue(4.25);true");
    pump(300);
    if(!processor.playing.load())return 1;
   #if BEATMAKER_DESKTOP_BETA
    pump(300);
    const auto beforeDesktopCue=processor.padStates[0].load();
    evaluate("document.querySelector('.bm-pad-hit')?.click();true");pump(100);
    if((processor.padStates[0].load()>>1)==(beforeDesktopCue>>1)||!processor.playing.load()){std::cerr<<"Desktop pad did not trigger the native render-thread cue event: "<<evaluate("JSON.stringify({disabled:document.querySelector('.bm-pad-hit')?.disabled,label:document.querySelector('.bm-pad-hit')?.getAttribute('aria-label'),snapshot:window.musikeBeatmakerEngine?.snapshot(),bank:window.__pluginStores.cues.getState().bank,cues:window.__pluginStores.cues.getState().cues,status:window.__pluginStores.player.getState().status})").toString()<<"\n";return 1;}
    evaluate("Array.from(document.querySelectorAll('.bm-banks>button')).find(button=>button.textContent==='B')?.click();true");pump(100);
    evaluate("document.querySelectorAll('.bm-pad-hit')[1]?.click();true");pump(300);
    if(processor.getCue(1,1)<0){std::cerr<<"Desktop empty pad did not mark a native cue\n";return 1;}
    evaluate("Array.from(document.querySelectorAll('.bm-banks>button')).find(button=>button.textContent==='A')?.click();true");pump(100);
    std::cout<<"PASS: actual desktop beta pad click triggers native cue; bank B empty pad marks the host engine\n";
    evaluate("Array.from(document.querySelectorAll('label')).find(label=>label.textContent.includes('MIDI overwrite'))?.querySelector('input')?.click();true");pump(100);
    evaluate("(()=>{const data={format:'musike-beatmaker',version:1,name:'Desktop import test',bank:'A',tracks:[],cues:{'ytbm_cues_00ud2TX3aFE:bank:A':{'1':4.25},'ytbm_cues_00ud2TX3aFE:bank:J':{'16':20},'ytbm_cues_dQw4w9WgXcQ:bank:J':{'0':12.5}}};const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(data)],'desktop.beatmaker.json',{type:'application/json'}));const input=document.querySelector('input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()");pump(500);
    if((double)evaluate("JSON.parse(localStorage.getItem('musike:cues:v1'))['dQw4w9WgXcQ']?.J?.[10]||0")!=12.5||processor.getCue(9,15)!=20){std::cerr<<"Desktop session import did not restore native banks and other-track cues\n";return 1;}
    std::cout<<"PASS: desktop session file imports native bank J and other-track cue maps\n";
    if(!processor.overwrite.load()){std::cerr<<"Desktop MIDI overwrite did not reach the native engine\n";return 1;}
    evaluate("Array.from(document.querySelectorAll('label')).find(label=>label.textContent.includes('MIDI overwrite'))?.querySelector('input')?.click();true");pump(100);
   #endif
    std::cout<<"PASS: actual mobile UI, native catalog HTTP, YouTube resolution/download, host-bus song audio and cue playback\n";
    evaluate("window.__pluginStores.api.createPlaylist('Plugin saved playlist',[{id:'00ud2TX3aFE',title:'Plugin integration song',artist:'Test',duration:230,kind:'song',thumb:'',art:''}]).then(()=>window.__pluginTest.saved=true);true");
    for(int i=0;i<100;++i){pump(50);if((bool)evaluate("window.__pluginTest.saved||false"))break;}
    pump(1200);
    juce::MemoryBlock state;processor.getStateInformation(state);
    editor.reset();processor.setStateInformation(state.getData(),(int)state.getSize());
    editor=std::make_unique<MobileWebEditor>(processor);editor->addToDesktop(juce::ComponentPeer::windowIsTemporary);editor->setVisible(true);
    for(int i=0;i<100;++i){pump(100);if((bool)evaluate("Boolean(window.__pluginStores)"))break;}
    evaluate("window.__pluginTest={};window.__pluginStores.api.library().then(r=>window.__pluginTest.restored=r.playlists.some(p=>p.name==='Plugin saved playlist'));true");
    for(int i=0;i<100;++i){pump(50);if((bool)evaluate("window.__pluginTest.restored||false"))break;}
    if(!(bool)evaluate("window.__pluginTest.restored||false")){std::cerr<<"Library state was not restored\n";return 1;}
    if((double)evaluate("window.__pluginStores.cues.getState().cues[1]||0")!=4.25){std::cerr<<"Cue state was not restored\n";return 1;}
    std::cout<<"PASS: library playlist and cues persist through host state and editor reconstruction\n";
    editor.reset();
    CueProcessor cold;auto coldEditor=std::make_unique<MobileWebEditor>(cold);
    coldEditor->addToDesktop(juce::ComponentPeer::windowIsTemporary);coldEditor->setVisible(true);
    editor=std::move(coldEditor);
    for(int i=0;i<100;++i){pump(100);if((bool)evaluate("Boolean(window.__pluginStores)"))break;}
    evaluate("window.__pluginTest={};window.__pluginStores.api.library().then(r=>window.__pluginTest.cold=r.playlists.some(p=>p.name==='Plugin saved playlist'));true");
    for(int i=0;i<100;++i){pump(50);if((bool)evaluate("window.__pluginTest.cold||false"))break;}
    if(!(bool)evaluate("window.__pluginTest.cold||false")){std::cerr<<"Cold app/plugin restart lost library\n";return 1;}
    editor.reset();
    std::cout<<"PASS: library survives a fresh processor without any DAW-session state\n";
    return 0;
}
