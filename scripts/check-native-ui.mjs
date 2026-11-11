// Real native UI build/bridge, deterministic media/library, tablet/phone/plugin sizes.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {inflateSync} from 'node:zlib';

function pngPixels(data){
  let width,height,channels;const chunks=[];
  for(let at=8;at<data.length;){const size=data.readUInt32BE(at),type=data.toString('ascii',at+4,at+8),bytes=data.subarray(at+8,at+8+size);if(type==='IHDR'){width=bytes.readUInt32BE(0);height=bytes.readUInt32BE(4);assert.equal(bytes[8],8);channels=bytes[9]===6?4:3;}if(type==='IDAT')chunks.push(bytes);at+=size+12;}
  const packed=inflateSync(Buffer.concat(chunks)),stride=width*channels,pixels=Buffer.alloc(stride*height);
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++){const filter=packed[y*(stride+1)];for(let x=0;x<stride;x++){const a=x>=channels?pixels[y*stride+x-channels]:0,b=y?pixels[(y-1)*stride+x]:0,c=y&&x>=channels?pixels[(y-1)*stride+x-channels]:0;pixels[y*stride+x]=(packed[y*(stride+1)+1+x]+(filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?paeth(a,b,c):0))&255;}}
  return {width,height,pixel:(x,y)=>[...pixels.subarray((y*width+x)*channels,(y*width+x)*channels+3)]};
}

const root=process.cwd(),web=path.join(root,'plugin/build-web');
const legacyIosPreview=process.argv.includes('--ios-preview');
const iosPreview=legacyIosPreview||process.argv.includes('--features');
const fixturePlatform=process.argv.find(value=>value.startsWith('--platform='))?.slice(11)||(legacyIosPreview?'ios':'desktop');
const microphoneName=fixturePlatform==='ios'?'iPhone microphone':'Built-in microphone',speakerName=fixturePlatform==='ios'?'iPhone speaker':'Device speaker';
const html=await readFile(path.join(web,'index.html'),'utf8');
const bootHtml=html.replace(/<script\b(?=[^>]*type="module")[^>]*src="([^"]+)"[^>]*><\/script>/,(_tag,src)=>`<script type="module">await window.__pluginInit;await import(${JSON.stringify(src)});</script>`);
const bridge=await readFile(path.join(root,'plugin/Web/bridge.js'),'utf8');
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname==='/fixture.js'){
    res.setHeader('content-type','text/javascript');return res.end(`
      const realStorage=window.localStorage;
      const art='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="teal"/></svg>');
      const tracks=Array.from({length:500},(_,i)=>({id:'ui'+String(i).padStart(9,'0'),title:(i%2?'A very long track title that must wrap safely without cutting the playlist ':'Short song ')+i,artist:'Artist '+i,duration:60,kind:'song',thumb:i%3===0?art:i%3===1?'':'/missing-art.png',art:i%3===0?art:i%3===1?'':'/missing-art.png'}));
      const library=JSON.parse(realStorage.getItem('ui-fixture-library')||'null')||{favorites:[],history:tracks.slice(0,16),playlists:[{id:'fixture-playlist',name:'A long playlist name '+('with words '.repeat(12)),tracks}]};
      window.__uiFixture={tracks,library,libraryVersion:1,position:12.125,sourceId:0,queue:{tracks:[],index:0},ready:false,playing:false,padSamples:JSON.parse(realStorage.getItem('ui-fixture-samples')||'[]'),localMedia:JSON.parse(realStorage.getItem('ui-fixture-media')||'[]'),regionRequests:[],waveformDelay:0,sampleTriggers:0,samplePreviews:0,cueTriggers:0,routes:{supported:true,platform:${JSON.stringify(fixturePlatform)},inputEnabled:false,inputActive:false,input:'automatic',output:'automatic',activeOutput:'speaker',outputAccepted:true,monitor:false,monitorLevel:.5,sampleRate:48000,inputs:[],actualInput:'Off',actualOutput:${JSON.stringify(speakerName)},permission:'granted'},recording:{hasTake:false,recording:false,source:'playback',seconds:0}};
      const listeners={};
      const emit=(name,value)=>(listeners[name]||[]).forEach(fn=>fn(value));
      const f=window.__uiFixture;f.emitNative=emit;f.loopSongs=JSON.parse(realStorage.getItem('ui-fixture-loopers')||'{}');f.loopRevision=0;f.mixer=JSON.parse(JSON.parse(realStorage.getItem('ui-fixture-session')||'{}')['musike:mixer']||'{"enabled":false,"song":1,"samples":1,"output":1.5}');
      const loopSong=()=>f.queue.tracks?.[f.queue.index||0]?.id||'@empty';
      const loopPads=()=>f.loopSongs[loopSong()]??=([]);
      const saveLoops=()=>{f.loopRevision++;realStorage.setItem('ui-fixture-loopers',JSON.stringify(f.loopSongs));};
      const captureLoop=(bank,pad)=>{const loop=loopPads().find(p=>p.mode===1||p.mode===3);if(!loop)return;if(loop.mode===3&&loop.undone){loop.events=loop.events.filter(word=>Number(BigInt(word)>>47n)!==loop.layers);loop.layers--;loop.undone=false;loop.base=loop.events.length;}const at=loop.mode===1?Math.round((Date.now()-loop.started)*48):Math.round((Date.now()-loop.playAt)*48)%loop.length;const layer=loop.mode===1?1:loop.layers+1;loop.events.push(Number(BigInt(at)|(BigInt(bank.charCodeAt(0)-65)<<32n)|(BigInt(pad-1)<<36n)|(127n<<40n)|(BigInt(layer)<<47n)));loop.count=loop.events.length;saveLoops();};
      const stopLoop=pad=>{if(pad.mode===1){pad.length=Math.max(48,Math.round((Date.now()-pad.started)*48));pad.duration=pad.length/48000;}if(pad.mode===3&&pad.events.length>pad.base)pad.layers++;pad.mode=0;};
      const pressLoop=pad=>{const now=Date.now(),double=pad.mode!==1&&f.loopLast===pad&&now-f.loopLastAt<300;f.loopLast=pad;f.loopLastAt=now;if(f.loopHold)clearTimeout(f.loopHold);if(double){stopLoop(pad);}else if(pad.mode===1){stopLoop(pad);pad.mode=2;pad.playAt=now;}else if(pad.mode===2){pad.mode=3;pad.base=pad.events.length;}else if(pad.mode===3){stopLoop(pad);pad.mode=2;}else{for(const other of loopPads())if(other!==pad&&other.mode)stopLoop(other);if(!pad.length){pad.mode=1;pad.started=now;pad.layers=1;pad.events=[];pad.count=0;}else{pad.mode=2;pad.playAt=now;}}f.loopHold=setTimeout(()=>{if(double){pad.undone=!pad.undone;pad.mode=2;}else{pad.mode=0;pad.events=[];pad.count=pad.length=pad.duration=pad.layers=0;}saveLoops();},double?600:1200);saveLoops();};
      window.__JUCE__={initialisationData:{hostedPlugin:[${url.searchParams.get('hosted')==='1'}],desktopPlatform:[${fixturePlatform==='desktop'}],nativePlatform:[${JSON.stringify(fixturePlatform)}],performanceFeatures:[${iosPreview}],iosPreviewFeatures:[${legacyIosPreview}],songTransitions:[${iosPreview}],pluginStorage:['{}']},backend:{
        addEventListener(name,fn){(listeners[name]??=[]).push(fn);},
        emitEvent(event,{name,params,resultId}){setTimeout(()=>{
          let result=true;const f=window.__uiFixture,request=params[0];
          if(name==='initialState')result={defaults:'{}',session:realStorage.getItem('ui-fixture-session')||JSON.stringify(${url.searchParams.get('hosted')==='1'}?{'musike:midi:preset':'linear16'}:{})};
          else if(name==='store'){realStorage.setItem('ui-fixture-session',request);f.savedSession=request;}
          else if(name==='libraryVersion')result=String(f.libraryVersion);
          else if(name==='librarySnapshot')result={json:JSON.stringify(library),version:String(f.libraryVersion)};
          else if(name==='libraryRead')result=JSON.stringify(library);
          else if(name==='libraryCommit'){Object.assign(library,JSON.parse(request.next));f.libraryVersion++;realStorage.setItem('ui-fixture-library',JSON.stringify(library));result=JSON.stringify(library);}
          else if(name==='localMedia')result=f.localMedia;
          else if(name==='renameLocalAudio'){const track=f.localMedia.find(track=>track.id===request.id),previousTitle=track.title;track.title=request.title.trim();const update=items=>items.forEach(item=>{if(item.id===track.id)item.title=track.title;});update(library.favorites);update(library.history);library.playlists.forEach(playlist=>update(playlist.tracks));f.libraryVersion++;realStorage.setItem('ui-fixture-media',JSON.stringify(f.localMedia));realStorage.setItem('ui-fixture-library',JSON.stringify(library));result={track:structuredClone(track),previousTitle,library:JSON.stringify(library)};}
          else if(name==='mixer'){if(request)Object.assign(f.mixer,request);result=structuredClone(f.mixer);}
          else if(name==='transitions'){if(request)f.transitions=request;result=f.transitions||{enabled:true,seconds:.35};}
          else if(name==='looperState'){result={song:loopSong(),revision:f.loopRevision,generation:1,pads:structuredClone(loopPads().map(pad=>({...pad,duration:pad.mode===1?(Date.now()-pad.started)/1000:pad.duration,length:pad.mode===1?Math.max(48,Math.round((Date.now()-pad.started)*48)):pad.length})))};}
          else if(name==='looperPad'){
            if(request.cmd==='restore'){f.loopSongs[request.data.song||loopSong()]=structuredClone(request.data.pads).map(pad=>({...pad,mode:0}));saveLoops();}
            else{let pad=loopPads().find(pad=>pad.bank===request.bank&&pad.pad===request.pad);
              if(request.cmd==='assign'&&!pad){pad={bank:request.bank,pad:request.pad,mode:0,length:0,duration:0,count:0,layers:0,undone:false,events:[]};loopPads().push(pad);saveLoops();}
              else if(request.cmd==='remove'){f.loopSongs[loopSong()]=loopPads().filter(pad=>pad.bank!==request.bank||pad.pad!==request.pad);saveLoops();}
              else if(pad&&request.cmd==='press')pressLoop(pad);
              else if(request.cmd==='release'){if(f.loopHold)clearTimeout(f.loopHold);f.loopHold=null;}
            }
          }
          else if(name==='remapLoopers'){for(const [song,pads] of Object.entries(f.loopSongs)){if(request.scope!=='all'&&song!==(request.scope||'@empty'))continue;for(const pad of pads){const mapping=request.mappings.find(row=>row.bank===pad.bank&&pad.pad<=row.pads.length);if(mapping)pad.pad=mapping.pads.indexOf(pad.pad)+1;pad.mode=0;}}saveLoops();}
          else if(name==='eraseLocalAudio'){f.localMedia=f.localMedia.filter(track=>track.id!==request.id);library.favorites=library.favorites.filter(track=>track.id!==request.id);library.history=library.history.filter(track=>track.id!==request.id);for(const playlist of library.playlists)playlist.tracks=playlist.tracks.filter(track=>track.id!==request.id);delete f.loopSongs[request.id];f.libraryVersion++;realStorage.setItem('ui-fixture-media',JSON.stringify(f.localMedia));realStorage.setItem('ui-fixture-library',JSON.stringify(library));saveLoops();(f.erasedAudio??=[]).push(request.id);result={erased:true,retainedForAnotherUse:false,library:JSON.stringify(library)};}
          else if(name==='shareAudio'){(f.sharedAudio??=[]).push(request.id);result={shared:!f.cancelAudioShare,cancelled:!!f.cancelAudioShare};}
          else if(name==='audioRoutes')result=structuredClone(f.routes);
          else if(name==='configureAudio'){if(request.output==='usb'&&f.rejectUSB)result={__error:'No SP-404 / USB audio card is available'};else{Object.assign(f.routes,request);if('monitor' in request){f.routes.monitorRequested=request.monitor;f.routes.monitorSuspended=false;}f.routes.inputActive=f.routes.inputEnabled;f.routes.actualInput=f.routes.inputEnabled?(f.routes.input==='usb'?'USB interface':${JSON.stringify(microphoneName)}):'Off';f.routes.actualOutput=f.routes.output==='usb'?'USB interface':${JSON.stringify(speakerName)};f.routes.activeOutput=f.routes.output==='usb'?'usb':'speaker';f.routes.outputAccepted=true;result=structuredClone(f.routes);}}
          else if(name==='recordAudio'){
            if(request.cmd==='recover')result=[];
            else if(request.cmd==='start'){f.recording={hasTake:true,recording:true,source:request.source,seconds:0,inputPeak:.2};f.recordingStarted=Date.now();result=structuredClone(f.recording);}
            else if(request.cmd==='stop'){const track={id:'locrecord01',title:'Recorded take',artist:'Recorded audio input',duration:2,kind:'song',thumb:'',art:''};f.recording={...f.recording,hasTake:false,recording:false};f.localMedia.push(track);realStorage.setItem('ui-fixture-media',JSON.stringify(f.localMedia));result={track};}
            else {if(f.recording.recording)f.recording.seconds=(Date.now()-f.recordingStarted)/1000;result=structuredClone(f.recording);}
          }
          else if(name==='importAudio'){
            const imported=[{id:'locimport01',title:'Imported kick',artist:'Local audio',duration:12,kind:'song',thumb:'',art:''},{id:'locimport02',title:'Imported phrase',artist:'Local audio',duration:8,kind:'song',thumb:'',art:''}];
            f.localMedia=[...new Map([...f.localMedia,...imported].map(track=>[track.id,track])).values()];realStorage.setItem('ui-fixture-media',JSON.stringify(f.localMedia));result={tracks:imported,errors:[]};
          }
          else if(name==='importGallery'){f.galleryOpens=(f.galleryOpens||0)+1;if(f.cancelGallery)result={tracks:[],errors:[]};else{const track={id:'locgallery1',title:'Gallery video',artist:'Video audio',duration:12,kind:'song',thumb:'',art:''};f.localMedia=[...new Map([...f.localMedia,track].map(track=>[track.id,track])).values()];realStorage.setItem('ui-fixture-media',JSON.stringify(f.localMedia));result={tracks:[track],errors:[]};}}
          else if(name==='samplerSource'){const track=f.localMedia.find(track=>track.id===request.id)||request;result={...track,peaks:Array.from({length:2048},(_,i)=>.15+(i%29)/40)};f.samplerSource=result;}
          else if(name==='samplerPreview'){if(request.cmd!=='stop'){f.chopPreviews=(f.chopPreviews||0)+1;f.chopPreview=request;}else f.chopStopped=true;}
          else if(name==='chopAudio'){
            for(let i=0;i<request.slices;i++){const pad=request.pad+i;f.padSamples=f.padSamples.filter(sample=>sample.bank!==request.bank||sample.pad!==pad);f.padSamples.push({bank:request.bank,pad,name:f.samplerSource.title+' · '+(i+1),duration:(request.to-request.from)/request.slices,ready:true,path:'/fixture/chop-'+request.bank+pad+'.wav',start:0,peaks:Array(256).fill(.5)});}
            realStorage.setItem('ui-fixture-samples',JSON.stringify(f.padSamples));result=structuredClone(f.padSamples);
          }
          else if(name==='assignPadSamples'){for(const item of request){f.padSamples=f.padSamples.filter(sample=>sample.bank!==item.bank||sample.pad!==item.pad);if(item.descriptor)f.padSamples.push(structuredClone(item.descriptor));}realStorage.setItem('ui-fixture-samples',JSON.stringify(f.padSamples));result=structuredClone(f.padSamples);}
          else if(name==='padSamples')result=f.padSamples;
          else if(name==='remapPadSamples'){
            f.padSamples=f.padSamples.map(sample=>{const row=request.find(row=>row.bank===sample.bank&&sample.pad<=row.pads.length);return row?{...sample,pad:row.pads.indexOf(sample.pad)+1}:sample;});
            realStorage.setItem('ui-fixture-samples',JSON.stringify(f.padSamples));result=structuredClone(f.padSamples);
          }
          else if(name==='padSample'){
            if(request.cmd==='trigger'){f.sampleTriggers++;captureLoop(request.bank,request.pad);result=true;}
            else if(request.cmd==='preview'){f.samplePreviews++;f.previewStart=request.start;result=true;}
            else {const old=f.padSamples.find(pad=>pad.bank===request.bank&&pad.pad===request.pad);
              if(request.cmd==='start'&&old)old.start=request.start;
              if(request.cmd==='remove'||request.cmd==='restore'){f.padSamples=f.padSamples.filter(pad=>pad.bank!==request.bank||pad.pad!==request.pad);if(request.descriptor)f.padSamples.push(request.descriptor);}
              realStorage.setItem('ui-fixture-samples',JSON.stringify(f.padSamples));result=structuredClone(f.padSamples);}
          }
          else if(name==='midiOptions'){Object.assign(f.midiOptions??={},request);if('suspendPadActions' in request)(f.midiGuardCalls??=[]).push(request.suspendPadActions);}
          else if(name==='waveform')result={peaks:Array(1024).fill(.5),progress:1};
          else if(name==='waveformRegion'){f.regionRequests.push(request);result={peaks:Array.from({length:1024},(_,i)=>.2+(i%19)/25),from:request.from,to:request.to,duration:request.sample ? 0.5 : 60};}
          else if(name==='cachedTrack')result={...tracks.find(t=>t.id===request),...f.localMedia.find(t=>t.id===request),url:'beatmaker-local://'+request,mime:'audio/wav',duration:60};
          else if(name==='audio'){
            if(request.cmd==='navigate'){const old=loopSong(),index=request.action==='next'?f.queue.index+1:request.action==='previous'?Math.max(0,f.queue.index-1):request.index;if(index>=0&&index<f.queue.tracks.length){f.queue.index=index;f.position=0;f.playing=f.ready=true;for(const pad of f.loopSongs[old]||[])if(pad.mode)stopLoop(pad);saveLoops();const track=f.queue.tracks[index],payload={sourceId:f.sourceId,queueIndex:index,trackId:track.id,position:0,duration:60,buffered:60,ready:true,playing:true,url:'beatmaker-local://'+track.id,loop:track.loop};setTimeout(()=>emit('pluginAudio',{event:'track',payload}),0);result={accepted:true};}else result={accepted:false};}
            if(request.cmd==='load'){const previous=loopSong();f.sourceId=request.sourceId;f.queue=request.queue;f.ready=!!request.url;f.position=request.startAt||0;if(!request.url)f.playing=false;if(previous!==loopSong()){for(const pad of f.loopSongs[previous]||[])if(pad.mode)stopLoop(pad);saveLoops();}}
            if(request.cmd==='queue'){const previous=loopSong();f.queue=request.queue;if(previous!==loopSong()){for(const pad of f.loopSongs[previous]||[])if(pad.mode)stopLoop(pad);saveLoops();}}
            if(request.cmd==='play')f.playing=true;
            if(request.cmd==='pause')f.playing=false;
             if(request.cmd==='seek'||request.cmd==='cue')f.position=request.to;
              if(request.cmd==='cue'){f.cueTriggers++;f.lastCue=request;if(request.bank&&request.pad)captureLoop(request.bank,request.pad);}
             if(request.cmd==='rate')f.rateOptions=request;
            if(request.cmd==='load'&&!request.url){const store=window.__pluginStores.cues.getState(),cues=JSON.parse(localStorage.getItem('musike:cues:v1')||'{}')[store.trackId]||{};if(f.unloadFinalCue)cues[store.bank]={...cues[store.bank],...f.unloadFinalCue};result={previousCues:{trackId:store.trackId,bank:store.bank,cues}};}
            else if(request.cmd==='position')result={position:f.position};
            else if(request.cmd==='snapshot')result={...f,position:f.position,duration:f.ready?60:0,buffered:f.ready?60:0,queueIndex:f.queue.index||0,trackId:f.queue.tracks?.[f.queue.index||0]?.id};
            else if(request.cmd!=='navigate')result={};
            if(request.cmd==='load'&&request.url)setTimeout(()=>emit('pluginAudio',{event:'ready',payload:{sourceId:f.sourceId,duration:60}}),0);
            if(request.cmd==='play'||request.cmd==='pause')setTimeout(()=>emit('pluginAudio',{event:request.cmd==='play'?'playing':'pause',payload:{sourceId:f.sourceId}}),0);
          }
          else if(name==='http')result={status:200,headers:{},data:'{}'};
          if(name==='waveformRegion'&&f.waveformDelay)setTimeout(()=>emit('__juce__complete',{promiseId:resultId,result}),f.waveformDelay);else emit('__juce__complete',{promiseId:resultId,result});
        },0);}
      }};
    `);
  }
  if(url.pathname==='/bridge.js'){res.setHeader('content-type','text/javascript');return res.end(bridge);}
  if(url.pathname==='/missing-art.png'){res.statusCode=404;return res.end();}
  if(url.pathname.startsWith('/assets/')){
    try{const data=await readFile(path.join(web,url.pathname));res.setHeader('content-type',url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'font/woff2');return res.end(data);}catch{res.statusCode=404;return res.end();}
  }
  res.setHeader('content-type','text/html');res.end(bootHtml.replace('<head>',`<head><script src="/fixture.js?hosted=${url.searchParams.get('hosted')==='1'?'1':'0'}"></script><script src="/bridge.js"></script>`));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1024,height:768},hasTouch:true});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?hosted=1`);
  await page.waitForFunction(()=>window.__pluginStores&&document.querySelector('.music-app'));
  await page.locator('.boot').waitFor({state:'detached'});
  await page.evaluate(()=>{document.documentElement.style.setProperty('--plugin-safe-bottom','20px');window.__pluginStores.player.getState().playList(window.__uiFixture.tracks);});
  await page.waitForFunction(()=>window.__pluginStores.player.getState().status==='playing');
  const navigate=async route=>{await page.evaluate(route=>[...document.querySelectorAll('a')].find(a=>a.getAttribute('href')===route&&a.getBoundingClientRect().width>0)?.click(),route);};
  await navigate('/cues');
  await page.getByLabel('Pad layout preset',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Pad layout preset',{exact:true}).inputValue(),'linear16','Fresh plug-in defaults to the ascending 16-pad preset');
  assert.equal(await page.locator('.cue-pad').count(),16);
  if(iosPreview){
    const preset=page.getByLabel('Pad layout preset',{exact:true});
    const visualPads=()=>page.locator('.cue-pad').evaluateAll(nodes=>nodes.map(node=>({pad:Number(node.dataset.padNumber),r:node.getBoundingClientRect()})).sort((a,b)=>Math.abs(a.r.y-b.r.y)>5?a.r.y-b.r.y:a.r.x-b.r.x).map(row=>row.pad));
    const checkBottomLeft=async count=>{
      for(const [width,height] of [[393,852],[852,393],[320,568],[568,320],[1024,768]]){
        await page.setViewportSize({width,height});await page.waitForTimeout(120);
        const points=await page.locator('.cue-pad').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {pad:Number(node.dataset.padNumber),x:r.x,y:r.y};}));
        const first=points.find(point=>point.pad===1),last=points.find(point=>point.pad===count);
        assert(Math.abs(first.x-Math.min(...points.map(point=>point.x)))<1&&Math.abs(first.y-Math.max(...points.map(point=>point.y)))<5,'Pad 1 must be bottom-left at '+width+'x'+height);
        assert(Math.abs(last.x-Math.max(...points.map(point=>point.x)))<1&&Math.abs(last.y-Math.min(...points.map(point=>point.y)))<5,'Last pad must be top-right at '+width+'x'+height);
      }
    };
    const chooseOrder=async value=>{
      await page.getByRole('button',{name:'MIDI settings',exact:true}).click();
      await page.getByLabel('Pad numbering',{exact:true}).selectOption(value);
      await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
      await page.waitForFunction(value=>document.querySelector('.cue-pad-grid')?.dataset.padOrder===value,value);
    };
    assert.deepEqual(await visualPads(),Array.from({length:16},(_,i)=>i+1));
    await page.evaluate(()=>{
      window.__pluginStores.cues.getState().setCue(1,12.125);
      window.__uiFixture.padSamples=[{bank:'A',pad:2,name:'Position-stable kick',duration:.5,ready:true,path:'/fixture/position.wav',start:.03}];
      window.dispatchEvent(new CustomEvent('plugin-pad-samples',{detail:window.__uiFixture.padSamples}));
    });
    const visualSounds=()=>page.locator('.cue-pad').evaluateAll(nodes=>nodes.map(node=>({text:node.querySelector('span:nth-child(2)').textContent,r:node.getBoundingClientRect()})).sort((a,b)=>Math.abs(a.r.y-b.r.y)>5?a.r.y-b.r.y:a.r.x-b.r.x).map(row=>row.text));
    const originalSounds=await visualSounds();
    await chooseOrder('bottom-left');
    assert.deepEqual(await visualPads(),[13,14,15,16,9,10,11,12,5,6,7,8,1,2,3,4]);
    assert.deepEqual(await visualSounds(),originalSounds,'Numbering moved the already placed audio');
    assert.equal(await page.evaluate(()=>window.__pluginStores.samples.getState().samples['A:14']?.start),.03,'Renumbering lost the sample or its edited start');
    await page.getByRole('button',{name:'Undo edit',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cue-pad-grid').dataset.padOrder==='top-left');
    assert.deepEqual(await visualSounds(),originalSounds,'Undoing numbering moved the audio');
    await page.getByRole('button',{name:'Redo edit',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cue-pad-grid').dataset.padOrder==='bottom-left');
    assert.deepEqual(await visualSounds(),originalSounds,'Redoing numbering moved the audio');
    await checkBottomLeft(16);
    await page.evaluate(()=>{window.__uiFixture.position=12.125;});
    await page.locator('.cue-pad[data-pad-number="1"]').click();
    await page.waitForFunction(()=>window.__pluginStores.cues.getState().cues[1]===12.125);
    assert.equal(await page.evaluate(()=>window.__pluginStores.cues.getState().cues[13]),12.125,'Renumbering moved the original top-left cue');
    await preset.selectOption('legacy12');
    assert.deepEqual(await visualPads(),Array.from({length:12},(_,i)=>i+1),'12-pad origin has its own default');
    await chooseOrder('bottom-left');
    assert.deepEqual(await visualPads(),[10,11,12,7,8,9,4,5,6,1,2,3]);
    await checkBottomLeft(12);
    await chooseOrder('top-left');
    assert.deepEqual(await visualPads(),Array.from({length:12},(_,i)=>i+1));
    for(const id of ['sp404mkii-a','sp404mkii-b']){
      await preset.selectOption(id);
      assert.deepEqual(await visualPads(),Array.from({length:16},(_,i)=>i+1),'SP-404 layout moved');
      await page.getByRole('button',{name:'MIDI settings',exact:true}).click();
      assert.equal(await page.getByLabel('Pad numbering',{exact:true}).count(),0,'SP-404 must not expose the numbering override');
      await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    }
    await preset.selectOption('linear16');
    assert.deepEqual(await visualPads(),[13,14,15,16,9,10,11,12,5,6,7,8,1,2,3,4]);
    await page.waitForFunction(()=>{const saved=JSON.parse(window.__uiFixture.savedSession||'{}');const orders=JSON.parse(saved['musike:midi:pad-order']||'{}');return saved['musike:midi:preset']==='linear16'&&orders.linear16==='bottom-left'&&orders.legacy12==='top-left';});
    await page.reload();await page.locator('.cue-pad-grid[data-pad-order="bottom-left"]').waitFor();
    assert.deepEqual(await visualPads(),[13,14,15,16,9,10,11,12,5,6,7,8,1,2,3,4],'Numbering origin did not survive native session reload');
    assert.equal(await page.evaluate(()=>window.__pluginStores.cues.getState().cues[1]),12.125);
    console.log('PASS: iPhone preview 16/12 numbering, position-stable cue/sample contents with undo/redo, retained sample starts, saved preferences, restart and fixed SP-404 layouts.');
    await page.getByRole('button',{name:'MIDI settings',exact:true}).click();
    const velocity=page.getByRole('switch',{name:'MIDI velocity',exact:true});
    assert.equal(await velocity.getAttribute('aria-checked'),'true');await velocity.click();
    assert.equal(await velocity.getAttribute('aria-checked'),'false');
    await page.getByLabel('Bank buttons',{exact:true}).selectOption('paired');
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'detached'});
    assert.deepEqual(await page.locator('.cue-bank-pair').allTextContents(),['A/F','B/G','C/H','D/I','E/J']);
    await page.evaluate(()=>window.__pluginStores.cues.getState().setBank('A'));
    const firstPair=page.getByRole('button',{name:/^Bank A\/F/});
    await firstPair.click();await page.waitForFunction(()=>window.__pluginStores.cues.getState().bank==='F');
    assert(await firstPair.evaluate(button=>button.classList.contains('cue-bank-second-active')));
    await firstPair.click();await page.waitForFunction(()=>window.__pluginStores.cues.getState().bank==='A');
    assert(!(await firstPair.evaluate(button=>button.classList.contains('cue-bank-second-active'))));
    const lastPair=page.getByRole('button',{name:/^Bank E\/J/});await lastPair.click();await lastPair.click();
    await page.waitForFunction(()=>window.__pluginStores.cues.getState().bank==='J');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await lastPair.evaluate(button=>getComputedStyle(button).animationName),'none');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.waitForFunction(()=>{const saved=JSON.parse(window.__uiFixture.savedSession||'{}');return saved['musike:midi:velocity']==='off'&&saved['musike:midi:bank-buttons']==='paired'&&saved['musike:cue-bank']==='J'&&window.__uiFixture.midiOptions?.velocityEnabled===false;});
    await page.reload();await page.locator('.cue-bank-buttons[data-bank-mode="paired"]').waitFor();
    await page.getByRole('button',{name:'MIDI settings',exact:true}).click();
    assert.equal(await page.getByRole('switch',{name:'MIDI velocity',exact:true}).getAttribute('aria-checked'),'false');
    assert.equal(await page.getByLabel('Bank buttons',{exact:true}).inputValue(),'paired');
    await page.getByLabel('Bank buttons',{exact:true}).selectOption('separate');
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    assert.equal(await page.locator('.cue-bank-buttons>button').count(),10);
    await page.evaluate(()=>window.__pluginStores.cues.getState().setBank('A'));
    console.log('PASS: velocity/native option persistence, A/F–E/J switching, pulsing second banks, reduced-motion fallback, restart and original ten-bank layout.');
    await page.evaluate(()=>{const player=window.__pluginStores.player.getState();player.setSpeed(23);player.setSpeedMode('pitch');player.setTuning(5);});
    const playback=()=>page.evaluate(()=>{const state=window.__pluginStores.player.getState();return {speed:state.speed,speedMode:state.speedMode,tuning:state.tuning};});
    assert.deepEqual(await playback(),{speed:23,speedMode:'pitch',tuning:5});
    await page.evaluate(()=>window.__pluginStores.player.getState().jumpTo(1));
    await page.waitForFunction(()=>window.__pluginStores.player.getState().index===1);
    assert.deepEqual(await playback(),{speed:0,speedMode:'speed',tuning:0},'An unseen song inherited the previous speed/tuning');
    await page.evaluate(()=>{const player=window.__pluginStores.player.getState();player.setSpeed(-15);player.setSpeedMode('speed');player.setTuning(-4);});
    await page.evaluate(()=>window.__pluginStores.player.getState().jumpTo(0));
    await page.waitForFunction(()=>window.__pluginStores.player.getState().index===0);
    assert.deepEqual(await playback(),{speed:23,speedMode:'pitch',tuning:5},'Returning to a song did not restore its playback controls');
    await page.waitForFunction(()=>{const saved=JSON.parse(window.__uiFixture.savedSession||'{}');const songs=JSON.parse(saved['musike:track-playback']||'{}');return JSON.parse(saved['musike:player']||'{}').index===0&&songs.ui000000000?.speed===23&&songs.ui000000001?.tuning===-4;});
    await page.reload();await page.locator('.cue-pad-grid').waitFor();
    assert.deepEqual(await playback(),{speed:23,speedMode:'pitch',tuning:5},'Playback controls did not survive a native-session reload');
    await page.evaluate(()=>{const player=window.__pluginStores.player.getState();player.setSpeed(0);player.setSpeedMode('speed');player.setTuning(0);});
    console.log('PASS: automatic per-song speed/mode/tuning recall, neutral defaults, saved independent settings and restart persistence without extra toolbar controls.');
    await page.evaluate(()=>window.__pluginStores.player.getState().toggle());
    await page.waitForFunction(()=>window.__musikeAudioEl.readyState>0&&window.__pluginStores.player.getState().status==='playing');
    await page.evaluate(()=>window.__pluginStores.cues.getState().setCue(1,12.125));
    await page.getByRole('button',{name:'Fine waveform edit',exact:true}).click();
    const fine=page.getByLabel('Edit selected cue waveform',{exact:true});
    const bounds=await fine.boundingBox();
    const beforeLiveCue=await page.evaluate(()=>window.__uiFixture.cueTriggers);
    await page.mouse.move(bounds.x+bounds.width*.75,bounds.y+bounds.height*.5);await page.mouse.down();
    await page.mouse.move(bounds.x+bounds.width*.8,bounds.y+bounds.height*.5);
    await page.waitForTimeout(60);assert.equal(await page.evaluate(()=>window.__uiFixture.cueTriggers),beforeLiveCue,'Default unheld cue dragging must remain silent');
    assert.equal(await page.evaluate(()=>window.__pluginStores.cues.getState().cues[1]),12.125,'Dragging must commit one undoable edit on release');
    await page.mouse.up();
    const edited=await page.evaluate(()=>window.__pluginStores.cues.getState().cues[1]);
    assert(Math.abs(edited-12.725)<.02,'Fine cue dragging did not use the zoomed window');
    await page.getByRole('button',{name:'Undo edit',exact:true}).click();
    await page.waitForFunction(()=>window.__pluginStores.cues.getState().cues[1]===12.125);
    await page.getByRole('button',{name:'Redo edit',exact:true}).click();
    await page.waitForFunction(value=>window.__pluginStores.cues.getState().cues[1]===value,edited);
    const oldWindow=await fine.evaluate(node=>Number(node.dataset.windowTo)-Number(node.dataset.windowFrom));
    await page.getByRole('button',{name:'Zoom waveform in',exact:true}).click();
    assert(await fine.evaluate(node=>Number(node.dataset.windowTo)-Number(node.dataset.windowFrom))<oldWindow);
    const dragWhileHeld=async(pad,waveform,counter)=>{
      const cdp=await page.context().newCDPSession(page),p=await page.locator('.cue-pad[data-pad-number="'+pad+'"]').boundingBox(),w=await waveform.boundingBox();
      await page.evaluate(()=>{const f=window.__uiFixture;if(f.dragTrace)for(const name of ['pointerdown','pointerup','pointercancel','click'])document.removeEventListener(name,f.dragTrace,true);f.dragEvents=[];f.dragTrace=event=>f.dragEvents.push({type:event.type,pointer:event.pointerId,kind:event.pointerType,button:event.button,detail:event.detail,pad:event.target.closest('.cue-pad')?.dataset.padNumber,touch:event.sourceCapabilities?.firesTouchEvents,at:performance.now()});for(const name of ['pointerdown','pointerup','pointercancel','click'])document.addEventListener(name,f.dragTrace,true);});
      const held={id:31,x:p.x+p.width/2,y:p.y+p.height/2},finger={id:32,x:w.x+w.width*.6,y:w.y+w.height/2};
      const value=()=>page.evaluate(counter=>window.__uiFixture[counter],counter);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[held]});await page.waitForTimeout(40);
      const before=await value();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[held,finger]});finger.x=w.x+w.width*.7;
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[held,finger]});await page.waitForFunction(({counter,before})=>window.__uiFixture[counter]>before,{counter,before});
      // CDP touchEnd names the contacts being ended, not the remaining ones.
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[held]});
      await page.waitForFunction(pad=>document.querySelector('.cue-pad[data-pad-number="'+pad+'"]').dataset.padState!=='pressed',pad);
      await page.waitForTimeout(40);const released=await value();
      finger.x=w.x+w.width*.8;await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[finger]});await page.waitForTimeout(60);
      assert.equal(await value(),released,'Drag audition continued after the selected pad was released');
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();await page.waitForTimeout(40);
      assert.equal(await value(),released,'Committing an unheld drag replayed the sound: '+JSON.stringify(await page.evaluate(()=>({events:window.__uiFixture.dragEvents,lastCue:window.__uiFixture.lastCue}))));
      await page.evaluate(()=>{for(const name of ['pointerdown','pointerup','pointercancel','click'])document.removeEventListener(name,window.__uiFixture.dragTrace,true);});
    };
    await dragWhileHeld(1,fine,'cueTriggers');await page.getByRole('button',{name:'Undo edit',exact:true}).click();
    await page.waitForFunction(value=>window.__pluginStores.cues.getState().cues[1]===value,edited);
    await page.evaluate(()=>window.__pluginStores.cues.getState().setCue(3,7.25));
    const cueHitsBefore=await page.evaluate(()=>window.__uiFixture.cueTriggers);
    await page.locator('.cue-pad[data-pad-number="3"]').click();
    await page.waitForFunction(value=>window.__uiFixture.cueTriggers===value+1,cueHitsBefore);
    assert.equal(await page.evaluate(()=>window.__uiFixture.position),7.25,'Fine edit cue selection did not audition the chosen cue');
    assert(await page.locator('.cue-fine-tools').innerText().then(text=>text.includes('A3')));
    await page.evaluate(()=>window.__uiFixture.emitNative('pluginPads',[{bank:'A',pad:1,triggered:true,midiTriggered:true,lastMidiTriggered:true,lastTriggered:true}]));
    await page.waitForFunction(()=>document.querySelector('.cue-fine-tools')?.textContent.includes('A1'));
    await page.evaluate(()=>window.__uiFixture.emitNative('pluginPads',[{bank:'A',pad:1,triggered:true,midiTriggered:true,lastMidiTriggered:false},{bank:'A',pad:3,triggered:true,midiTriggered:true,lastMidiTriggered:true}]));
    await page.waitForFunction(()=>document.querySelector('.cue-fine-tools')?.textContent.includes('A3'));
    await page.evaluate(()=>window.__uiFixture.emitNative('pluginPads',[{bank:'A',pad:1,triggered:true,midiTriggered:false,lastTriggered:true}]));
    assert(await page.locator('.cue-fine-tools').innerText().then(text=>text.includes('A3')),'Internal loop playback overrode the MIDI-selected zoom pad');
    await page.waitForFunction(()=>window.__uiFixture.regionRequests.some(request=>!request.sample&&request.pad===3&&Math.abs(request.from-6.25)<.001));await page.waitForTimeout(40);
    const cueRegionReads=()=>page.evaluate(()=>window.__uiFixture.regionRequests.filter(request=>!request.sample&&request.pad===3&&Math.abs(request.from-6.25)<.001).length);
    const readsBeforeReselect=await cueRegionReads();
    await page.locator('.cue-pad[data-pad-number="1"]').click();await page.locator('.cue-pad[data-pad-number="3"]').click();
    const paintedWave=()=>page.locator('.cue-fine-waveform canvas').evaluate(node=>new Promise(resolve=>requestAnimationFrame(()=>{const data=node.getContext('2d').getImageData(0,0,node.width,node.height).data;resolve(data.some((value,index)=>index%4===3&&value>0));})));
    assert(await paintedWave(),'Switching to a cached cue painted a blank waveform frame');
    assert.equal(await cueRegionReads(),readsBeforeReselect,'Repeated pad selection decoded the same waveform again');
    await page.evaluate(()=>{window.__uiFixture.waveformDelay=250;});await page.getByRole('button',{name:'Zoom waveform in',exact:true}).click();
    assert(await paintedWave(),'An uncached zoom cleared the source overview while native detail loaded');
    const markerStyle=await page.locator('.cue-fine-marker').evaluate(node=>{const probe=document.createElement('span');probe.style.color='var(--accent)';node.parentElement.append(probe);const style=getComputedStyle(node),result={color:style.backgroundColor,accent:getComputedStyle(probe).color,width:style.width,cap:getComputedStyle(node,'::before').content};probe.remove();return result;});
    assert.equal(markerStyle.color,markerStyle.accent,'Zoomed cue line does not match the selected app accent');assert.equal(markerStyle.width,'1.5px');assert(['none','normal'].includes(markerStyle.cap),'Zoomed cue line still has a block-shaped cap');
    await page.evaluate(()=>{window.__uiFixture.waveformDelay=0;});
    await page.evaluate(()=>{window.__uiFixture.padSamples=[{bank:'A',pad:2,name:'Kick',duration:.5,ready:true,path:'/fixture/kick.wav',start:.05,peaks:Array(256).fill(.5)}];window.dispatchEvent(new CustomEvent('plugin-pad-samples',{detail:window.__uiFixture.padSamples}));});
    const beforeSampleSelection=await page.evaluate(()=>window.__uiFixture.sampleTriggers);
    await page.locator('.cue-pad[data-pad-number="2"]').click();
    await page.waitForFunction(value=>window.__uiFixture.sampleTriggers===value+1,beforeSampleSelection);
    const sampleWave=page.getByLabel('Edit sample start waveform',{exact:true}),sampleBounds=await sampleWave.boundingBox();
    const beforeSilentSample=await page.evaluate(()=>window.__uiFixture.samplePreviews);
    await page.mouse.move(sampleBounds.x+sampleBounds.width*.5,sampleBounds.y+sampleBounds.height*.5);await page.mouse.down();
    await page.waitForTimeout(60);assert.equal(await page.evaluate(()=>window.__uiFixture.samplePreviews),beforeSilentSample,'Default unheld sample-start dragging must remain silent');
    assert.equal(await page.evaluate(()=>window.__pluginStores.samples.getState().samples['A:2'].start),.05,'Sample-start editing must not commit until release');
    await page.mouse.up();
    await page.waitForFunction(()=>Math.abs(window.__pluginStores.samples.getState().samples['A:2'].start-.25)<.01);
    await page.getByRole('button',{name:'Undo edit',exact:true}).click();await page.waitForFunction(()=>window.__pluginStores.samples.getState().samples['A:2'].start===.05);
    await page.getByRole('button',{name:'Redo edit',exact:true}).click();await page.waitForFunction(()=>Math.abs(window.__pluginStores.samples.getState().samples['A:2'].start-.25)<.01);
    await page.getByRole('button',{name:'Preview selected pad',exact:true}).click();
    await page.waitForFunction(value=>window.__uiFixture.sampleTriggers===value+2,beforeSampleSelection);
    await dragWhileHeld(2,sampleWave,'samplePreviews');await page.getByRole('button',{name:'Undo edit',exact:true}).click();
    await page.waitForFunction(()=>Math.abs(window.__pluginStores.samples.getState().samples['A:2'].start-.25)<.01);
    await page.evaluate(()=>{
      window.__pendingTouchClicks=[];
      window.__zeroDetailClick=event=>{const button=event.target.closest('.cue-pad[data-pad-number="2"]');if(button&&event.detail>0){event.preventDefault();event.stopImmediatePropagation();window.__pendingTouchClicks.push(button);}};
      document.addEventListener('click',window.__zeroDetailClick,true);
    });
    const heldCueDrums=async()=>{
      const before=await page.evaluate(()=>window.__uiFixture.sampleTriggers);
      const first=await page.locator('.cue-pad[data-pad-number="1"]').boundingBox(),drum=await page.locator('.cue-pad[data-pad-number="2"]').boundingBox();
      await page.mouse.move(first.x+first.width/2,first.y+first.height/2);await page.mouse.down();
      for(let i=0;i<3;i++)await page.touchscreen.tap(drum.x+drum.width/2,drum.y+drum.height/2);
      await page.mouse.up();
      await page.evaluate(()=>{for(const button of window.__pendingTouchClicks)for(const detail of [0,0,0])button.dispatchEvent(new MouseEvent('click',{bubbles:true,detail}));window.__pendingTouchClicks=[];});
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(()=>window.__uiFixture.sampleTriggers),before+3,'Held cue plus zero-detail touch clicks duplicated drum taps');
    };
    await heldCueDrums();
    await page.getByRole('button',{name:'Fine waveform edit',exact:true}).click();
    await heldCueDrums();
    await page.evaluate(()=>document.removeEventListener('click',window.__zeroDetailClick,true));
    await page.evaluate(()=>window.__pluginStores.cues.getState().clearCue(1));await navigate('/library');
    await page.getByRole('button',{name:'Undo edit',exact:true}).click();await page.waitForFunction(value=>window.__pluginStores.cues.getState().cues[1]===value,edited);await navigate('/cues');
    const source=await page.locator('.cue-pad[data-pad-number="1"]').boundingBox(),target=await page.locator('.cue-pad[data-pad-number="4"]').boundingBox();
    await page.mouse.move(source.x+source.width/2,source.y+source.height/2);await page.mouse.down();await page.waitForTimeout(3100);
    assert.equal(await page.locator('.cue-pad-grid').getAttribute('data-arranging'),'true');
    assert.equal(await page.evaluate(()=>window.__pluginStores.cues.getState().cues[1]),edited,'Three-second rearrange hold accidentally replaced the cue');
    await page.mouse.move(target.x+target.width/2,target.y+target.height/2);await page.mouse.up();
    await page.waitForFunction(value=>window.__pluginStores.cues.getState().cues[4]===value,edited);
    assert.equal(await page.evaluate(()=>window.__pluginStores.cues.getState().cues[1]),undefined,'Moving a cue duplicated its content');
    const swapped=await page.locator('.cue-pad[data-pad-number="1"]').boundingBox();assert(Math.abs(swapped.x-source.x)<2,'Moving content changed the pad number/position');
    await page.getByRole('button',{name:'Undo edit',exact:true}).click();
    await page.waitForFunction(value=>window.__pluginStores.cues.getState().cues[1]===value,edited);
    await page.getByRole('button',{name:'Redo edit',exact:true}).click();
    await page.waitForFunction(value=>window.__pluginStores.cues.getState().cues[4]===value,edited);
    const dragContents=async(from,to)=>{const a=await page.locator('.cue-pad[data-pad-number="'+from+'"]').boundingBox(),b=await page.locator('.cue-pad[data-pad-number="'+to+'"]').boundingBox();await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.up();};
    await dragContents(2,5);await page.waitForFunction(()=>window.__pluginStores.samples.getState().samples['A:5']?.name==='Kick');
    assert.equal(await page.evaluate(()=>window.__pluginStores.samples.getState().samples['A:2']),undefined,'Moving a sample duplicated its source');
    await dragContents(5,3);await page.waitForFunction(()=>window.__pluginStores.samples.getState().samples['A:3']?.name==='Kick');
    assert.equal(await page.evaluate(()=>window.__pluginStores.cues.getState().cues[5]),7.25,'Dropping onto a cue lost the destination content instead of swapping');
    await page.getByRole('button',{name:'Undo edit',exact:true}).click();await page.waitForFunction(()=>window.__pluginStores.samples.getState().samples['A:5']?.name==='Kick');
    await page.getByRole('button',{name:'Finish rearranging pads',exact:true}).click();
    await page.waitForFunction(value=>{const saved=JSON.parse(window.__uiFixture.savedSession||'{}'),all=JSON.parse(saved['musike:cues:v1']||'{}');return all.ui000000000?.A?.[4]===value;},edited);
    await page.reload();await page.locator('.cue-pad-grid').waitFor();
    assert(Math.abs((await page.locator('.cue-pad[data-pad-number="1"]').boundingBox()).x-source.x)<2,'Content moves changed pad labels after restart');
    assert.equal(await page.evaluate(()=>window.__pluginStores.cues.getState().cues[4]),edited,'Moved cue did not survive restart');
    assert.equal(await page.evaluate(()=>window.__pluginStores.samples.getState().samples['A:5']?.name),'Kick','Moved sample did not survive restart');
    await page.evaluate(()=>{localStorage.setItem('musike:pad-arrangements',JSON.stringify({'linear16:A':[4,2,3,1,5,6,7,8,9,10,11,12,13,14,15,16]}));window.dispatchEvent(new Event('plugin-preferences-changed'));});
    await page.waitForFunction(()=>JSON.parse(window.__uiFixture.savedSession||'{}')['musike:pad-arrangements']?.includes('linear16:A'));
    await page.reload();await page.locator('.cue-pad-grid').waitFor();
    await page.waitForFunction(value=>window.__pluginStores.cues.getState().cues[1]===value&&!JSON.parse(localStorage.getItem('musike:pad-arrangements')||'{}')['linear16:A'],edited);
    const cdp=await page.context().newCDPSession(page),point1=await page.locator('.cue-pad[data-pad-number="1"]').boundingBox(),point3=await page.locator('.cue-pad[data-pad-number="3"]').boundingBox();
    const touches=[{x:point1.x+point1.width/2,y:point1.y+point1.height/2,id:1},{x:point3.x+point3.width/2,y:point3.y+point3.height/2,id:2}];
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:touches.slice(0,1)});await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:touches});await page.waitForTimeout(3100);
    assert.equal(await page.locator('.cue-pad-grid').getAttribute('data-arranging'),'false','Two simultaneous pads entered rearrange mode');
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
    await page.waitForTimeout(80);
    const beforeHold=await page.evaluate(()=>window.__pluginStores.cues.getState().cues[1]);
    const holdBounds=await page.locator('.cue-pad[data-pad-number="1"]').boundingBox();
    await page.evaluate(()=>{window.__uiFixture.position=17.5;});
    await page.mouse.move(holdBounds.x+holdBounds.width/2,holdBounds.y+holdBounds.height/2);await page.mouse.down();await page.waitForTimeout(800);
    assert.equal(await page.evaluate(()=>window.__pluginStores.cues.getState().cues[1]),beforeHold,'Shorter hold committed before release and could conflict with rearrange entry');
    await page.mouse.up();await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>window.__pluginStores.cues.getState().cues[1]),beforeHold,'Holding a performance pad moved its saved cue');
    await page.evaluate(()=>{localStorage.removeItem('musike:pad-arrangements');window.dispatchEvent(new Event('plugin-preferences-changed'));});
    assert.equal(await page.locator('.cue-library-back').count(),0,'The iPhone Cues back arrow should be removed');
    const expand=await page.getByRole('button',{name:'Fine waveform edit',exact:true}).boundingBox(),mark=await page.locator('.cue-mark').boundingBox();
    assert(expand.x+expand.width<=mark.x+1,'Expand waveform must be to the left of Mark');
    await page.waitForFunction(()=>document.documentElement.dataset.pluginCuePage==='true');
    const scrolling=await page.evaluate(()=>{const pageScroll=new TouchEvent('touchmove',{bubbles:true,cancelable:true});document.querySelector('.cue-body').dispatchEvent(pageScroll);const main=document.querySelector('main');return {prevented:pageScroll.defaultPrevented,overflow:getComputedStyle(main).overflowY};});
    assert(scrolling.prevented&&scrolling.overflow==='hidden','Cues page movement is still enabled');
    if(await page.getByLabel('Toggle playlist',{exact:true}).getAttribute('aria-expanded')!=='true')await page.getByLabel('Toggle playlist',{exact:true}).click();
    assert(await page.locator('.cue-song-list').evaluate(node=>{const event=new TouchEvent('touchmove',{bubbles:true,cancelable:true});node.dispatchEvent(event);return !event.defaultPrevented;}),'Playlist scrolling was blocked by the page lock');
    await page.getByRole('button',{name:'MIDI settings',exact:true}).click();
    assert(await page.getByRole('dialog').evaluate(node=>{const event=new TouchEvent('touchmove',{bubbles:true,cancelable:true});node.dispatchEvent(event);return !event.defaultPrevented;}),'Dialog scrolling was blocked by the page lock');
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    console.log('PASS: silent default zoom edits, live cue/sample audition only while the selected pad is held, immediate release gating, fixed-number content moves/swaps, touch deduplication, undo/restart and Cues page lock.');
    console.log('PASS: cached/prewarmed zoom waveforms paint immediately, pad reselection avoids duplicate decoding, detail loading retains the matching overview, and the minimal 1.5px marker follows the accent.');
    await page.evaluate(async()=>{const f=window.__uiFixture;await window.__pluginStores.api.createPlaylist('Mixed reference',[f.tracks[0],{...f.tracks[1],id:'vi000000001',title:'Library video audio',kind:'video'}]);await window.__pluginStores.library.getState().load(true);});
    const openImport=()=>page.getByRole('button',{name:'Import songs and chop audio',exact:true}).click();
    assert.equal(await page.locator('.cue-sample-edit svg[data-icon="drum"]').count(),1,'Sample-loading button must use a drum icon');
    await openImport();await page.getByRole('button',{name:'Files…',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
    await page.waitForFunction(()=>window.__pluginStores.player.getState().queue[0]?.id==='locimport01');
    assert.equal(await page.evaluate(()=>window.__pluginStores.library.getState().playlists.find(p=>p.name==='Imports')?.tracks.length),2,'Imported files were not automatically saved in Imports');
    assert.equal(await page.getByRole('dialog',{name:'Save audio',exact:true}).count(),0,'Automatic import unexpectedly required a destination dialog');
    await openImport();await page.getByRole('button',{name:'Files…',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.__pluginStores.library.getState().playlists.filter(p=>p.name==='Imports').length),1,'Repeated import created a duplicate Imports playlist');
    await openImport();assert.equal(await page.getByRole('button',{name:'Library songs & videos',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Chop current song',exact:true}).count(),0);
    await page.evaluate(()=>{window.__uiFixture.cancelGallery=true;});await page.getByRole('button',{name:'Import gallery video',exact:true}).click();await page.waitForFunction(()=>window.__uiFixture.galleryOpens===1);await page.getByRole('button',{name:'Import gallery video',exact:true}).waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>window.__uiFixture.localMedia.length),2,'Cancelling the phone gallery created an import');await page.evaluate(()=>{window.__uiFixture.cancelGallery=false;});await page.getByRole('button',{name:'Import gallery video',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
    await page.waitForFunction(()=>window.__pluginStores.player.getState().queue[window.__pluginStores.player.getState().index]?.id==='locgallery1');
    for(const id of ['locimport01','locimport02']){await page.evaluate(id=>window.__pluginStores.ui.getState().openMenu({track:window.__uiFixture.localMedia.find(track=>track.id===id),x:100,y:100}),id);await page.getByRole('menuitem',{name:'Add to playlist',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:/Mixed reference/}).click();await page.getByRole('dialog').waitFor({state:'detached'});}
    const mixed=await page.evaluate(()=>window.__pluginStores.library.getState().playlists.find(playlist=>playlist.name==='Mixed reference'));
    assert.equal(mixed.tracks.length,4);assert(mixed.tracks.some(track=>track.kind==='video')&&mixed.tracks.some(track=>track.id==='locimport01'),'Imported and existing song/video audio did not mix in one playlist');
    await page.evaluate(()=>window.__pluginStores.player.getState().playList([window.__uiFixture.localMedia.find(track=>track.id==='locimport01')]));await page.waitForFunction(()=>window.__pluginStores.player.getState().status==='playing');
    await page.getByRole('button',{name:'Manage pad samples',exact:true}).click();await page.locator('.cue-pad[data-pad-number="16"]').click();await page.getByRole('button',{name:'Chop current song…',exact:true}).click();await page.getByRole('dialog',{name:'Sample pad A16',exact:true}).waitFor({state:'detached'});await page.getByLabel('Chop source waveform',{exact:true}).waitFor();
    await page.getByLabel('Chop start seconds',{exact:true}).fill('0.05');await page.getByLabel('Chop end seconds',{exact:true}).fill('0.25');
    await page.getByLabel('Chop destination bank',{exact:true}).selectOption('B');await page.getByLabel('Chop first pad',{exact:true}).selectOption('3');await page.getByLabel('Chop slices',{exact:true}).selectOption('2');
    await page.getByRole('button',{name:'Preview',exact:true}).click();await page.waitForFunction(()=>window.__uiFixture.chopPreviews>0);await page.getByRole('button',{name:'Stop chop preview',exact:true}).click();
    await page.getByRole('button',{name:'Assign B3–B4',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
    await page.getByRole('button',{name:'Manage pad samples',exact:true}).click();
    await page.waitForFunction(()=>window.__pluginStores.samples.getState().samples['B:3']&&window.__pluginStores.samples.getState().samples['B:4']);
    assert(Math.abs(await page.evaluate(()=>window.__pluginStores.samples.getState().samples['B:3'].duration)-.1)<.001);
    await page.getByRole('button',{name:'Undo edit',exact:true}).click();await page.waitForFunction(()=>!window.__pluginStores.samples.getState().samples['B:3']&&!window.__pluginStores.samples.getState().samples['B:4']);
    await page.getByRole('button',{name:'Redo edit',exact:true}).click();await page.waitForFunction(()=>window.__pluginStores.samples.getState().samples['B:3']&&window.__pluginStores.samples.getState().samples['B:4']);
    await page.reload();await page.locator('.cue-pad-grid').waitFor();
    assert.equal(await page.evaluate(()=>window.__pluginStores.samples.getState().samples['B:3']?.name),'Imported kick · 1','Chops did not survive reload');
    await page.evaluate(()=>{window.__pluginStores.cues.getState().setBank('A');window.__pluginStores.player.getState().playList(window.__uiFixture.tracks);});
    await page.waitForFunction(()=>window.__pluginStores.player.getState().queue.length===500&&window.__pluginStores.player.getState().status==='playing');
    console.log('PASS: automatic Imports/Cues playback without a destination dialog, one Imports playlist, later playlist changes, mixed local/song/video playlists, drum icon, and retained chop undo/redo/restart.');
    await page.evaluate(()=>window.__pluginStores.ui.getState().openMenu({track:window.__uiFixture.localMedia[0],x:100,y:100}));
    assert.equal(await page.getByRole('menuitem',{name:'Open on YouTube',exact:true}).count(),0,'Imported audio still has an Open YouTube action');
    assert.equal(await page.getByRole('menuitem',{name:'Add to playlist',exact:true}).count(),1,'Imported audio lost its playlist action');
    await page.getByRole('menuitem',{name:'Download / Share audio',exact:true}).click();await page.waitForFunction(()=>window.__uiFixture.sharedAudio?.includes('locimport01'));
    await page.evaluate(()=>window.__pluginStores.ui.getState().openMenu({track:window.__uiFixture.tracks[0],x:100,y:100}));
    assert.equal(await page.getByRole('menuitem',{name:'Open on YouTube',exact:true}).count(),1,'YouTube tracks lost their Open YouTube action');assert.equal(await page.getByRole('menuitem',{name:'Download / Share audio',exact:true}).count(),0,'Local audio export was offered for a YouTube track');await page.keyboard.press('Escape');
    const midiPaused=expected=>page.waitForFunction(expected=>window.__uiFixture.midiOptions?.suspendPadActions===expected,expected);
    const recordIcon=page.getByRole('button',{name:'Open audio recorder',exact:true});
    const recordRect=await recordIcon.boundingBox(),toolbarRect=await page.locator('.cue-overwrite-row').boundingBox(),bankRect=await page.locator('.cue-bankbar').boundingBox();
    assert(Math.abs(recordRect.x+recordRect.width-toolbarRect.x-toolbarRect.width)<2,'Record icon must sit at the far-right end of the toolbar');
    assert(Math.abs(toolbarRect.x-bankRect.x)<2&&Math.abs(toolbarRect.width-bankRect.width)<2,'Control and bank rows must have matching full widths');
    await recordIcon.click();await page.getByRole('dialog',{name:'Record audio',exact:true}).waitFor();await midiPaused(false);
    await page.getByLabel('Recording source',{exact:true}).selectOption('input');await midiPaused(true);
    await page.evaluate(()=>{window.__uiFixture.recording.inputPeak=.25;});await page.waitForFunction(()=>Number(document.querySelector('[aria-label="Recording input level"]')?.getAttribute('aria-valuenow'))>-13);
    assert.equal(await page.getByRole('meter',{name:'Recording input level',exact:true}).locator('[data-active]').count(),24,'Input meter should use app-themed segmented bars');
    assert(await page.getByRole('meter',{name:'Recording input level',exact:true}).locator('[data-active="true"]').count()>0,'Incoming audio was not visible in the recording meter');
    await page.getByText(/MIDI pads paused · (microphone \/ USB|DAW input) selected/).waitFor();
    await page.getByRole('button',{name:'Audio input & output',exact:true}).click();await midiPaused(true);
    await page.getByRole('button',{name:'Audio input & output',exact:true}).click();await midiPaused(true);
    await page.getByLabel('Recording source',{exact:true}).selectOption('playback');await midiPaused(false);
    await page.getByLabel('Recording source',{exact:true}).selectOption('input');await midiPaused(true);
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});await midiPaused(false);
    await page.getByRole('button',{name:'Settings',exact:true}).click();await midiPaused(false);
    await page.getByText('Audio input & output',{exact:true}).click();await midiPaused(true);
    await page.getByLabel('Recording source',{exact:true}).selectOption('playback');await midiPaused(false);
    await page.getByLabel('Recording source',{exact:true}).selectOption('input');await midiPaused(true);
    await page.getByText('Audio input & output',{exact:true}).click();await midiPaused(false);
    await page.getByText('Audio input & output',{exact:true}).click();await midiPaused(true);
    await page.getByLabel('Recording source',{exact:true}).selectOption('playback');await midiPaused(false);
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});await midiPaused(false);
    console.log('PASS: far-right recorder shortcut/full-width control row; MIDI pauses only for visible microphone/USB controls, remains active for Beatmaker playback, and restores on source switch/collapse/close.');
    await page.evaluate(()=>{window.__pluginStores.cues.getState().setCue(6,18.5);window.__uiFixture.unloadFinalCue={7:19.25};});
    await openImport();await page.getByRole('button',{name:'New empty track',exact:true}).click();
    await page.waitForFunction(()=>window.__pluginStores.player.getState().queue.length===0);
    assert(await page.locator('.cue-track-label').innerText().then(text=>text.includes('Empty track')));
    assert.deepEqual(await page.evaluate(()=>{const p=window.__pluginStores.player.getState();return {status:p.status,duration:p.duration,position:p.position,cues:window.__pluginStores.cues.getState().cues,ready:window.__musikeAudioEl.readyState};}),{status:'idle',duration:0,position:0,cues:{},ready:0},'New empty track retained song/cue/transport state');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('musike:cues:v1')).ui000000000.A[6]),18.5,'Empty workspace erased the previous song cues');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('musike:cues:v1')).ui000000000.A[7]),19.25,'The final native MIDI cue was lost while leaving the song');
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    await page.waitForFunction(()=>JSON.parse(JSON.parse(window.__uiFixture.savedSession||'{}')['musike:player']||'{}').queue?.length===0);
    await page.reload();await page.locator('.cue-pad-grid').waitFor();assert.equal(await page.evaluate(()=>window.__pluginStores.player.getState().queue.length),0,'Restart resurrected the cleared song');
    const emptyCueHits=await page.evaluate(()=>window.__uiFixture.cueTriggers);await page.locator('.cue-pad[data-pad-number="6"]').click();assert.equal(await page.evaluate(()=>window.__uiFixture.cueTriggers),emptyCueHits,'Empty cue pad triggered the previous song');
    await openImport();await page.getByRole('button',{name:'Record audio',exact:true}).click();
    assert.equal(await page.getByLabel('Recording source',{exact:true}).inputValue(),'playback');
    await page.getByRole('button',{name:'Start recording',exact:true}).click();await page.getByRole('button',{name:'Keep recording · play pads',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
    await midiPaused(false);assert.equal(await recordIcon.getAttribute('aria-pressed'),'true','Recorder icon did not show its active take');
    const sampleOnlyHits=await page.evaluate(()=>window.__uiFixture.sampleTriggers);await page.locator('.cue-pad[data-pad-number="5"]').click();await page.waitForFunction(before=>window.__uiFixture.sampleTriggers===before+1,sampleOnlyHits);
    assert.equal(await page.evaluate(()=>window.__pluginStores.player.getState().queue.length),0,'Playing a sample while recording reloaded a song');
    await page.waitForFunction(()=>document.querySelector('.cue-song-import').dataset.recording==='true');await openImport();
    await midiPaused(false);
    await page.evaluate(()=>{localStorage.setItem('musike:recording:source','input');window.dispatchEvent(new Event('plugin-preferences-changed'));});await midiPaused(false);
    assert.equal(await page.getByLabel('Recording source',{exact:true}).inputValue(),'playback','An active take must use its actual source rather than a changed saved preference');
    assert(await page.getByLabel('Recording source',{exact:true}).isDisabled());
    await page.evaluate(()=>{localStorage.setItem('musike:recording:source','playback');window.dispatchEvent(new Event('plugin-preferences-changed'));});
    await page.getByRole('button',{name:'Audio input & output',exact:true}).click();assert.equal(await page.getByRole('switch',{name:'Input monitoring',exact:true}).getAttribute('aria-checked'),'false');
    await page.getByRole('button',{name:'Finish & play in Cues',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
    await page.waitForFunction(()=>{const state=window.__pluginStores.player.getState();return state.queue[state.index]?.id==='locrecord01'&&state.status==='playing';});
    assert(await page.evaluate(()=>window.__pluginStores.library.getState().playlists.find(p=>p.name==='Imports')?.tracks.some(t=>t.id==='locrecord01')),'Finished recording did not enter Imports automatically');
    await page.evaluate(()=>window.__pluginStores.player.getState().playList([window.__uiFixture.tracks[0]]));await page.waitForFunction(()=>window.__pluginStores.cues.getState().cues[6]===18.5&&window.__pluginStores.cues.getState().cues[7]===19.25);
    console.log('PASS: New empty track unloads song/cues without erasing them, reconciles final native MIDI marks, survives restart, keeps sample-only recording available and loads the finished take into Imports/Cues.');
    await page.evaluate(()=>{window.__uiFixture.cancelAudioShare=true;window.__pluginStores.ui.getState().openMenu({track:window.__uiFixture.localMedia.find(t=>t.id==='locrecord01'),x:100,y:100});});assert.equal(await page.getByRole('menuitem',{name:'Open on YouTube',exact:true}).count(),0);
    await page.getByRole('menuitem',{name:'Download / Share audio',exact:true}).click();await page.waitForFunction(()=>window.__uiFixture.sharedAudio?.includes('locrecord01'));
    console.log('PASS: imported and recorded tracks offer Download / Share audio, route to the native file share action, and handle cancellation; YouTube tracks retain only their appropriate external link.');
    await page.evaluate(()=>{const f=window.__uiFixture;window.__pluginStores.player.getState().playList([f.localMedia.find(track=>track.id==='locimport01'),f.localMedia.find(track=>track.id==='locrecord01')]);});
    await page.waitForFunction(()=>window.__pluginStores.player.getState().status==='playing');await page.evaluate(()=>window.__pluginStores.cues.getState().setCue(1,2.5));
    const renameSource=await page.evaluate(()=>window.__uiFixture.sourceId);
    const renameSong=async(id,title)=>{
      await page.evaluate(id=>window.__pluginStores.ui.getState().openMenu({track:window.__uiFixture.localMedia.find(track=>track.id===id),x:100,y:100}),id);
      await page.getByRole('menuitem',{name:'Rename song',exact:true}).click();const input=page.getByRole('textbox',{name:'Song name',exact:true});await input.fill(' ');
      assert(await page.getByRole('dialog',{name:'Rename song',exact:true}).getByRole('button',{name:'Save',exact:true}).isDisabled());
      assert.notEqual(await input.evaluate(node=>getComputedStyle(node).userSelect),'none','Song-name editing inherited Cues selection blocking');
      await input.fill(title);await page.getByRole('dialog',{name:'Rename song',exact:true}).getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
      await page.waitForFunction(({id,title})=>window.__pluginStores.library.getState().playlists.find(p=>p.name==='Imports').tracks.find(track=>track.id===id)?.title===title,{id,title});
    };
    await renameSong('locimport01','My imported drums');
    assert.equal(await page.evaluate(()=>window.__pluginStores.player.getState().queue[0].title),'My imported drums');
    assert.equal(await page.evaluate(()=>window.__uiFixture.sourceId),renameSource,'Renaming the playing song reloaded its audio');
    assert.equal(await page.evaluate(()=>window.__pluginStores.cues.getState().cues[1]),2.5,'Renaming lost the song cue identity');
    await page.getByRole('button',{name:'Undo edit',exact:true}).click();await page.waitForFunction(()=>window.__uiFixture.localMedia.find(track=>track.id==='locimport01').title==='Imported kick');
    await page.getByRole('button',{name:'Redo edit',exact:true}).click();await page.waitForFunction(()=>window.__uiFixture.localMedia.find(track=>track.id==='locimport01').title==='My imported drums');
    await renameSong('locrecord01','My recorded performance');
    await page.waitForFunction(()=>JSON.parse(JSON.parse(window.__uiFixture.savedSession||'{}')['musike:player']||'{}').queue?.[1]?.title==='My recorded performance');
    await page.reload();await page.locator('.cue-pad-grid').waitFor();assert.equal(await page.evaluate(()=>window.__pluginStores.player.getState().queue[0].title),'My imported drums');
    assert.equal(await page.evaluate(()=>window.__uiFixture.localMedia.find(track=>track.id==='locrecord01').title),'My recorded performance');
    await page.evaluate(()=>window.__pluginStores.player.getState().playList([window.__uiFixture.tracks[0]]));await page.waitForFunction(()=>window.__pluginStores.cues.getState().trackId==='ui000000000');
    console.log('PASS: imported/recorded song renaming, editable name field, blank-name rejection, all playlist/queue titles, cue identity, uninterrupted playback, undo/redo and restart.');
    await page.evaluate(()=>window.__pluginStores.player.getState().playList([window.__uiFixture.localMedia.find(track=>track.id==='locrecord01')]));
    await page.waitForFunction(()=>window.__pluginStores.player.getState().status==='playing'&&document.querySelector('.cue-waveform')?.dataset.waveformProgress==='1');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const animation=await page.evaluate(async()=>{
      const f=window.__uiFixture,p=window.__pluginStores.player,head=document.querySelector('.cue-wave-playhead'),fill=document.querySelector('.cue-scrubber [data-slider-fill]'),canvas=document.querySelector('.cue-waveform canvas'),ctx=canvas.getContext('2d');
      const originalFill=ctx.fillRect;let paints=0,updates=0;ctx.fillRect=function(...args){paints++;return originalFill.apply(this,args);};
      const unsubscribe=p.subscribe((state,previous)=>{if(state.position!==previous.position)updates++;});
      p.getState().seek(10);const started=performance.now(),heads=new Set(),fills=new Set();
      const emit=()=>{f.position=10+(performance.now()-started)/1000;f.emitNative('pluginAudio',{event:'time',payload:{sourceId:f.sourceId,position:f.position,duration:60,rate:1,advancing:true}});};emit();const timer=setInterval(emit,100);
      try{while(performance.now()-started<900){await new Promise(requestAnimationFrame);heads.add(head.style.transform);fills.add(fill.style.transform);}return {heads:heads.size,fills:fills.size,paints,updates};}
      finally{clearInterval(timer);unsubscribe();ctx.fillRect=originalFill;}
    });
    assert(animation.heads>=35&&animation.fills>=35&&animation.updates<15&&animation.paints===0,'Playback must animate at display refresh without redrawing waveform/React at frame rate: '+JSON.stringify(animation));
    const clock=await page.evaluate(async()=>{
      const p=window.__pluginStores.player,media=window.__musikeAudioEl,f=window.__uiFixture,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      p.getState().toggle();await wait(50);const paused=media.displayPosition();await wait(180);const pausedAfter=media.displayPosition();
      p.getState().seek(5);const seek=media.displayPosition();
      p.getState().toggle();await wait(50);p.getState().setSpeed(50);
      f.emitNative('pluginAudio',{event:'time',payload:{sourceId:f.sourceId,position:5,duration:60,rate:1.5,advancing:true}});const rateStart=media.displayPosition();await wait(100);const rateAdvance=media.displayPosition()-rateStart;
      await wait(300);const bounded=media.displayPosition();await wait(120);const boundedAfter=media.displayPosition();
      f.emitNative('pluginAudio',{event:'time',payload:{sourceId:f.sourceId+999,position:40,duration:60,advancing:true}});const stale=media.displayPosition();
      p.getState().setSpeed(0);p.getState().setLoopFrom(20);p.getState().setLoopTo(20.5);p.getState().seek(20.45);
      f.emitNative('pluginAudio',{event:'time',payload:{sourceId:f.sourceId,position:20.45,duration:60,rate:1,advancing:true}});await wait(130);const loop=media.displayPosition();
      p.getState().clearLoop();f.emitNative('pluginAudio',{event:'time',payload:{sourceId:f.sourceId,position:22,duration:60,advancing:false}});const buffered=media.displayPosition();await wait(130);const bufferedAfter=media.displayPosition();
      return {paused,pausedAfter,seek,rateAdvance,bounded,boundedAfter,stale,loop,buffered,bufferedAfter};
    });
    assert.equal(clock.paused,clock.pausedAfter);assert.equal(clock.seek,5);assert(clock.rateAdvance>.1&&clock.rateAdvance<.23,'Visual clock ignored playback speed: '+JSON.stringify(clock));
    assert.equal(clock.bounded,clock.boundedAfter);assert.equal(clock.boundedAfter,clock.stale);assert(clock.loop>=20&&clock.loop<20.3,'Visual clock escaped the native loop: '+JSON.stringify(clock));assert.equal(clock.buffered,clock.bufferedAfter);
    await page.evaluate(()=>window.__pluginStores.player.getState().playList([window.__uiFixture.tracks[0]]));await page.waitForFunction(()=>window.__pluginStores.cues.getState().trackId==='ui000000000');
    console.log('PASS: recorded-song waveform/scrubber animate between 10 Hz native snapshots without waveform redraws, plus pause/seek/rate/loop/buffering/stale-source and bounded-clock checks: '+JSON.stringify(animation));
    await page.evaluate(()=>{window.__uiFixture.routes.inputs=[{id:'mic-raw',name:'iPhone microphone',type:'MicrophoneBuiltIn',kind:'microphone'},{id:'mic-raw-again',name:'iPhone microphone',type:'MicrophoneBuiltIn',kind:'microphone'},{id:'sp-raw',name:'SP-404MKII',type:'USBAudio',kind:'usb'},{id:'sp-raw-again',name:'SP-404MKII',type:'USBAudio',kind:'usb'}];window.__uiFixture.routes.input='mic-raw';});
    if(fixturePlatform==='desktop')await page.evaluate(()=>{window.__uiFixture.routes.outputs=[{id:'desktop-speakers',name:'Desktop speakers',type:'CoreAudio'},{id:'desktop-interface',name:'SP-404 output',type:'CoreAudio'}];});
    await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByText('Audio input & output',{exact:true}).click();
    if(fixturePlatform==='desktop'){
      const input=page.getByLabel('Preferred audio input',{exact:true}),output=page.getByLabel('Preferred audio output device',{exact:true});
      assert.deepEqual(await input.locator('option').evaluateAll(nodes=>nodes.map(node=>node.value)),['automatic','mic-raw','mic-raw-again','sp-raw','sp-raw-again'],'Desktop device IDs must stay individually selectable');
      assert.equal(await input.inputValue(),'mic-raw');
      assert.deepEqual(await output.locator('option').evaluateAll(nodes=>nodes.map(node=>node.value)),['automatic','desktop-speakers','desktop-interface']);
      await input.selectOption('sp-raw');await output.selectOption('desktop-interface');
      await page.getByRole('switch',{name:'Enable audio input',exact:true}).click();await page.getByRole('switch',{name:'Input monitoring',exact:true}).click();
      await page.waitForFunction(()=>{const prefs=JSON.parse(localStorage.getItem('musike:audio:routes')||'{}');return prefs.input==='sp-raw'&&prefs.output==='desktop-interface'&&prefs.monitor===true;});
      await page.getByRole('switch',{name:'Input monitoring',exact:true}).click();await page.getByRole('switch',{name:'Enable audio input',exact:true}).click();
      await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
      console.log('PASS: desktop standalone keeps concrete input/output device IDs selectable and persists device/monitor preferences.');
    }else{
    assert.deepEqual(await page.getByLabel('Preferred audio input',{exact:true}).locator('option').allTextContents(),['Automatic',microphoneName,'SP-404'],'Raw microphone/SP-404 entries duplicated the logical device choices');
    assert.equal(await page.getByLabel('Preferred audio input',{exact:true}).inputValue(),'microphone','Legacy raw microphone UID did not map to the simplified microphone choice');
    const outputGroup=page.getByRole('radiogroup',{name:'Preferred audio output',exact:true});
    assert.deepEqual(await outputGroup.getByRole('radio').allTextContents(),['Automatic',speakerName,'SP-404'],'Speaker is hidden or the output list duplicates the interface');
    await outputGroup.getByRole('radio',{name:speakerName,exact:true}).click();
    await page.waitForFunction(()=>window.__uiFixture.routes.output==='speaker'&&!window.__uiFixture.routes.inputEnabled);
    assert.equal(await outputGroup.getByRole('radio',{name:speakerName,exact:true}).getAttribute('aria-checked'),'true','Speaker could not be selected with input off');
    await outputGroup.getByRole('radio',{name:'SP-404',exact:true}).click();await page.waitForFunction(()=>window.__uiFixture.routes.activeOutput==='usb');
    assert.equal(await outputGroup.getByRole('radio',{name:'SP-404',exact:true}).getAttribute('aria-checked'),'true','Accepted card output was not reflected in the route controls');
    await outputGroup.getByRole('radio',{name:speakerName,exact:true}).click();await page.waitForFunction(()=>window.__uiFixture.routes.activeOutput==='speaker');
    await page.evaluate(()=>{window.__uiFixture.rejectUSB=true;});await outputGroup.getByRole('radio',{name:'SP-404',exact:true}).click();
    await page.getByText('No SP-404 / USB audio card is available',{exact:true}).waitFor();assert.equal(await outputGroup.getByRole('radio',{name:'SP-404',exact:true}).getAttribute('aria-checked'),'false','A failed output switch falsely selected the card');
    await page.evaluate(()=>{window.__uiFixture.rejectUSB=false;window.__uiFixture.routes.output='usb';window.__uiFixture.routes.activeOutput='speaker';window.__uiFixture.routes.outputAccepted=false;});
    await page.waitForTimeout(1100);assert.equal(await outputGroup.getByRole('radio',{name:speakerName,exact:true}).getAttribute('aria-checked'),'true','Unaccepted USB preference hid the actual speaker route');
    await outputGroup.getByRole('radio',{name:speakerName,exact:true}).click();
    await page.getByRole('switch',{name:'Enable audio input',exact:true}).click();await page.getByLabel('Preferred audio input',{exact:true}).selectOption('usb');
    await outputGroup.getByRole('radio',{name:speakerName,exact:true}).click();await page.getByRole('switch',{name:'Input monitoring',exact:true}).click();
    await page.waitForFunction(()=>{const prefs=JSON.parse(localStorage.getItem('musike:audio:routes')||'{}');return prefs.input==='usb'&&prefs.output==='speaker'&&prefs.monitor===true;});
    await page.evaluate(()=>Object.assign(window.__uiFixture.routes,{monitor:false,monitorRequested:true,monitorSuspended:true,monitorRoute:{inputs:['sp-raw'],outputs:[]}}));
    await page.getByRole('switch',{name:'Input monitoring',exact:true}).getByText('Muted · waiting for device',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('musike:audio:routes')).monitor),true,'Disconnect suspension lost the saved monitoring intent');
    await page.getByRole('switch',{name:'Input monitoring',exact:true}).click();await page.waitForFunction(()=>!window.__uiFixture.routes.monitorRequested);
    await page.getByRole('switch',{name:'Enable audio input',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    console.log('PASS: automatic recording Imports/Cues and local-only menus; single mic/SP-404 choices, speaker/card switching, failed-card rollback and actual-output selection, plus saved route/monitor preferences.');
    }
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    const always=page.getByRole('switch',{name:'Always audition while dragging',exact:true});
    assert.equal(await always.getAttribute('aria-checked'),'false','Always-audition must be opt-in');await always.click();
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    await page.waitForFunction(()=>JSON.parse(window.__uiFixture.savedSession||'{}')['musike:waveform:drag-audition']==='always');
    await page.reload();await page.locator('.cue-pad-grid').waitFor();await page.getByRole('button',{name:'Settings',exact:true}).click();
    assert.equal(await always.getAttribute('aria-checked'),'true','Always-audition choice did not survive restart');
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    await page.evaluate(()=>{window.__pluginStores.player.getState().playList(window.__uiFixture.tracks);window.__pluginStores.cues.getState().setCue(1,12.125);});
    await page.waitForFunction(()=>window.__musikeAudioEl.readyState>0&&window.__pluginStores.player.getState().status==='playing');
    await page.getByRole('button',{name:'Fine waveform edit',exact:true}).click();
    const optionalWave=page.getByLabel('Edit selected cue waveform',{exact:true}),optionalBounds=await optionalWave.boundingBox(),beforeOptional=await page.evaluate(()=>window.__uiFixture.cueTriggers);
    await page.mouse.move(optionalBounds.x+optionalBounds.width*.6,optionalBounds.y+optionalBounds.height/2);await page.mouse.down();await page.mouse.move(optionalBounds.x+optionalBounds.width*.7,optionalBounds.y+optionalBounds.height/2);
    await page.waitForFunction(before=>window.__uiFixture.cueTriggers>before,beforeOptional);await page.mouse.up();
    await page.getByRole('button',{name:'Undo edit',exact:true}).click();await page.waitForFunction(()=>window.__pluginStores.cues.getState().cues[1]===12.125);
    await page.getByRole('button',{name:'Settings',exact:true}).click();await always.click();
    await page.keyboard.press('Control+z');await page.waitForFunction(()=>document.querySelector('[aria-label="Always audition while dragging"]').getAttribute('aria-checked')==='true');
    await page.keyboard.press('Control+Shift+z');await page.waitForFunction(()=>document.querySelector('[aria-label="Always audition while dragging"]').getAttribute('aria-checked')==='false');
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    const silentAfterOption=await page.evaluate(()=>window.__uiFixture.cueTriggers);
    await page.mouse.move(optionalBounds.x+optionalBounds.width*.6,optionalBounds.y+optionalBounds.height/2);await page.mouse.down();await page.mouse.move(optionalBounds.x+optionalBounds.width*.65,optionalBounds.y+optionalBounds.height/2);await page.mouse.up();await page.waitForTimeout(60);
    assert.equal(await page.evaluate(()=>window.__uiFixture.cueTriggers),silentAfterOption,'Turning always-audition off did not restore silent unheld editing');
    await page.getByRole('button',{name:'Fine waveform edit',exact:true}).click();
    await page.waitForFunction(()=>JSON.parse(window.__uiFixture.savedSession||'{}')['musike:waveform:drag-audition']==='held');
    console.log('PASS: optional always-audition setting, restart persistence, immediate live preference reads, shared preference undo/redo and silent defaults restored after disabling.');
    await page.evaluate(()=>window.__pluginStores.ui.getState().openMenu({track:window.__uiFixture.localMedia.find(track=>track.id==='locimport02'),x:100,y:100}));
    await page.getByRole('menuitem',{name:'Delete audio from library',exact:true}).click();await page.waitForFunction(()=>window.__uiFixture.erasedAudio?.includes('locimport02'));
    await page.waitForFunction(()=>!window.__pluginStores.library.getState().playlists.some(playlist=>playlist.tracks.some(track=>track.id==='locimport02')));
    assert(!(await page.evaluate(()=>window.__uiFixture.localMedia.some(track=>track.id==='locimport02'))),'Permanently removed audio remained registered for automatic recovery');
    const compressor=page.getByRole('button',{name:'Compressor',exact:true});await compressor.click();await page.waitForFunction(()=>window.__uiFixture.mixer.enabled===true);
    const compRect=await compressor.boundingBox();await page.mouse.move(compRect.x+compRect.width/2,compRect.y+compRect.height/2);await page.mouse.down();await page.waitForTimeout(650);await page.mouse.up();
    await page.getByRole('dialog',{name:'Compressor & mixer',exact:true}).waitFor();
    const setMixerRange=async(name,value)=>page.getByLabel(name,{exact:true}).evaluate((input,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(value));input.dispatchEvent(new Event('input',{bubbles:true}));},value);
    await setMixerRange('Song / cues',.7);await setMixerRange('Drums / samples',.25);await page.waitForFunction(()=>window.__uiFixture.mixer.song===.7&&window.__uiFixture.mixer.samples===.25);
    await page.getByRole('button',{name:'Reset mixer',exact:true}).click();await page.waitForFunction(()=>!window.__uiFixture.mixer.enabled&&window.__uiFixture.mixer.song===1&&window.__uiFixture.mixer.samples===1&&window.__uiFixture.mixer.output===1.5);
    await page.getByLabel('Song / cues',{exact:true}).evaluate(input=>{input.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:83}));for(const value of [.9,.8,.6]){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(value));input.dispatchEvent(new Event('input',{bubbles:true}));}input.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:83}));});
    await page.waitForFunction(()=>window.__uiFixture.mixer.song===.6);
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
    await page.getByRole('button',{name:'Undo edit',exact:true}).click();await page.waitForFunction(()=>window.__uiFixture.mixer.song===1);
    await page.getByRole('button',{name:'Redo edit',exact:true}).click();await page.waitForFunction(()=>window.__uiFixture.mixer.song===.6);
    const assignLoop=page.getByRole('button',{name:'Assign looper pads',exact:true}),loopPad=page.locator('.cue-pad[data-pad-number="16"]');
    await assignLoop.click();await loopPad.click();await page.waitForFunction(()=>document.querySelector('.cue-pad[data-pad-number="16"]').dataset.padKind==='looper');await assignLoop.click();
    const loopMode=mode=>page.waitForFunction(mode=>window.__uiFixture.loopSongs['ui000000000']?.find(pad=>pad.bank==='A'&&pad.pad===16)?.mode===mode,mode);
    await loopPad.click();await loopMode(1);
    await page.waitForFunction(()=>document.querySelector('.cue-pad[data-pad-number="16"]').dataset.looperActive==='true');
    assert.equal(await loopPad.evaluate(node=>getComputedStyle(node).animationName),'cue-looper-pulse','An active looper must pulse');
    await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await loopPad.evaluate(node=>getComputedStyle(node).animationName),'none');await page.emulateMedia({reducedMotion:'no-preference'});
    await page.locator('.cue-pad[data-pad-number="5"]').click();await page.locator('.cue-pad[data-pad-number="1"]').click();await page.waitForTimeout(350);await loopPad.click();await loopMode(2);
    await page.waitForFunction(()=>window.__uiFixture.loopSongs.ui000000000.find(pad=>pad.pad===16).count===2);
    await page.waitForTimeout(350);await loopPad.click();await loopMode(3);await page.locator('.cue-pad[data-pad-number="5"]').click();await page.waitForTimeout(350);await loopPad.click();await loopMode(2);
    await page.waitForFunction(()=>window.__uiFixture.loopSongs.ui000000000.find(pad=>pad.pad===16).layers===2);
    await page.waitForTimeout(350);await loopPad.dblclick({delay:100});await loopMode(0);
    const doubleHold=async()=>{await page.waitForTimeout(350);await loopPad.click();await page.waitForTimeout(100);const r=await loopPad.boundingBox();await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.waitForTimeout(650);await page.mouse.up();};
    await doubleHold();await page.waitForFunction(()=>window.__uiFixture.loopSongs.ui000000000.find(pad=>pad.pad===16).undone===true);
    await doubleHold();await page.waitForFunction(()=>window.__uiFixture.loopSongs.ui000000000.find(pad=>pad.pad===16).undone===false);
    await assignLoop.click();await page.locator('.cue-pad[data-pad-number="15"]').click();await page.waitForFunction(()=>document.querySelector('.cue-pad[data-pad-number="15"]').dataset.padKind==='looper');await assignLoop.click();
    const clearLoopRect=await page.locator('.cue-pad[data-pad-number="15"]').boundingBox();await page.mouse.move(clearLoopRect.x+clearLoopRect.width/2,clearLoopRect.y+clearLoopRect.height/2);await page.mouse.down();await page.waitForTimeout(1250);await page.mouse.up();
    await page.waitForFunction(()=>window.__uiFixture.loopSongs.ui000000000.find(pad=>pad.pad===15)?.length===0&&window.__uiFixture.loopSongs.ui000000000.find(pad=>pad.pad===16)?.mode===0);
    await page.reload();await page.locator('.cue-pad-grid').waitFor();await page.waitForFunction(()=>document.querySelector('.cue-pad[data-pad-number="16"]').dataset.padKind==='looper');
    assert.equal(await page.evaluate(()=>window.__uiFixture.loopSongs.ui000000000.find(pad=>pad.pad===16).count),3,'Looper events/overdub layer were lost on reload');
    console.log('PASS: permanent local-track removal, compressor tap/hold mixer and independent levels/reset, internal loop assignment/record/play/overdub/stop/layer undo-redo/hold-clear and restart.');
  }else{
    await page.getByRole('button',{name:'MIDI settings',exact:true}).click();
    assert.equal(await page.getByLabel('Pad numbering',{exact:true}).count(),0,'Preview controls leaked into a normal build');
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  }
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  if(!iosPreview)assert.equal(await page.getByRole('switch',{name:'Always audition while dragging',exact:true}).count(),0,'Preview audition setting leaked into a normal build');
  if(iosPreview){
    const fades=page.getByRole('switch',{name:'Fade between songs',exact:true});assert.equal(await fades.getAttribute('aria-checked'),'true','Song fades must default On');assert.equal(await page.getByLabel('Song fade duration',{exact:true}).inputValue(),'350');
    await fades.click();await page.waitForFunction(()=>JSON.parse(JSON.parse(window.__uiFixture.savedSession||'{}')['musike:transitions']||'{}').enabled===false);
    await page.reload();await page.locator('.cue-pad-grid').waitFor();await page.getByRole('button',{name:'Settings',exact:true}).click();assert.equal(await fades.getAttribute('aria-checked'),'false','Instant/Off song transitions did not survive restart');
    await fades.click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('musike:transitions')).enabled===true);
    console.log('PASS: default-On 350 ms song fades, saved Instant/Off setting and restart persistence.');
  }
  await page.getByRole('radiogroup',{name:'Accent color',exact:true}).getByRole('radio',{name:'Pink',exact:true}).click();
  if(iosPreview){
    const colors=page.getByRole('radiogroup',{name:'Looper pad colour',exact:true});
    assert.equal(await colors.getByRole('radio',{name:'Complementary to accent',exact:true}).getAttribute('aria-checked'),'true');
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
    assert.equal(await page.locator('.cue-workspace').evaluate(node=>node.style.getPropertyValue('--cue-looper-color')),'#72f4b0','Automatic looper colour must follow the complementary accent');
    const selection=await page.locator('.cue-track-label').evaluate(node=>({selectable:getComputedStyle(node).userSelect,selected:node.dispatchEvent(new Event('selectstart',{bubbles:true,cancelable:true})),context:node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))}));
    assert.equal(selection.selectable,'none');assert.equal(selection.selected,false);assert.equal(selection.context,false);
    await page.getByRole('button',{name:'Settings',exact:true}).click();await colors.getByRole('radio',{name:'Sky',exact:true}).click();
    await page.waitForFunction(()=>JSON.parse(window.__uiFixture.savedSession||'{}')['musike:appearance']&&JSON.parse(JSON.parse(window.__uiFixture.savedSession)['musike:appearance']).looperColor==='#60a5fa');
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
    await page.reload();await page.locator('.cue-pad-grid').waitFor();
    await page.locator('.boot').waitFor({state:'detached'});
    assert.equal(await page.locator('.cue-workspace').evaluate(node=>node.style.getPropertyValue('--cue-looper-color')),'#60a5fa','Chosen looper colour must survive restart');
    console.log('PASS: active looper pulse/reduced-motion state, automatic complementary or saved custom colours, and disabled Cues text selection/long-press callouts.');
  }else{
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  }
  // The dimming scrim can finish its exit a little after the dialog itself.
  await page.waitForTimeout(350);
  const themed=await page.evaluate(()=>({logo:getComputedStyle(document.querySelector('.cue-workspace header svg')).color,track:getComputedStyle(document.querySelector('.cue-speed input'),'::-webkit-slider-runnable-track').backgroundImage,padShadow:getComputedStyle(document.querySelector('.cue-pad')).boxShadow,padBorder:getComputedStyle(document.querySelector('.cue-pad')).borderWidth}));
  assert.equal(themed.logo,'rgb(244, 114, 182)');assert.equal(themed.padShadow,'none');assert.equal(themed.padBorder,'0px');
  const slider=pngPixels(await page.locator('.cue-speed input').screenshot());let accentPixels=0;
  if(process.env.NATIVE_UI_SCREENSHOT)await page.screenshot({path:process.env.NATIVE_UI_SCREENSHOT});
  for(let y=Math.floor(slider.height/2)-2;y<Math.floor(slider.height/2)+2;y++)for(let x=4;x<Math.floor(slider.width*.3);x++){const c=slider.pixel(x,y);if(Math.abs(c[0]-244)<12&&Math.abs(c[1]-114)<12&&Math.abs(c[2]-182)<12)accentPixels++;}
  assert(accentPixels>20,'Rendered speed-fader line must use the app accent: '+JSON.stringify({accentPixels,pixel:slider.pixel(10,Math.floor(slider.height/2)),style:await page.locator('.cue-speed input').getAttribute('style')}));
  const shapes=[[320,568],[568,320],[667,375],[736,414],[768,1024],[1024,768],[820,1180],[1180,820],[768,512],[800,600],[960,540],[1280,600]];
  for(const [width,height] of shapes){
    await page.setViewportSize({width,height});await page.waitForTimeout(120);
    if(await page.getByLabel('Toggle playlist',{exact:true}).getAttribute('aria-expanded')!=='true')await page.getByLabel('Toggle playlist',{exact:true}).click();
    const queue=await page.getByRole('region',{name:'Playlist songs',exact:true}).boundingBox();const nav=await page.locator('.music-app>nav').boundingBox();
    assert(queue.width>=Math.min(220,width-50)&&queue.x>=0&&queue.x+queue.width<=width+1&&queue.y>=0&&queue.y+queue.height<=nav.y+1,'Playlist is clipped at '+width+'x'+height+': '+JSON.stringify(queue));
    await page.getByRole('region',{name:'Playlist songs',exact:true}).evaluate(element=>{element.scrollTop=element.scrollHeight;});
    await page.waitForFunction(()=>!!document.querySelector('.cue-song-list [aria-posinset="500"]'));
    await page.getByLabel('Toggle playlist',{exact:true}).click();
    const geometry=await page.evaluate(()=>{const nav=document.querySelector('.music-app>nav').getBoundingClientRect();return {scroll:document.querySelector('main').scrollHeight-document.querySelector('main').clientHeight,controls:[...document.querySelectorAll('.cue-pad,.cue-speed input,.cue-loop button,.cue-preset,.cue-record')].map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};}),limit:nav.top,overflow:document.documentElement.scrollWidth-innerWidth};});
    assert(geometry.scroll<=2&&geometry.overflow<=1&&geometry.controls.every(r=>r.x>=0&&r.y>=0&&r.right<=width+1&&r.bottom<=geometry.limit+1&&r.width>=20&&r.height>=20),'Performance clipping at '+width+'x'+height+': '+JSON.stringify(geometry));
    if(iosPreview){const alignment=await page.locator('.cue-record').evaluate(node=>{const a=node.getBoundingClientRect(),row=document.querySelector('.cue-overwrite-row').getBoundingClientRect(),banks=document.querySelector('.cue-bankbar').getBoundingClientRect();return {aligned:Math.abs(a.right-row.right)<2&&(banks.width===0||Math.abs(row.x-banks.x)<2&&Math.abs(row.width-banks.width)<2),record:a.toJSON(),row:row.toJSON(),children:[...document.querySelector('.cue-overwrite-row').children].map(node=>({class:node.className,rect:node.getBoundingClientRect().toJSON()}))};});assert(alignment.aligned,'Record/control/bank right-edge alignment failed at '+width+'x'+height+': '+JSON.stringify(alignment));}
  }
  await page.setViewportSize({width:768,height:1024});await navigate('/library');
  await page.locator('a[href="/playlist/fixture-playlist"]').first().click();
  await page.locator('.collection-hero').waitFor();
  for(const [width,height] of [[768,1024],[1024,768],[667,375]]){
    await page.setViewportSize({width,height});await page.waitForTimeout(100);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.collection-heading').getBoundingClientRect().right<=innerWidth+1),'Long playlist header overflows tablet/landscape width');
  }
  await page.setViewportSize({width:1024,height:768});await navigate('/');
  await page.locator('.recent-track-card').first().waitFor();
  for(const [width,height] of [[360,760],[768,1024],[1024,768]]){
    await page.setViewportSize({width,height});await page.waitForTimeout(100);
    const cards=await page.locator('.recent-track-card').evaluateAll(nodes=>nodes.slice(0,3).map(card=>{const art=card.querySelector('[data-artwork-state]').getBoundingClientRect();return {width:art.width,height:art.height,cardHeight:card.getBoundingClientRect().height};}));
    assert(cards.every(c=>Math.abs(c.width-cards[0].width)<1&&Math.abs(c.height-cards[0].height)<1&&Math.abs(c.cardHeight-cards[0].cardHeight)<1),'Missing/failed artwork changes recent card size: '+JSON.stringify(cards));
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Recent titles overflow the page width');
    if(width<768)assert(await page.evaluate(()=>document.querySelector('.mini-player').getBoundingClientRect().bottom<document.querySelector('.music-app>nav').getBoundingClientRect().top),'Recent-page player overlaps navigation');
  }
  await page.getByRole('button',{name:'List view',exact:true}).click();await page.locator('.recent-track-list').waitFor();
  const artSizes=await page.locator('.recent-track-list .track-artwork').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().width));assert(artSizes.every(size=>size===44),'List artwork sizes must stay equal');
  await page.waitForFunction(()=>{const saved=window.__uiFixture.savedSession;if(!saved)return false;const state=JSON.parse(saved);return JSON.parse(state['musike:appearance']||'{}').recentView==='list';});
  await page.reload();await page.locator('.recent-track-list').waitFor();assert.equal(await page.getByRole('button',{name:'List view',exact:true}).getAttribute('aria-pressed'),'true','Recent list preference survives reload');
  await page.goto(`http://127.0.0.1:${server.address().port}/?hosted=0`);
  await page.waitForFunction(()=>window.__pluginStores&&document.querySelector('.music-app'));
  await page.locator('.boot').waitFor({state:'detached'});
  await page.evaluate(()=>window.__pluginStores.player.getState().playList(window.__uiFixture.tracks));
  await page.waitForFunction(()=>window.__pluginStores.player.getState().status==='playing');
  await navigate('/cues');await page.locator('.cue-pad').first().focus();
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.__pluginStores.player.getState().status==='paused');
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.__pluginStores.player.getState().status==='playing');
  await page.locator('.cue-speed input').focus();await page.keyboard.press('Space');
  await page.waitForFunction(()=>window.__pluginStores.player.getState().status==='paused');
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.__pluginStores.player.getState().status==='playing');
  assert.deepEqual(errors,[]);
  console.log('PASS: native default linear16, minimal pads, themed logo/fader, 12 responsive shapes, 500-song queue, titles/artwork/recent list, and standalone Space after pad/fader focus.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
