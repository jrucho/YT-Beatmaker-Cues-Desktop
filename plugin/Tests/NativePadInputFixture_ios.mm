// Simulator-only integration of the real UIKit observer, WKWebView and engine.
// Injected UITouch objects are not a measurement of hardware touch latency.
#include "WebEditor.h"
#import <UIKit/UIKit.h>
#import <UIKit/UIGestureRecognizerSubclass.h>
#import <WebKit/WebKit.h>
#import <PhotosUI/PhotosUI.h>
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
                const auto second=processor->importLocalFile(file);
                evaluate("window.__pluginStores.player.getState().setSpeed(25);window.__pluginStores.player.getState().setSpeedMode('pitch');window.__pluginStores.player.getState().setTuning(4);true");pump(150);
                check((double)processor->nativeSnapshot()["playback"]["speed"]==25&&!processor->preservePitch.load()&&processor->semitones.load()==4,"iOS speed/mode/tuning edit did not reach native song settings");
                evaluate("window.__pluginStores.player.getState().playList(["+juce::JSON::toString(track)+","+juce::JSON::toString(second)+"]);window.__pluginStores.player.getState().jumpTo(1);true");
                for(int i=0;i<100;++i){pump(30);if(processor->ready.load()&&processor->nativeSnapshot()["trackId"].toString()==second["id"].toString())break;}
                check((double)processor->nativeSnapshot()["playback"]["speed"]==0&&processor->preservePitch.load()&&processor->semitones.load()==0,"A new iOS song inherited previous-song playback controls");
                evaluate("window.__pluginStores.player.getState().jumpTo(0);true");
                for(int i=0;i<100;++i){pump(30);if(processor->ready.load()&&processor->nativeSnapshot()["trackId"].toString()==track["id"].toString())break;}
                check((double)processor->nativeSnapshot()["playback"]["speed"]==25&&!processor->preservePitch.load()&&processor->semitones.load()==4,"Returning to an iOS song did not recall its native controls");
                evaluate("window.__pluginStores.player.getState().setSpeed(0);window.__pluginStores.player.getState().setSpeedMode('speed');window.__pluginStores.player.getState().setTuning(0);true");pump(100);
            }
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
            if((bool)evaluate("window.__pluginIOSPreview===true"))check(web.scrollView.bounces==originalBounce,"Leaving Cues did not restore the browser's original bounce behavior");
        }
        std::cout<<(passed?"PASS":"FAIL")<<": iOS simulator UIKit observer/WKWebView/native audio, one-time cue/sample receipts, non-cancelling gesture and modal exclusion (injected touch, hardware latency not measured)\n"<<std::flush;
        std::exit(passed?0:1);
    }
};
}
START_JUCE_APPLICATION(InputFixture)
