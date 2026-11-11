// Isolated development APK: real WebView/JNI/device callbacks and Android pickers.
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {adb,connectAndroidWebView,delay} from './android-webview.mjs';

assert.equal(adb('shell','getprop','ro.kernel.qemu'),'1','Run feature imports/recording on the emulator');
assert.equal(process.env.ANDROID_APPLICATION_ID,'app.owaega.beatmakercuesstandalone.development','Use the isolated feature APK, preserving the normal app');
const client=await connectAndroidWebView(),{application,evaluate,platform,motion,padPoint}=client;
const results=[],remote='/sdcard/Download/beatmaker-feature-'+Date.now()+'.m4a',file=path.basename(remote);
const pass=label=>{results.push(label);console.log('PASS: '+label);};
const wait=async(predicate,message)=>{for(let i=0;i<150;i++){if(await predicate())return;await delay(50);}throw Error(message);};
const touchNode=async(expression,label)=>{
  const point=await evaluate(`(async()=>{const node=${expression};if(!node)return null;node.scrollIntoView({block:'nearest'});await new Promise(requestAnimationFrame);const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {x:r.x+r.width/2,y:r.y+r.height/2,dpr:devicePixelRatio,reachable:!node.disabled&&r.width>=20&&r.height>=20&&r.y>=0&&r.bottom<=innerHeight+1&&!!hit&&(node===hit||node.contains(hit))};})()`);
  assert(point?.reachable,'Button is missing, clipped or untouchable: '+label+': '+JSON.stringify(point));motion('DOWN',point);motion('UP',point);await delay(250);
};
const click=selector=>touchNode(`document.querySelector(${JSON.stringify(selector)})`,selector);
const text=label=>touchNode(`[...document.querySelectorAll('[role="dialog"] button')].find(node=>node.textContent.trim().startsWith(${JSON.stringify(label)}))`,label);
const close=async()=>{await click('[role="dialog"] button[aria-label="Close"]');await wait(()=>evaluate('!document.querySelector("[role=dialog]")'),'Dialog did not close');};
const nativeText=label=>{const xml=adb('shell','-tt','uiautomator','dump','/dev/tty');const node=[...xml.matchAll(/<node\b[^>]*>/g)].map(match=>match[0]).find(value=>(value.includes(`text="${label}"`)||value.includes(`content-desc="${label}"`))&&(label!==file||value.includes('resource-id="android:id/title"')));const bounds=node&&/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);if(!bounds)return false;adb('shell','input','tap',String(Math.round((+bounds[1]+ +bounds[3])/2)),String(Math.round((+bounds[2]+ +bounds[4])/2)));return true;};
const pickFixture=async()=>{
  await delay(600);
  if(nativeText('Search')){await delay(150);adb('shell','input','text',file);adb('shell','input','keyevent','KEYCODE_ENTER');await delay(350);if(/^\s*mInputShown=true\b/m.test(adb('shell','dumpsys','input_method'))){adb('shell','input','keyevent','KEYCODE_BACK');await delay(250);}assert(nativeText(file),'Audio fixture not listed in search');}
  else if(!nativeText(file)){assert(nativeText('Show roots'),'Picker roots unavailable');await delay(250);assert(nativeText('Downloads'),'Downloads root unavailable');await delay(250);assert(nativeText(file),'Audio fixture not listed');}
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
  await evaluate('__pluginStores.cues.getState().setBank("A");__pluginStores.cues.getState().setCue(1,.05);true');await delay(500);
  assert(await evaluate('document.querySelector(".cue-pad-clear")?.textContent.trim()==="×"&&!document.querySelector(".cue-pad-clear svg")'),'Android erase-X appearance was replaced');
  let before=await platform();await tap(1);let after=await platform();assert.equal(after.fastCommandsAccepted-before.fastCommandsAccepted,1);assert.equal(after.nativeTouchCommands-before.nativeTouchCommands,1);
  const point=await padPoint(1);before=await platform();motion('DOWN',point);await delay(750);motion('UP',point);await delay(200);after=await platform();assert.equal(after.fastCommandsAccepted-before.fastCommandsAccepted,1);assert.equal(await evaluate('__pluginStores.cues.getState().cues[1]'),.05);
  pass('Native single-hit cue receipts, preserved Android X, and non-overwriting performance holds');
  await click('button[aria-label="Settings"]');assert.equal(await evaluate(`document.querySelector('[aria-label="Fade between songs"]').getAttribute("aria-checked")`),'true');await click('[aria-label="Fade between songs"]');await wait(async()=>!(await evaluate('__pluginInvoke("transitions")')).enabled,'Saved Instant/Off did not reach native transitions');await click('[aria-label="Fade between songs"]');await close();
  pass('Default-On fades with native Instant/Off preference');
  await click('.cue-song-import');await click('[aria-label="Import gallery video"]');await delay(600);
  const picker=adb('shell','dumpsys','activity','activities');assert(/topResumedActivity[^\n]*PhotoPickerActivity/i.test(picker),'Phone gallery did not open the Android photo/video picker');adb('shell','input','keyevent','KEYCODE_BACK');await wait(()=>evaluate(`!!document.querySelector('[aria-label="Import gallery video"]:not(:disabled)')`),'Cancelling gallery did not restore the source menu');await close();
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
  await evaluate('__pluginStores.player.getState().newEmptyTrack()');await wait(()=>evaluate('!__pluginStores.player.getState().queue.length'),'Empty workspace retained the song');await delay(350);before=await platform();await tap(1);after=await platform();assert.equal(after.fastCommandsAccepted-before.fastCommandsAccepted,1);
  await click('.cue-looper-edit');await click('.cue-pad[data-pad-number="16"]');await wait(()=>evaluate('__pluginInvoke("looperState").then(state=>state.pads.some(pad=>pad.pad===16))'),'Looper assignment failed');await click('.cue-looper-edit');await delay(350);
  before=await platform();await tap(16);after=await platform();assert.equal(after.fastCommandsAccepted-before.fastCommandsAccepted,1,'Looper touch replayed its native receipt');await delay(1300);
  assert(await evaluate('__pluginInvoke("looperState").then(state=>state.pads.find(pad=>pad.pad===16)?.mode===1)'),'Native touch-up did not release the looper hold');await tap(1);await tap(16);
  const loop=await evaluate('__pluginInvoke("looperState",{events:true})');assert(loop.song==='@empty'&&loop.pads.find(pad=>pad.pad===16)?.mode===2&&loop.pads.find(pad=>pad.pad===16)?.events.length>=1,'Native internal sample performance was not recorded/played');
  const loopPoint=await padPoint(16);motion('DOWN',loopPoint);await delay(1300);motion('UP',loopPoint);await delay(150);assert(await evaluate('__pluginInvoke("looperState").then(state=>state.pads.find(pad=>pad.pad===16)?.length===0)'),'Native looper hold-to-clear failed');
  pass('Sample-only performance and native looper assign/press/release/record/play/hold-clear without a song');
  const report={result:'PASS',application,checks:results,audioMenu:sourceMenu,routes:await evaluate('__pluginInvoke("audioRoutes")'),platform:await platform()};
  if(process.env.ANDROID_FEATURE_REPORT)await writeFile(process.env.ANDROID_FEATURE_REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}catch(error){
  try{console.error('Android feature diagnostic',await evaluate('({sampleDone:window.__sampleDone,sampleResult:window.__sampleResult,sampleError:window.__sampleError,body:document.body.innerText.slice(-900)})'));console.error(adb('shell','dumpsys','activity','activities').split('\n').filter(line=>line.includes('topResumedActivity')).join('\n'));}catch{}
  throw error;
}finally{try{adb('shell','rm','-f',remote);}catch{}client.close();}
