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
      window.__uiFixture={tracks,position:12.125,sourceId:0,queue:{tracks:[],index:0},ready:false,playing:false};
      const library={favorites:[],history:tracks.slice(0,16),playlists:[{id:'fixture-playlist',name:'A long playlist name '+('with words '.repeat(12)),tracks}]};
      const listeners={};
      const emit=(name,value)=>(listeners[name]||[]).forEach(fn=>fn(value));
      window.__JUCE__={initialisationData:{hostedPlugin:[${url.searchParams.get('hosted')==='1'}],desktopPlatform:[${url.searchParams.get('hosted')==='1'}],pluginStorage:['{}']},backend:{
        addEventListener(name,fn){(listeners[name]??=[]).push(fn);},
        emitEvent(event,{name,params,resultId}){setTimeout(()=>{
          let result=true;const f=window.__uiFixture,request=params[0];
          if(name==='initialState')result={defaults:'{}',session:realStorage.getItem('ui-fixture-session')||JSON.stringify(${url.searchParams.get('hosted')==='1'}?{'musike:midi:preset':'linear16'}:{})};
          else if(name==='store'){realStorage.setItem('ui-fixture-session',request);f.savedSession=request;}
          else if(name==='libraryVersion')result='1';
          else if(name==='librarySnapshot')result={json:JSON.stringify(library),version:'1'};
          else if(name==='libraryRead'||name==='libraryCommit')result=JSON.stringify(library);
          else if(name==='padSamples')result=[];
          else if(name==='waveform')result={peaks:Array(1024).fill(.5),progress:1};
          else if(name==='cachedTrack')result={...tracks.find(t=>t.id===request),url:'beatmaker-local://'+request,mime:'audio/wav',duration:60};
          else if(name==='audio'){
            if(request.cmd==='load'){f.sourceId=request.sourceId;f.queue=request.queue;f.ready=true;f.position=request.startAt||0;}
            if(request.cmd==='queue')f.queue=request.queue;
            if(request.cmd==='play')f.playing=true;
            if(request.cmd==='pause')f.playing=false;
            if(request.cmd==='seek'||request.cmd==='cue')f.position=request.to;
            if(request.cmd==='position')result={position:f.position};
            else if(request.cmd==='snapshot')result={...f,position:f.position,duration:60,buffered:f.ready?60:0,queueIndex:f.queue.index||0,trackId:f.queue.tracks?.[f.queue.index||0]?.id};
            else result={};
            if(request.cmd==='load')setTimeout(()=>emit('pluginAudio',{event:'ready',payload:{sourceId:f.sourceId,duration:60}}),0);
            if(request.cmd==='play'||request.cmd==='pause')setTimeout(()=>emit('pluginAudio',{event:request.cmd==='play'?'playing':'pause',payload:{sourceId:f.sourceId}}),0);
          }
          else if(name==='http')result={status:200,headers:{},data:'{}'};
          emit('__juce__complete',{promiseId:resultId,result});
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
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('radio',{name:'Pink',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
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
    const geometry=await page.evaluate(()=>{const nav=document.querySelector('.music-app>nav').getBoundingClientRect();return {scroll:document.querySelector('main').scrollHeight-document.querySelector('main').clientHeight,controls:[...document.querySelectorAll('.cue-pad,.cue-speed input,.cue-loop button,.cue-preset')].map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};}),limit:nav.top,overflow:document.documentElement.scrollWidth-innerWidth};});
    assert(geometry.scroll<=2&&geometry.overflow<=1&&geometry.controls.every(r=>r.x>=0&&r.y>=0&&r.right<=width+1&&r.bottom<=geometry.limit+1&&r.width>=20&&r.height>=20),'Performance clipping at '+width+'x'+height+': '+JSON.stringify(geometry));
  }
  await page.setViewportSize({width:768,height:1024});await navigate('/library');
  await page.evaluate(()=>document.querySelector('a[href="/playlist/fixture-playlist"]')?.click());
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
