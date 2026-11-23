// Isolated development APK: real WebView/JNI/device callbacks and Android pickers.
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {adb,connectAndroidWebView,delay} from './android-webview.mjs';

assert.equal(adb('shell','getprop','ro.kernel.qemu'),'1','Run feature imports/recording on the emulator');
assert.equal(process.env.ANDROID_APPLICATION_ID,'app.owaega.beatmakercuesstandalone.development','Use the isolated feature APK, preserving the normal app');
const client=await connectAndroidWebView(),{application,evaluate,platform,motion,padPoint}=client;
const results=[],remote='/sdcard/Download/beatmaker-feature-'+Date.now()+'.m4a',file=path.basename(remote);
const coverFile='beatmaker-cover-'+Date.now()+'.png',remoteCover='/sdcard/Download/'+coverFile;
const pass=label=>{results.push(label);console.log('PASS: '+label);};
const wait=async(predicate,message)=>{for(let i=0;i<150;i++){if(await predicate())return;await delay(50);}throw Error(message);};
const touchNode=async(expression,label)=>{
  const point=await evaluate(`(async()=>{const node=${expression};if(!node)return null;node.scrollIntoView({block:'nearest'});await new Promise(requestAnimationFrame);const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {x:r.x+r.width/2,y:r.y+r.height/2,dpr:devicePixelRatio,reachable:!node.disabled&&r.width>=20&&r.height>=20&&r.y>=0&&r.bottom<=innerHeight+1&&!!hit&&(node===hit||node.contains(hit))};})()`);
  assert(point?.reachable,'Button is missing, clipped or untouchable: '+label+': '+JSON.stringify(point));motion('DOWN',point);motion('UP',point);await delay(250);
};
const click=selector=>touchNode(`document.querySelector(${JSON.stringify(selector)})`,selector);
const text=label=>touchNode(`[...document.querySelectorAll('[role="dialog"] button')].find(node=>node.textContent.trim().startsWith(${JSON.stringify(label)}))`,label);
const close=async()=>{await click('[role="dialog"] button[aria-label="Close"]');await wait(()=>evaluate('!document.querySelector("[role=dialog]")'),'Dialog did not close');};
const nativeText=(label,isFile=false)=>{const xml=adb('shell','-tt','uiautomator','dump','/dev/tty');const node=[...xml.matchAll(/<node\b[^>]*>/g)].map(match=>match[0]).find(value=>(value.includes(`text="${label}"`)||value.includes(`content-desc="${label}"`))&&(!isFile||value.includes('resource-id="android:id/title"')));const bounds=node&&/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);if(!bounds)return false;adb('shell','input','tap',String(Math.round((+bounds[1]+ +bounds[3])/2)),String(Math.round((+bounds[2]+ +bounds[4])/2)));return true;};
const pickFixture=async(name=file)=>{
  await delay(600);
  if(nativeText('Search')){await delay(150);adb('shell','input','text',name);adb('shell','input','keyevent','KEYCODE_ENTER');await delay(350);if(/^\s*mInputShown=true\b/m.test(adb('shell','dumpsys','input_method'))){adb('shell','input','keyevent','KEYCODE_BACK');await delay(250);}assert(nativeText(name,true),'File fixture not listed in search');}
  else if(!nativeText(name,true)){assert(nativeText('Show roots'),'Picker roots unavailable');await delay(250);assert(nativeText('Downloads'),'Downloads root unavailable');await delay(250);assert(nativeText(name,true),'File fixture not listed');}
  await delay(300);
};
const tap=async pad=>{const point=await padPoint(pad);motion('DOWN',point);motion('UP',point);await delay(250);};
try{
  assert(await evaluate('window.__pluginFeatures===true&&window.__pluginPlatform==="android"'),'Android performance features/platform were not enabled');
  await evaluate('(async()=>{const sample=(await __pluginInvoke("padSamples")).find(pad=>pad.bank==="A"&&pad.pad===1);if(sample){if(!sample.name.startsWith("beatmaker-feature"))throw Error("Fixture pad already contains unrelated content");await __pluginInvoke("padSample",{cmd:"remove",bank:"A",pad:1});}return true;})()');
  await evaluate('(async()=>{const state=await __pluginInvoke("looperState",{events:true}),pad=state.pads.find(pad=>pad.bank==="A"&&pad.pad===16);if(state.song==="@empty"&&pad){if(pad.length||pad.events?.length)throw Error("Fixture loop pad already contains events");await __pluginInvoke("looperPad",{cmd:"remove",bank:"A",pad:16});}return true;})()');
  await evaluate(`__pluginStores.player.setState({repeat:"one",autoRadio:false});document.querySelector('a[href="/cues"]').click();true`);
  await wait(()=>evaluate('!!document.querySelector(".cue-song-import")'),'Shared Cues controls missing');
  await evaluate(`(()=>{const node=document.querySelector('[aria-label="Pad layout preset"]');node.value="linear16";node.dispatchEvent(new Event("change",{bubbles:true}));return true;})()`);
  adb('push',path.resolve('plugin/Tests/fixtures/tone.m4a'),remote);
  await click('.cue-song-import');assert(await evaluate('!document.body.textContent.includes("Library songs & videos")&&![...document.querySelectorAll("[role=dialog] button")].some(node=>node.textContent==="Chop current song")'),'Old library/chop actions remain in Import audio');
  const sourceMenu=await evaluate(`(()=>{const panel=document.querySelector('.media-import-panel'),r=panel.getBoundingClientRect();return {height:r.height,actions:[...panel.querySelectorAll('button')].map(node=>{const b=node.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return{label:node.textContent,reachable:b.top>=r.top&&b.bottom<=r.bottom+1&&!!hit&&(node===hit||node.contains(hit))};})};})()`);
  assert(sourceMenu.height>=180&&sourceMenu.actions.length===4&&sourceMenu.actions.every(action=>action.reachable),'Import audio shows only its title or hides source actions: '+JSON.stringify(sourceMenu));
  await text('Files');await pickFixture();
  await wait(()=>evaluate(`(()=>{const p=__pluginStores.player.getState();return p.queue[p.index]?.title===${JSON.stringify(path.parse(file).name)}&&p.status==="playing";})()`),'Device-file import did not automatically load Imports/Cues');
  pass('Native Files import, retained managed AAC, automatic Imports/Cues and simplified source menu');
  assert(await evaluate(`document.querySelector('[aria-label="Pitch (varispeed)"]')?.getAttribute("aria-pressed")==="true"`),'Newly imported Android audio should default to Pitch');
  await evaluate('__pluginStores.cues.getState().setBank("A");__pluginStores.cues.getState().setCue(1,.05);true');await delay(500);
  assert(await evaluate('document.querySelector(".cue-pad-clear")?.textContent.trim()==="×"&&!document.querySelector(".cue-pad-clear svg")'),'Android erase-X appearance was replaced');
  let before=await platform();await tap(1);let after=await platform();assert.equal(after.fastCommandsAccepted-before.fastCommandsAccepted,1);assert.equal(after.nativeTouchCommands-before.nativeTouchCommands,1);
  const point=await padPoint(1);before=await platform();motion('DOWN',point);await delay(750);motion('UP',point);await delay(200);after=await platform();assert.equal(after.fastCommandsAccepted-before.fastCommandsAccepted,1);assert.equal(await evaluate('__pluginStores.cues.getState().cues[1]'),.05);
  pass('Native single-hit cue receipts, preserved Android X, and non-overwriting performance holds');
  await click('button[aria-label="Settings"]');assert.equal(await evaluate(`document.querySelector('[aria-label="Crossfade between songs"]').getAttribute("aria-checked")`),'true');await click('[aria-label="Crossfade between songs"]');await wait(async()=>!(await evaluate('__pluginInvoke("transitions")')).enabled,'Saved Instant/Off did not reach native transitions');await click('[aria-label="Crossfade between songs"]');await close();
  pass('Default-On crossfade with native Instant/Off preference');
  await click('.cue-song-import');await click('[aria-label="Import gallery video"]');await delay(600);
  const picker=adb('shell','dumpsys','activity','activities');assert(/topResumedActivity[^\n]*PhotoPickerActivity/i.test(picker),'Phone gallery did not open the Android photo/video picker');adb('shell','input','keyevent','KEYCODE_BACK');await wait(()=>evaluate(`document.hasFocus()&&!!document.querySelector('[aria-label="Import gallery video"]:not(:disabled)')`),'Cancelling gallery did not restore the focused source menu');
  // The picker result can precede Activity focus/its closing surface animation.
  // Wait for the native input window before injecting the next real touch.
  await delay(750);await close();
  pass('Real Android gallery video picker and non-destructive cancellation');
  await click('.cue-record');await text('Start recording');await wait(()=>evaluate('__pluginInvoke("recordAudio",{cmd:"state"}).then(state=>state.recording&&state.seconds>.2)'),'Native playback callbacks did not feed the take');await text('Finish & play');await wait(()=>evaluate('!document.querySelector("[role=dialog]")'),'Playback take was not saved');
  pass('Native playback recording, retained WAV and immediate Imports/Cues');
  adb('shell','pm','grant',application,'android.permission.RECORD_AUDIO');
  const input=await evaluate('__pluginInvoke("configureAudio",{inputEnabled:true,input:"microphone",output:"automatic",monitor:false,monitorLevel:0})');assert(input.inputActive&&input.inputAccepted,'Native microphone selection/capture was not accepted: '+JSON.stringify(input));
  await evaluate('__pluginInvoke("recordAudio",{cmd:"start",source:"input"})');await wait(()=>evaluate('__pluginInvoke("recordAudio",{cmd:"state"}).then(state=>state.recording&&state.seconds>.2)'),'Input callbacks did not feed the take');
  await evaluate('__pluginInvoke("configureAudio",{monitor:true,monitorLevel:0})');await delay(350);const live=await evaluate('__pluginInvoke("recordAudio",{cmd:"state"})');assert(live.recording&&live.seconds>.2,'Monitor-only update interrupted capture: '+JSON.stringify(live));
  const take=await evaluate('__pluginInvoke("recordAudio",{cmd:"stop"})');assert(take.track?.id.startsWith('loc')&&!take.message,'Input WAV did not finalize cleanly: '+JSON.stringify(take));
  await evaluate('__pluginInvoke("configureAudio",{monitor:false,inputEnabled:false})');
  pass('Real input callbacks/permission, monitor-only updates during capture, and retained microphone WAV');
  await evaluate('window.__sampleDone=false;window.__sampleResult=null;window.__sampleError=null;__pluginInvoke("padSample",{cmd:"load",bank:"A",pad:1}).then(value=>{window.__sampleResult=value;window.__sampleDone=true;},error=>{window.__sampleError=error.message;window.__sampleDone=true;});true');await pickFixture();await wait(()=>evaluate('__pluginInvoke("padSamples").then(pads=>pads.some(pad=>pad.bank==="A"&&pad.pad===1&&pad.ready))'),'Native sample import did not become ready');
  await evaluate('window.__emptyTrackRequest=__pluginStores.player.getState().newEmptyTrack();true');await wait(()=>evaluate('!__pluginStores.player.getState().queue.length'),'Empty workspace retained the song');await delay(350);before=await platform();await tap(1);after=await platform();assert.equal(after.fastCommandsAccepted-before.fastCommandsAccepted,1);
  await click('.cue-looper-edit');await click('.cue-pad[data-pad-number="16"]');await wait(()=>evaluate('__pluginInvoke("looperState").then(state=>state.pads.some(pad=>pad.pad===16))'),'Looper assignment failed');await click('.cue-looper-edit');await delay(350);
  before=await platform();await tap(16);after=await platform();assert.equal(after.fastCommandsAccepted-before.fastCommandsAccepted,1,'Looper touch replayed its native receipt');await delay(1300);
  assert(await evaluate('__pluginInvoke("looperState").then(state=>state.pads.find(pad=>pad.pad===16)?.mode===1)'),'Native touch-up did not release the looper hold');await tap(1);await tap(16);
  const loop=await evaluate('__pluginInvoke("looperState",{events:true})');assert(loop.song==='@empty'&&loop.pads.find(pad=>pad.pad===16)?.mode===2&&loop.pads.find(pad=>pad.pad===16)?.events.length>=1,'Native internal sample performance was not recorded/played');
  const loopPoint=await padPoint(16);motion('DOWN',loopPoint);await delay(1300);motion('UP',loopPoint);await delay(150);assert(await evaluate('__pluginInvoke("looperState").then(state=>state.pads.find(pad=>pad.pad===16)?.length===0)'),'Native looper hold-to-clear failed');
  pass('Sample-only performance and native looper assign/press/release/record/play/hold-clear without a song');
  if(await evaluate('window.__pluginLibraryTools===true')){
    const id=await evaluate(`(async()=>{
      const {api,library,ui}=window.__pluginStores;
      const playlist=await api.createPlaylist("Android cover test "+Date.now());
      await library.getState().load(true);ui.getState().setLastPlaylist(null);return playlist.id;
    })()`);
    await click('nav a[href="/library"]');
    await click(`main a[href="/playlist/${id}"]`);
    await click('.playlist-cover-edit');await text('Choose from Photos');
    await delay(500);
    assert(/topResumedActivity[^\n]*PhotoPickerActivity/i.test(adb('shell','dumpsys','activity','activities')),'Photos did not open the Android image picker');
    adb('shell','input','keyevent','KEYCODE_BACK');
    await wait(()=>evaluate('document.hasFocus()&&!document.querySelector("[role=dialog]")'),'Cancelling Photos did not restore the playlist');
    await delay(750);
    adb('push',path.resolve('plugin/Assets/AppIcon.png'),remoteCover);
    // DocumentsUI's Images filter uses MediaStore; an adb-pushed file needs indexing.
    adb('shell','am','broadcast','-a','android.intent.action.MEDIA_SCANNER_SCAN_FILE','-d','file://'+remoteCover);
    await click('.playlist-cover-edit');await text('Choose from Files');await pickFixture(coverFile);
    const coverImage='.playlist-cover-edit img[src^="data:image/jpeg;base64,"]';
    await wait(()=>evaluate(`document.querySelector(${JSON.stringify(coverImage)})?.naturalWidth>0`),'Files did not apply a JPEG cover');
    assert(await evaluate(`(async()=>{
      const image=document.querySelector(${JSON.stringify(coverImage)});
      const {json}=await __pluginInvoke('librarySnapshot');
      const cover=JSON.parse(json).playlists.find(item=>item.id===${JSON.stringify(id)}).cover;
      return Math.max(image.naturalWidth,image.naturalHeight)<=640&&atob(cover.split(',')[1]).length<=128*1024&&cover===image.src;
    })()`),'Native Android cover was not retained as a bounded JPEG');
    await click('[aria-label="Undo edit"]');
    await wait(()=>evaluate(`!document.querySelector(${JSON.stringify(coverImage)})`),'Undo did not remove the assigned cover');
    await click('[aria-label="Redo edit"]');
    await wait(()=>evaluate(`document.querySelector(${JSON.stringify(coverImage)})?.naturalWidth>0`),'Redo did not restore the assigned cover');
    pass('Android native Photos cancellation, Files thumbnail conversion, durable cover and undo/redo');
  }
  const report={result:'PASS',application,checks:results,audioMenu:sourceMenu,routes:await evaluate('__pluginInvoke("audioRoutes")'),platform:await platform()};
  if(process.env.ANDROID_FEATURE_REPORT)await writeFile(process.env.ANDROID_FEATURE_REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}catch(error){
  try{console.error('Android feature diagnostic',await evaluate('({sampleDone:window.__sampleDone,sampleResult:window.__sampleResult,sampleError:window.__sampleError,body:document.body.innerText.slice(-900)})'));console.error(adb('shell','dumpsys','activity','activities').split('\n').filter(line=>line.includes('topResumedActivity')).join('\n'));}catch{}
  throw error;
}finally{try{adb('shell','rm','-f',remote,remoteCover);}catch{}client.close();}
