// Real Android view input, JNI/audio queue and the unmodified React event path.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {adb,connectAndroidWebView,delay} from './android-webview.mjs';

assert.equal(adb('shell','getprop','ro.kernel.qemu'),'1','This fixture imports and removes test media on the emulator');
const client=await connectAndroidWebView();
const {application,evaluate,platform,snapshot,padPoint,motion,call}=client;
const results=[];
let fixture,loadedSample=false,picking=false,original;
const wait=async(predicate,message)=>{
  for(let i=0;i<100;i++){if(await predicate())return;await delay(30);}
  throw Error(message);
};
const tap=async(pad)=>{const point=await padPoint(pad);motion('DOWN',point);motion('UP',point);await delay(180);};
const closeDialog=()=>evaluate(`document.querySelector('[role="dialog"] button[aria-label="Close"]')?.click();true`);
const counts=async(before,commands,native,label)=>{
  await delay(200);const after=await platform();
  assert.equal(after.fastCommandsAccepted-before.fastCommandsAccepted,commands,label+': duplicate or missing audio command');
  assert.equal(after.nativeTouchCommands-before.nativeTouchCommands,native,label+': unexpected raw touch route');
  results.push(label);
};
const clickNativeText=async(text)=>{
  const xml=adb('shell','-tt','uiautomator','dump','/dev/tty');
  const node=[...xml.matchAll(/<node\b[^>]*>/g)].map(match=>match[0]).find(node=>node.includes(`text="${text}"`)||node.includes(`content-desc="${text}"`));
  const bounds=node&&/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
  if(!bounds)return false;
  adb('shell','input','tap',String(Math.round((+bounds[1]+ +bounds[3])/2)),String(Math.round((+bounds[2]+ +bounds[4])/2)));
  return true;
};
try{
  await evaluate('window.__disableAndroidPerformance=false;window.__disableAndroidPadTouch=false;true');
  await client.seed();
  original=await evaluate(`({cues:localStorage.getItem('musike:cues:v1'),bank:__pluginStores.cues.getState().bank})`);
  assert(!(await evaluate('__pluginInvoke("padSamples")')).some(pad=>pad.bank==='A'&&[1,2,3,16].includes(pad.pad)),'Fixture pads must not replace existing sample assignments');
  await evaluate(`__pluginStores.player.getState().clearLoop();__pluginStores.cues.getState().setCue(1,1.25);__pluginStores.cues.getState().setCue(2,7.25);__pluginStores.cues.getState().clearCue(3);__pluginStores.cues.getState().clearCue(16);true`);
  await delay(1000);
  let before=await platform();
  await tap(1);
  await counts(before,1,1,'Saved cue fires once on native down');
  let state=await snapshot();assert(state.position>=1.25&&state.position<3);

  for(const stale of ['source','generation']){
    await evaluate(`(()=>{const r=document.querySelector('.cue-pad').getBoundingClientRect(),p=window.__pluginAndroidPlatform;__beatmakerPerformance.regions(JSON.stringify({clockId:performance.timeOrigin,jsTime:performance.now(),sourceId:p.sourceId+${stale==='source'?100:0},generation:p.audioGeneration+${stale==='generation'?100:0},bank:0,enabled:true,aspect:innerWidth/innerHeight,blocked:[],pads:[{pad:0,sample:false,to:1.25,x:r.x/innerWidth,y:r.y/innerHeight,w:r.width/innerWidth,h:r.height/innerHeight}]}));return true;})()`);
    before=await platform();await tap(1);await counts(before,1,0,`Stale ${stale} map safely uses the UI fallback`);
    await evaluate(`__pluginStores.cues.getState().setBank('B');true`);await delay(50);
    await evaluate(`__pluginStores.cues.getState().setBank('A');true`);await delay(100);
  }
  try{
    adb('shell','wm','size','2400x1080');
    await wait(()=>evaluate('innerWidth>innerHeight'),'Landscape WebView did not resize');await delay(300);
    before=await platform();await tap(1);await counts(before,1,1,'Native hit regions follow a landscape resize');
  }finally{adb('shell','wm','size','reset');await delay(400);}

  await evaluate('__pluginStores.player.getState().cue(18.625);true');await delay(250);
  const origin=(await snapshot()).position,point=await padPoint(1);before=await platform();
  motion('DOWN',point);
  try{
    await wait(async()=>Math.abs(await evaluate('__pluginStores.cues.getState().cues[1]')-origin)<.4,'Hold did not preserve the pre-jump position');
  }finally{motion('UP',point);}
  await counts(before,1,1,'Long press preserves original position without retriggering');

  before=await platform();await tap(3);
  assert(Number.isFinite(await evaluate('__pluginStores.cues.getState().cues[3]')),'Empty pad did not mark the native playhead');
  await counts(before,0,0,'Empty pad marks without a raw cue');

  await evaluate(`document.querySelector('.cue-overwrite-row>button:last-child').click();true`);await delay(100);
  const overwriting=(await snapshot()).position;before=await platform();await tap(2);
  assert(Math.abs(await evaluate('__pluginStores.cues.getState().cues[2]')-overwriting)<.4,'Overwrite jumped instead of marking');
  await counts(before,0,0,'Overwrite marks without triggering the old cue');
  await evaluate(`document.querySelector('.cue-overwrite-row>button:last-child').click();true`);

  // Compact layouts hide pad deletion. Expose the real sibling button to verify
  // that its native exclusion rectangle prevents a cue before deletion.
  const remove=await evaluate(`(()=>{const e=document.querySelector('.cue-pad-grid>div:nth-child(2)>button:not(.cue-pad)');e.style.display='grid';return true;})()`);assert(remove);
  await delay(100);
  const removePoint=await evaluate(`(()=>{const r=document.querySelector('.cue-pad-grid>div:nth-child(2)>button:not(.cue-pad)').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,dpr:devicePixelRatio};})()`);
  before=await platform();motion('DOWN',removePoint);motion('UP',removePoint);await delay(200);
  assert.equal(await evaluate('__pluginStores.cues.getState().cues[2]'),undefined);
  await counts(before,0,0,'Cue deletion excludes the underlying native pad');

  await evaluate(`document.querySelector('.cue-midi-settings').click();true`);await delay(150);
  before=await platform();await tap(1);await counts(before,0,0,'Dialog blocks the native pad map');
  await closeDialog();await delay(100);
  await evaluate(`document.querySelector('.cue-queue-toggle').click();true`);await delay(150);
  before=await platform();await tap(1);await counts(before,0,0,'Playlist overlay blocks underlying pads');
  await evaluate(`if(document.querySelector('.cue-queue-toggle').getAttribute('aria-expanded')==='true')document.querySelector('.cue-queue-toggle').click();true`);await delay(100);

  // CDP does not enter Android View.onTouch. It verifies the same UI's fallback
  // and independent pointer timers with two simultaneous fingers.
  await evaluate('__pluginStores.cues.getState().setCue(1,1.25);__pluginStores.cues.getState().setCue(2,7.25);true');await delay(250);
  const first=await padPoint(1),second=await padPoint(2);before=await platform();
  await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:first.x,y:first.y,id:1}]});
  await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:first.x,y:first.y,id:1},{x:second.x,y:second.y,id:2}]});
  await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await counts(before,2,0,'Two-finger WebView fallback enqueues two hits, not extra clicks');

  fixture=await mkdtemp(path.join(process.cwd(),'release/android-touch-fixture-'));
  const file=path.join(fixture,'beatmaker-latency-pad.wav'),rate=48000,frames=rate/4,bytes=Buffer.alloc(44+frames*2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*2,40);
  for(let i=0;i<frames;i++)bytes.writeInt16LE(Math.round(Math.sin(i/rate*440*Math.PI*2)*8000),44+i*2);
  await writeFile(file,bytes);adb('push',file,'/sdcard/Download/beatmaker-latency-pad.wav');
  await evaluate(`window.__sampleImport=__pluginInvoke('padSample',{cmd:'load',bank:'A',pad:16});true`);picking=true;await delay(500);
  if(!await clickNativeText('beatmaker-latency-pad.wav')){
    assert(await clickNativeText('Show roots'),'Document picker navigation missing');await delay(250);
    assert(await clickNativeText('Downloads'),'Downloads root missing');await delay(250);
    assert(await clickNativeText('beatmaker-latency-pad.wav'),'Sample fixture missing in Downloads');
  }
  await evaluate('window.__sampleImport');picking=false;loadedSample=true;
  await wait(()=>evaluate('Boolean(__pluginStores.samples.getState().samples["A:16"]?.ready)'),'Native sample did not become ready');
  await delay(250);await evaluate('__pluginInvoke("audio",{cmd:"pause"})');await delay(200);
  before=await platform();await tap(16);await counts(before,1,1,'Native sample fires once with song paused');
  assert.equal((await snapshot()).playing,false,'Sample pad started the song');
  assert.equal(await evaluate('__pluginStores.cues.getState().cues[16]'),undefined,'Sample created a cue');

  await evaluate(`document.querySelector('.cue-overwrite-row>button:last-child').click();true`);await delay(100);
  const samplePoint=await padPoint(16);before=await platform();motion('DOWN',samplePoint);await delay(750);motion('UP',samplePoint);
  await counts(before,1,1,'Sample remains one shot during overwrite and hold');
  assert.equal(await evaluate('__pluginStores.cues.getState().cues[16]'),undefined);
  await evaluate(`document.querySelector('.cue-overwrite-row>button:last-child').click();document.querySelector('.cue-sample-edit').click();true`);await delay(100);
  before=await platform();await tap(16);await counts(before,0,0,'Sample editing opens management without a hit');
  assert(await evaluate('Boolean(document.querySelector("[role=dialog]"))'));await closeDialog();
  await evaluate(`document.querySelector('.cue-sample-edit').click();__musikeAudioEl.removeAttribute('src');__pluginStores.player.setState({queue:[],index:0,status:'paused',position:0});true`);await delay(300);
  before=await platform();await tap(16);await counts(before,1,1,'Native sample plays without a song');
  assert.equal((await snapshot()).playing,false);
  await evaluate(`__pluginInvoke('padSample',{cmd:'remove',bank:'A',pad:16})`);loadedSample=false;
  await client.seed();
  await wait(()=>evaluate('!__pluginStores.samples.getState().samples["A:16"]'),'Removed sample did not leave the UI map');
  await evaluate('__pluginStores.cues.getState().clearCue(16);true');await delay(150);
  before=await platform();await tap(16);await counts(before,0,0,'Removed sample pad returns to empty-cue marking');
  before=await platform();await tap(16);await counts(before,1,1,'Removed sample pad subsequently plays its saved cue');
  console.log(JSON.stringify({result:'PASS',application,checks:results,platform:await platform()},null,2));
}finally{
  try{
    if(picking){adb('shell','input','keyevent','KEYCODE_BACK');await delay(200);}
    if(loadedSample)await evaluate(`__pluginInvoke('padSample',{cmd:'remove',bank:'A',pad:16})`);
    if(original)await evaluate(`localStorage.setItem('musike:cues:v1',${JSON.stringify(original.cues||'{}')});__pluginStores.cues.getState().setBank(${JSON.stringify(original.bank)});true`);
    await evaluate('__pluginInvoke("audio",{cmd:"pause"})');
  }catch{}
  if(fixture){adb('shell','rm','-f','/sdcard/Download/beatmaker-latency-pad.wav');await rm(fixture,{recursive:true,force:true});}
  client.close();
}
