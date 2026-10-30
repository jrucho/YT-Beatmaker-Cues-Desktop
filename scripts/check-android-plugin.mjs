// Real debug APK smoke test; install/launch on an arm64 device or emulator first.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const adb = (...args) => execFileSync(process.env.ADB || 'adb', args, {encoding:'utf8'}).trim();
const application = 'app.owaega.beatmakercuesstandalone';
adb('shell','am','start','-W','-n',`${application}/app.musike.android.MainActivity`);
const pid = adb('shell', 'pidof', application);
assert(/^\d+$/.test(pid), 'Launch the standalone debug app first');
adb('forward', 'tcp:9223', `localabstract:webview_devtools_remote_${pid}`);
const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const target = targets.find(target => target.url.startsWith('https://juce.backend/'));
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
  else job.resolve(reply.result);
};
const call=(method,params)=>new Promise((resolve,reject)=>{
  const id=++counter;
  const timer=setTimeout(()=>{pending.delete(id);reject(Error('Android CDP evaluation timed out'));},100000);
  pending.set(id,{resolve,reject,timer});
  socket.send(JSON.stringify({id,method,params}));
});
const evaluate=expression=>call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}).then(result=>result.result.value);
const snapshot=()=>evaluate('__pluginInvoke("audio",{cmd:"snapshot"})');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  for(let attempt=0;attempt<50;++attempt){if(await evaluate('Boolean(window.__pluginStores&&document.querySelector(".music-app main"))'))break;await delay(100);}
  const layout=await evaluate(`({viewport:innerHeight,root:document.documentElement.getBoundingClientRect().height,app:document.querySelector('.music-app')?.getBoundingClientRect().height,main:document.querySelector('main')?.getBoundingClientRect().height})`);
  assert(layout.root>=layout.viewport-2&&layout.app>=layout.viewport-2&&layout.main>layout.viewport*.6,
    'Android content collapsed behind a black region: '+JSON.stringify(layout));
  const platform=await evaluate('__pluginInvoke("androidPlatform")');
  const safeHeader=await evaluate(`(()=>{const button=[...document.querySelectorAll('header.safe-top button[aria-label="Settings"]')].find(button=>button.getBoundingClientRect().width>0);return {top:button?.getBoundingClientRect().top,dpr:devicePixelRatio};})()`);
  assert(safeHeader.top>=platform.top/safeHeader.dpr,'Settings button overlaps the status bar/camera safe area');
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
  await evaluate(`document.querySelector('a[href="/cues"]')?.click();__pluginStores.cues.getState().setCue(1,320);__pluginStores.player.getState().cue(1);true`);
  await delay(1200); // Allow the newly marked cue's native page look-ahead to prime.
  const pad=await evaluate(`(async()=>{const button=document.querySelector('button[aria-label^="Pad 1:"]');if(!button)throw Error('Cue pad missing');button.scrollIntoView({block:'center'});await new Promise(requestAnimationFrame);const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  const touchStarted=Date.now();
  await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...pad,id:1,radiusX:4,radiusY:4,force:1}]});
  let touchToNativePositionMs;
  try{
    for(let i=0;i<20;++i){state=await snapshot();if(state.playing&&state.position>=320&&state.position<322){touchToNativePositionMs=Date.now()-touchStarted;break;}if(Date.now()-touchStarted>200)break;await delay(3);}
  }finally{await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  assert(touchToNativePositionMs!==undefined&&touchToNativePositionMs<250,'Touch-down did not promptly reach native cue playback');
  await delay(700);
  assert.equal(await evaluate('__pluginStores.cues.getState().cues[1]'),320,'Short touch unexpectedly overwrote the saved cue');
  adb('shell','input','keyevent','KEYCODE_HOME');
  adb('shell','cmd','media_session','dispatch','pause');await delay(1000);
  assert.equal((await snapshot()).playing,false,'Background system pause failed');
  adb('shell','cmd','media_session','dispatch','play');await delay(1000);
  const first=await snapshot();await delay(1500);const second=await snapshot();
  assert(second.playing&&second.position>first.position+0.8,'Background system play did not advance native transport');
  adb('shell','cmd','media_session','dispatch','pause');await delay(1000);
  assert.equal((await snapshot()).playing,false);
  const layouts=[];
  if(process.argv.includes('--layouts')){
    assert.equal(adb('shell','getprop','ro.kernel.qemu'),'1','Screen-size sweeps run on an emulator; use the normal smoke check on a physical device');
    // Android defers relayout of a background Activity until it returns.
    adb('shell','am','start','-W','-n',`${application}/app.musike.android.MainActivity`);
    await delay(500);
    try{
      for(const [width,height] of [[320,568],[360,760],[412,915],[568,320],[732,412],[760,760],[1280,600],[1600,480],[480,1400]]){
        adb('shell','wm','size',`${Math.round(width*safeHeader.dpr)}x${Math.round(height*safeHeader.dpr)}`);
        let geometry;
        for(let attempt=0;attempt<30;++attempt){
          await delay(100);
          geometry=await evaluate(`(()=>{
            const nav=document.querySelector('.cue-workspace-active>nav'),main=document.querySelector('main'),page=document.querySelector('.cue-workspace');
            const limit=nav?nav.getBoundingClientRect().top:innerHeight;
            const selectors=['.cue-pad-grid>div>button:first-child','.cue-bank-buttons button','.cue-speed input','.cue-speed-modes button','.cue-tuning button','.cue-loop button','.cue-library-back','.cue-midi-settings','.cue-playback-transport button','.cue-scrubber [role="slider"]','.cue-preset','.cue-queue-toggle','.cue-waveform'];
            const controls=selectors.flatMap(selector=>[...document.querySelectorAll(selector)].filter(element=>element.getClientRects().length>0).map(element=>{const r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {selector,top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,reachable:!!hit&&(element===hit||element.contains(hit))};}));
            const banks=[...document.querySelectorAll('.cue-bank-buttons button')].filter(e=>e.getClientRects().length>0).length,bankSelect=document.querySelector('.cue-bank-compact');
            return {viewport:[innerWidth,innerHeight],layout:document.documentElement.dataset.pluginLayout,pads:document.querySelectorAll('.cue-pad-grid>div>button:first-child').length,banks,compactBanks:!!bankSelect?.getClientRects().length,scroll:main.scrollHeight-main.clientHeight,pageHeight:page.clientHeight,limit,controls};
          })()`);
          if(Math.abs(geometry.viewport[0]-width)<=2&&Math.abs(geometry.viewport[1]-height)<=2&&geometry.controls.every(c=>c.width>=20&&c.height>=20&&c.top>=0&&c.bottom<=geometry.limit+2&&c.left>=0&&c.right<=geometry.viewport[0]+2&&c.reachable))break;
        }
        assert(Math.abs(geometry.viewport[0]-width)<=2&&Math.abs(geometry.viewport[1]-height)<=2,'Android viewport did not reach requested dimensions: '+JSON.stringify({requested:[width,height],actual:geometry.viewport}));
        assert.equal(geometry.pads,16);
        assert(geometry.banks===10||geometry.compactBanks,'Bank selection must remain visible');
        assert(geometry.scroll<=2,'Cue workspace must not require vertical scrolling: '+JSON.stringify(geometry));
        assert(geometry.controls.length>=30&&geometry.controls.every(c=>c.width>=20&&c.height>=20&&c.top>=0&&c.bottom<=geometry.limit+2&&c.left>=0&&c.right<=geometry.viewport[0]+2&&c.reachable),'Performance controls clipped or covered: '+JSON.stringify(geometry));
        layouts.push({viewport:geometry.viewport,layout:geometry.layout,pads:geometry.pads,scroll:geometry.scroll});
        if(width>=768){
          assert(await evaluate(`(async()=>{document.querySelector('.cue-library-back').click();await new Promise(r=>setTimeout(r,150));const back=[...document.querySelectorAll('a[href="/cues"]')].find(e=>e.getBoundingClientRect().width>0);if(!back)return false;back.click();await new Promise(r=>setTimeout(r,150));return !!document.querySelector('.cue-workspace input[type=range]');})()`),'Wide library must provide a working return to the cue workspace');
        }
      }
    }finally{adb('shell','wm','size','reset');}
  }
  console.log(JSON.stringify({result:'PASS',layout,layouts,platform,safeHeader,catalog,touchToNativePositionMs,timingNote:'Touch timing observes native transport, not physical audio output',backgroundPositions:[first.position,second.position],load:await evaluate('__pluginInvoke("loadDiagnostics")')},null,2));
}finally{
  adb('shell','am','start','-n',`${application}/app.musike.android.MainActivity`);
  socket.close();
}
