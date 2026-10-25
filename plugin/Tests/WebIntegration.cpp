#include "WebEditor.h"
#include <CoreFoundation/CoreFoundation.h>
#include <iostream>

int main() {
    juce::ScopedJuceInitialiser_GUI initialise;
    const auto testData=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("beatmaker-web-test",{});
    testData.createDirectory();setenv("BEATMAKER_PLUGIN_DATA_DIR",testData.getFullPathName().toRawUTF8(),1);
    struct Cleanup{juce::File file;~Cleanup(){file.deleteRecursively();}}cleanup{testData};
    CueProcessor processor;processor.prepareToPlay(48000,512);
    auto editor=std::make_unique<MobileWebEditor>(processor);
    editor->addToDesktop(juce::ComponentPeer::windowIsTemporary);editor->setVisible(true);
    juce::AudioBuffer<float> output(2,512);juce::MidiBuffer midi;
    const auto pump=[&](int milliseconds){const auto end=juce::Time::getMillisecondCounter()+milliseconds;
        while(juce::Time::getMillisecondCounter()<end){CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.01,true);processor.processBlock(output,midi);}};
    const auto evaluate=[&](juce::String script){juce::var result;bool completed=false;
        editor->evaluate(script,[&](auto value){if(value.getResult())result=*value.getResult();else if(value.getError())std::cerr<<value.getError()->message<<"\n";completed=true;});
        for(int i=0;i<100&&!completed;++i)pump(50);return result;};
    for(int i=0;i<100;++i){pump(100);if((bool)evaluate("Boolean(window.__pluginStores)"))break;}
    std::cout<<"DOM: "<<evaluate("document.body.innerText").toString()<<"\n";
    std::cout<<"Bridge: "<<evaluate("JSON.stringify({platform:Capacitor.getPlatform(),resolver:!!window.webkit?.messageHandlers?.musikeResolve,ready:window.__pluginReady})").toString()<<"\n";
    if(!(bool)evaluate("Boolean(window.__pluginStores)")){std::cerr<<"Mobile app failed to initialise\n";return 1;}
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
