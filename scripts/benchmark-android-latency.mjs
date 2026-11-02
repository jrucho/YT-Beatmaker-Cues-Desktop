// Actual Android MotionEvent -> native render callback; physical output excluded.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {adb,connectAndroidWebView,delay} from './android-webview.mjs';

const client=await connectAndroidWebView();
const {application,call,evaluate,platform,snapshot,padPoint,motion}=client;
const mode=process.argv.includes('--baseline')?'original-ui':process.argv.includes('--bridge-only')?'direct-bridge':'native-touch';
const bursts=Number(process.argv.find(arg=>arg.startsWith('--bursts='))?.split('=')[1]??2);
assert(Number.isInteger(bursts)&&bursts>=0&&bursts<=4,'--bursts must be 0 (adaptive default), 1, 2, 3 or 4');
const stallMs=Number(process.argv.find(arg=>arg.startsWith('--renderer-stall='))?.split('=')[1]??(process.argv.includes('--renderer-stall')?400:0));
assert(Number.isFinite(stallMs)&&stallMs>=0&&stallMs<=10000,'Renderer stall must be 0–10000 ms');
const statistics=samples=>{
  const values=samples.slice(4).sort((a,b)=>a-b),quantile=q=>values[Math.floor((values.length-1)*q)];
  return {minimum:values[0],median:quantile(.5),p95:quantile(.95),maximum:values.at(-1),mean:values.reduce((a,b)=>a+b,0)/values.length};
};
try{
  await evaluate(`window.__disableAndroidPerformance=${mode==='original-ui'};window.__disableAndroidPadTouch=${mode!=='native-touch'};true`);
  if(application.endsWith('.latencyprobe')){
    assert(await evaluate(`window.__beatmakerPerformance.bufferBursts(${bursts})`),'Internal buffer control unavailable');
    await delay(3000);
  }
  await client.seed();
  await evaluate(`__pluginStores.cues.getState().setCue(1,1.25);__pluginStores.cues.getState().setCue(2,7.25);true`);
  await delay(1500);
  const pads=await Promise.all([padPoint(1),padPoint(2)]);
  const before=await platform(),observedMs=[],renderMs=[];
  for(let trial=0;trial<24;trial++){
    const index=trial%2,target=index?7.25:1.25,previous=await platform();
    let stall;
    if(stallMs){
      await evaluate('window.__latencyStallStarted=false;true');
      stall=call('Runtime.evaluate',{expression:`setTimeout(()=>{window.__latencyStallStarted=true;const end=performance.now()+${stallMs};while(performance.now()<end){}},0);true`,returnByValue:true});
      await delay(40);
    }
    const start=performance.now();motion('DOWN',pads[index]);
    let arrived=false,rendered;
    try{
      for(let poll=0;poll<100;poll++){
        const state=await snapshot();rendered=await platform();
        if(state.playing&&!state.buffering&&state.position>=target&&state.position<target+1+stallMs/1000&&rendered.fastCommandsRendered>previous.fastCommandsRendered){arrived=true;break;}
        if(performance.now()-start>stallMs+1500)break;
        await delay(2);
      }
    }finally{motion('UP',pads[index]);}
    await stall;
    assert(arrived,'Android touch did not reach its native cue target');
    observedMs.push(performance.now()-start);
    renderMs.push(rendered.lastFastCommandToRenderMs);
    await delay(150+(trial%7)*3);
    const after=await platform();
    assert.equal(after.fastCommandsAccepted-previous.fastCommandsAccepted,1,'One Android press must enqueue exactly one command, including its normal React event');
    assert.equal(after.nativeTouchCommands-previous.nativeTouchCommands,mode==='native-touch'?1:0,'Android native touch map did not match the intended input path');
  }
  const after=await platform();
  const result={mode,application,input:'Android input motionevent DOWN/UP',rendererStallMs:stallMs,
    requestedBursts:bursts,trials:observedMs.length,warmupDiscarded:4,
    device:{model:adb('shell','getprop','ro.product.model'),sdk:adb('shell','getprop','ro.build.version.sdk'),emulator:adb('shell','getprop','ro.kernel.qemu')==='1'},
    platformBefore:before,platformAfter:after,xrunDelta:after.xRuns-before.xRuns,
    nativeTouchToRenderMs:statistics(renderMs),nativeSamplesMs:renderMs,
    hostObservedMs:statistics(observedMs),hostSamplesMs:observedMs,
    note:'Native timing starts at Android MotionEvent eventTime and ends when its audio render callback completes. It excludes touch hardware scanning and speaker/output buffering. Host timing also includes adb process/CDP overhead. Emulator measurements do not establish physical Nothing Phone latency.'};
  const output=process.argv.indexOf('--output');if(output>=0)await writeFile(process.argv[output+1],JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}finally{try{await evaluate('__pluginInvoke("audio",{cmd:"pause"})');}catch{}client.close();}
