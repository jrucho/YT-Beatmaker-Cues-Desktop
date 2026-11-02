// Checks actual cache misses when performing a later bank with all 160 cues set.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {connectAndroidWebView,delay} from './android-webview.mjs';

const client=await connectAndroidWebView();
const {evaluate,platform,snapshot,padPoint,motion}=client;
let original;
try{
  await evaluate('window.__disableAndroidPerformance=false;window.__disableAndroidPadTouch=false;true');
  await client.seed();
  original=await evaluate(`({cues:localStorage.getItem('musike:cues:v1'),bank:__pluginStores.cues.getState().bank,speed:__pluginStores.player.getState().speed,tuning:__pluginStores.player.getState().tuning,mode:__pluginStores.player.getState().speedMode})`);
  const speed=Number(process.argv.find(arg=>arg.startsWith('--speed='))?.split('=')[1]??0);
  const tuning=Number(process.argv.find(arg=>arg.startsWith('--tuning='))?.split('=')[1]??0);
  assert(Number.isFinite(speed)&&speed>=-75&&speed<=100&&Number.isFinite(tuning)&&tuning>=-12&&tuning<=12);
  const preparationStarted=performance.now();
  await evaluate(`(()=>{const store=__pluginStores.cues.getState();for(let bank=0;bank<10;bank++)for(let pad=1;pad<=16;pad++)store.setCue(pad,2+(bank*16+pad-1)*3.8,String.fromCharCode(65+bank));store.setBank('J');const player=__pluginStores.player.getState();player.clearLoop();player.setSpeedMode('speed');player.setSpeed(${speed});player.setTuning(${tuning});return true;})()`);
  // Measure preparation separately from a performed press. The old A-to-J
  // policy can never fully prepare J while earlier banks fill the cache.
  let prefetch;
  do{
    await delay(100);prefetch=await evaluate('__pluginInvoke("loadDiagnostics")');
    if(prefetch.cueCacheBank===9&&prefetch.readyCueHeads===16)break;
  }while(performance.now()-preparationStarted<(process.argv.includes('--allow-cold')?6000:20000));
  const preparationMs=performance.now()-preparationStarted;
  if(!process.argv.includes('--allow-cold'))assert.equal(prefetch.readyCueHeads,16,'The selected bank did not finish preparing its attacks');
  const order=[1,9,2,10,3,11,4,12,5,13,6,14,7,15,8,16],hits=[],before=await platform();
  for(const pad of order){
    const point=await padPoint(pad),target=2+(144+pad-1)*3.8;
    const previous=await evaluate('__pluginInvoke("loadDiagnostics")'),started=performance.now();
    motion('DOWN',point);
    let rendered=false;
    try{
      for(let i=0;i<150;i++){
        const state=await snapshot();
        if(state.playing&&!state.buffering&&state.position>target+.001&&state.position<target+2){rendered=true;break;}
        await delay(5);
      }
    }finally{motion('UP',point);}
    assert(rendered,`J${pad} did not render the cue audio`);
    const after=await evaluate('__pluginInvoke("loadDiagnostics")');
    hits.push({pad,cacheMisses:after.cacheMisses-previous.cacheMisses,hostObservedMs:performance.now()-started});
    await delay(150);
  }
  const after=await platform(),coldHits=hits.filter(hit=>hit.cacheMisses>0).length;
  const result={application:client.application,bank:'J',totalMarkedCues:160,speed,tuning,preparationMs,prefetch,coldHits,hits,
    xrunDelta:after.xRuns-before.xRuns,platform:after,
    note:'Native cache-miss counts test cue residency, including preserved-pitch speed/tuning. Host elapsed time includes adb/CDP overhead and is not physical speaker latency.'};
  const output=process.argv.indexOf('--output');if(output>=0)await writeFile(process.argv[output+1],JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
  if(!process.argv.includes('--allow-cold'))assert.equal(coldHits,0,'The selected bank must not lose its warmed attacks to earlier banks');
}finally{
  try{
    if(original)await evaluate(`localStorage.setItem('musike:cues:v1',${JSON.stringify(original.cues||'{}')});__pluginStores.cues.getState().setBank(${JSON.stringify(original.bank)});__pluginStores.player.getState().setSpeed(${original.speed});__pluginStores.player.getState().setTuning(${original.tuning});__pluginStores.player.getState().setSpeedMode(${JSON.stringify(original.mode)});true`);
    await evaluate('__pluginInvoke("audio",{cmd:"pause"})');
  }catch{}
  client.close();
}
