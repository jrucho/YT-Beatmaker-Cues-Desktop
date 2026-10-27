// Real debug APK smoke test; install/launch on an arm64 device or emulator first.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const adb = (...args) => execFileSync(process.env.ADB || 'adb', args, {encoding:'utf8'}).trim();
const application = 'app.owaega.beatmakercuesstandalone';
const pid = adb('shell', 'pidof', application);
assert(/^\d+$/.test(pid), 'Launch the standalone debug app first');
adb('forward', 'tcp:9223', `localabstract:webview_devtools_remote_${pid}`);
const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const target = targets.find(target => target.url === 'https://juce.backend/');
assert(target, 'The real embedded editor must be loaded');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject) => {socket.onopen=resolve;socket.onerror=reject;});
let counter=0;
const pending=new Map();
socket.onmessage=event=>{
  const reply=JSON.parse(event.data),job=pending.get(reply.id);
  if(!job)return;
  pending.delete(reply.id);clearTimeout(job.timer);
  if(reply.error||reply.result?.exceptionDetails)job.reject(Error(JSON.stringify(reply.error||reply.result.exceptionDetails)));
  else job.resolve(reply.result.result.value);
};
const evaluate=expression=>new Promise((resolve,reject)=>{
  const id=++counter;
  const timer=setTimeout(()=>{pending.delete(id);reject(Error('Android CDP evaluation timed out'));},100000);
  pending.set(id,{resolve,reject,timer});
  socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
});
const snapshot=()=>evaluate('__pluginInvoke("audio",{cmd:"snapshot"})');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  const layout=await evaluate(`({viewport:innerHeight,root:document.documentElement.getBoundingClientRect().height,app:document.querySelector('.music-app')?.getBoundingClientRect().height,main:document.querySelector('main')?.getBoundingClientRect().height})`);
  assert(layout.root>=layout.viewport-2&&layout.app>=layout.viewport-2&&layout.main>layout.viewport*.6,
    'Android content collapsed behind a black region: '+JSON.stringify(layout));
  const catalog=await evaluate(`(async()=>{
    if(typeof __pluginInvoke!=='function')throw Error('Native bridge missing');
    const page=await __pluginStores.api.youtubePlaylist('PLW4NDfp3IicGyAw0Ix0Z0yr-FL35Eo_qB');
    const track=page.tracks.find(track=>track.id==='7sFnp7bKwdE');
    if(!track)throw Error('Long AAC fixture missing from live catalog');
    __pluginStores.player.setState({repeat:'one',autoRadio:false});
    __pluginStores.player.getState().playList([track]);
    return {count:page.tracks.length,title:page.title};
  })()`);
  assert.equal(catalog.count,500);
  let state;
  for(let i=0;i<100;++i){state=await snapshot();if(state.ready&&state.playing)break;await delay(1000);}
  assert(state.ready&&state.playing,'Native AAC playback did not start');
  assert(state.duration>640,'Long-track duration was truncated');
  await evaluate('__pluginStores.cues.getState().setCue(1,320);__pluginStores.player.getState().cue(320,{bank:"A",pad:1});true');
  await delay(1500);
  state=await snapshot();assert(state.playing&&state.position>=320&&state.position<325,'Native cue missed target');
  adb('shell','input','keyevent','KEYCODE_HOME');
  adb('shell','cmd','media_session','dispatch','pause');await delay(1000);
  assert.equal((await snapshot()).playing,false,'Background system pause failed');
  adb('shell','cmd','media_session','dispatch','play');await delay(1000);
  const first=await snapshot();await delay(1500);const second=await snapshot();
  assert(second.playing&&second.position>first.position+0.8,'Background system play did not advance native transport');
  adb('shell','cmd','media_session','dispatch','pause');await delay(1000);
  assert.equal((await snapshot()).playing,false);
  console.log(JSON.stringify({result:'PASS',layout,catalog,backgroundPositions:[first.position,second.position],load:await evaluate('__pluginInvoke("loadDiagnostics")')},null,2));
}finally{
  adb('shell','am','start','-n',`${application}/app.musike.android.MainActivity`);
  socket.close();
}
