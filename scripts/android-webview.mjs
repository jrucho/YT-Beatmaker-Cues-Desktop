import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const adb=(...args)=>execFileSync(process.env.ADB||'adb',args,{encoding:'utf8'}).trim();
export async function connectAndroidWebView(){
  const application=process.env.ANDROID_APPLICATION_ID||'app.owaega.beatmakercuesstandalone';
  adb('shell','am','start','-W','-n',`${application}/app.musike.android.MainActivity`);
  const pid=adb('shell','pidof',application);assert(/^\d+$/.test(pid),'Native app process missing');
  adb('forward','tcp:9223',`localabstract:webview_devtools_remote_${pid}`);
  let target;
  for(let i=0;i<100;i++){
    const targets=await(await fetch('http://127.0.0.1:9223/json/list')).json();
    target=targets.find(value=>value.url.startsWith('https://juce.backend/'));
    if(target)break;
    await delay(100);
  }
  assert(target,'Real native editor missing; install a debug or internal latency-probe APK');
  const socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let counter=0;const pending=new Map();
  socket.onmessage=event=>{
    const reply=JSON.parse(event.data),job=pending.get(reply.id);if(!job)return;
    pending.delete(reply.id);clearTimeout(job.timer);
    if(reply.error||reply.result?.exceptionDetails)job.reject(Error(JSON.stringify(reply.error||reply.result.exceptionDetails)));
    else job.resolve(reply.result);
  };
  const call=(method,params)=>new Promise((resolve,reject)=>{
    const id=++counter,timer=setTimeout(()=>{pending.delete(id);reject(Error('Android CDP timeout'));},30000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate=expression=>call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}).then(result=>result.result.value);
  for(let i=0;i<100;i++){
    if(await evaluate('Boolean(window.__pluginStores&&!document.querySelector(".boot"))'))break;
    await delay(100);
  }
  assert(await evaluate('Boolean(window.__pluginStores&&window.__pluginPadTouch)'),'Android pad adapter unavailable');
  const platform=()=>evaluate('__pluginInvoke("androidPlatform")');
  const snapshot=()=>evaluate('__pluginInvoke("audio",{cmd:"snapshot"})');
  const padPoint=pad=>evaluate(`(()=>{const e=document.querySelector('.cue-pad-grid>div:nth-child(${pad})>.cue-pad');if(!e)throw Error('Pad missing');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,dpr:devicePixelRatio};})()`);
  // The JUCE WebView fills the edge-to-edge Activity. Safe insets are inside its
  // DOM, so DOM viewport coordinates scale directly to Android screen pixels.
  const motion=(action,point)=>adb('shell','input','motionevent',action,String(Math.round(point.x*point.dpr)),String(Math.round(point.y*point.dpr)));
  const seed=async()=>{
    assert(await evaluate(`(async()=>{const cached=await __pluginInvoke('cachedTrack','7sFnp7bKwdE');if(!cached?.url)return false;__pluginStores.player.setState({repeat:'one',autoRadio:false});__pluginStores.player.getState().playList([{id:'7sFnp7bKwdE',title:'Cached Android latency fixture',artist:'Test',kind:'song',duration:645,thumb:'',art:''}]);return true;})()`),'Prepare the cached AAC fixture using check-android-plugin.mjs first');
    let ready=false;
    for(let i=0;i<200;i++){const state=await snapshot();if(state.ready&&state.playing){ready=true;break;}await delay(50);}
    assert(ready,'Native cached fixture not ready');
    await evaluate(`document.querySelector('a[href="/cues"]')?.click();__pluginStores.cues.getState().setBank('A');true`);
    await delay(1000);
  };
  return {application,call,evaluate,platform,snapshot,padPoint,motion,seed,close:()=>socket.close()};
}
