// Real emulator screen-off test: no WebView evaluation while the display is off.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const adb=(...args)=>execFileSync(process.env.ADB||'adb',args,{encoding:'utf8'}).trim();
const app='app.owaega.beatmakercuesstandalone',delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
assert.equal(adb('shell','getprop','ro.kernel.qemu'),'1','This automated lock/unlock test runs on the emulator');
adb('shell','input','keyevent','KEYCODE_WAKEUP');adb('shell','wm','dismiss-keyguard');
adb('shell','am','start','-W','-n',`${app}/app.musike.android.MainActivity`);
const pid=adb('shell','pidof',app);adb('forward','tcp:9223',`localabstract:webview_devtools_remote_${pid}`);
const pages=await(await fetch('http://127.0.0.1:9223/json/list')).json();
const page=pages.find(page=>page.url.startsWith('https://juce.backend/'));assert(page);
const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise(resolve=>socket.onopen=resolve);
let id=0;const pending=new Map();
socket.onmessage=event=>{const reply=JSON.parse(event.data),job=pending.get(reply.id);if(!job)return;pending.delete(reply.id);clearTimeout(job.timer);if(reply.error||reply.result?.exceptionDetails)job.reject(Error(JSON.stringify(reply)));else job.resolve(reply.result.result.value);};
const evaluate=expression=>new Promise((resolve,reject)=>{const request=++id,timer=setTimeout(()=>reject(Error('CDP timed out')),90000);pending.set(request,{resolve,reject,timer});socket.send(JSON.stringify({id:request,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});
const session=()=>{
  const raw=adb('shell','dumpsys','media_session'),part=raw.slice(raw.indexOf(`package=${app}`));
  const match=/state=PlaybackState \{state=(\w+)\(\d+\), position=(\d+)[^\n]*speed=([\d.]+)/.exec(part);
  return {state:match?.[1],position:Number(match?.[2]),speed:Number(match?.[3]),description:/description=([^\n]+)/.exec(part)?.[1]??''};
};
try{
  for(let attempt=0;attempt<50;++attempt){if(await evaluate('Boolean(window.__pluginStores)'))break;await delay(100);}
  const tracks=await evaluate(`(async()=>{const page=await __pluginStores.api.youtubePlaylist('PLW4NDfp3IicGyAw0Ix0Z0yr-FL35Eo_qB');const first=page.tracks.find(t=>t.id==='7sFnp7bKwdE');let next;for(const track of page.tracks){if(track.id!==first.id&&track.duration>90&&!(await __pluginInvoke('cachedTrack',track.id))?.url){next=track;break;}}if(!next)throw Error('No uncached next-song fixture');window.__screenOffTracks=[first,next];__pluginStores.player.setState({repeat:'off',autoRadio:false});__pluginStores.player.getState().playList([first]);return {first,next};})()`);
  for(let attempt=0;attempt<200;++attempt){if(await evaluate('__pluginStores.player.getState().status==="playing"&&__pluginStores.player.getState().duration>10'))break;await delay(100);}
  await evaluate(`(async()=>{__pluginStores.player.getState().clearLoop();__pluginStores.player.setState({queue:window.__screenOffTracks,original:null,repeat:'off',autoRadio:false});const native=await __pluginInvoke('audio',{cmd:'snapshot'});if(!native.ready||native.duration<10)throw Error('First song did not become ready');await __pluginInvoke('audio',{cmd:'seek',to:native.duration-1.5,sourceId:native.sourceId});return true;})()`);
  let nearEnd=false;
  for(let attempt=0;attempt<100;++attempt){const value=await evaluate('__pluginInvoke("audio",{cmd:"snapshot"})');if(value.ready&&value.position>value.duration-5){nearEnd=true;break;}await delay(20);}
  assert(nearEnd,'First song did not seek near its actual end before locking');
  adb('shell','input','keyevent','KEYCODE_SLEEP');
  socket.close();
  // Everything below uses Android's native media session, never the renderer.
  let next;
  for(let attempt=0;attempt<45;++attempt){await delay(1000);next=session();if(next.description.includes(tracks.next.title)&&next.state==='PLAYING'&&next.speed>0&&next.position>1000)break;}
  assert(next.description.includes(tracks.next.title)&&next.state==='PLAYING'&&next.speed>0,'Uncached next song did not play while locked: '+JSON.stringify(next));
  const firstPosition=next.position;await delay(45000);const later=session();
  assert(later.state==='PLAYING'&&later.description.includes(tracks.next.title)&&later.position>firstPosition+40000,'Screen-off playback stopped: '+JSON.stringify(later));
  assert(/mWakefulness=(Asleep|Dozing)/.test(adb('shell','dumpsys','power')),'Display did not remain asleep');
  console.log(JSON.stringify({result:'PASS',uncachedNext:tracks.next.id,title:tracks.next.title,lockedPositions:[firstPosition,later.position],rendererEvaluatedWhileLocked:false},null,2));
}finally{
  adb('shell','cmd','media_session','dispatch','pause');adb('shell','input','keyevent','KEYCODE_WAKEUP');adb('shell','wm','dismiss-keyguard');adb('shell','am','start','-W','-n',`${app}/app.musike.android.MainActivity`);socket.close();
}
