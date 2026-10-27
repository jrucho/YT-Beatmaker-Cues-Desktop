// Deterministic UI benchmark: real app/server, synthetic metadata and local media.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:net';
import {chromium} from 'playwright';

const root=path.resolve(import.meta.dirname,'..');
const work=await mkdtemp(path.join(tmpdir(),'beatmaker-large-playlist-'));
const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const origin=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,[path.join(root,'server/node_modules/tsx/dist/cli.mjs'),path.join(root,'server/src/index.ts')],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',MUSIKE_DATA_DIR:work},stdio:['ignore','pipe','pipe']});
let logs='';server.stdout.on('data',data=>logs+=data);server.stderr.on('data',data=>logs+=data);
let browser;
const results=[];
try{
  let healthy=false;for(let i=0;i<100;i++){try{if((await fetch(origin+'/api/health')).ok){healthy=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert(healthy,logs);
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
  for(const count of [200,500]){
    const tracks=Array.from({length:count},(_,index)=>({id:'bench'+String(index).padStart(6,'0'),title:'Large track '+String(index+1).padStart(4,'0'),artist:'Benchmark',duration:180,kind:'song',thumb:'https://fixture.invalid/cover.svg',art:'https://fixture.invalid/cover.svg'}));
    const response=await fetch(origin+'/api/playlists',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:`Benchmark ${count}`,tracks})});assert(response.ok);const playlist=await response.json();
    for(const viewport of [{width:390,height:844},{width:1280,height:850}]){
      const context=await browser.newContext({viewport});const page=await context.newPage();const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
      await page.route('https://fixture.invalid/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><rect width="44" height="44" fill="#333"/></svg>'}));
      await page.addInitScript(()=>{window.__longTasks=[];window.__largestTickGap=0;let previous=performance.now();setInterval(()=>{const now=performance.now();window.__largestTickGap=Math.max(window.__largestTickGap,now-previous);previous=now;},16);new PerformanceObserver(list=>window.__longTasks.push(...list.getEntries().map(entry=>entry.duration))).observe({type:'longtask',buffered:true});});
      const started=Date.now();await page.goto(origin+'/playlist/'+playlist.id,{waitUntil:'domcontentloaded'});
      await page.getByRole('button',{name:'Play Large track 0001',exact:true}).waitFor();
      const firstRowMs=Date.now()-started;await page.waitForTimeout(500);
      const metrics=await page.evaluate(()=>({mountedRows:document.querySelectorAll('button[aria-label^="Play Large track "]').length,domNodes:document.querySelectorAll('*').length,largestLongTaskMs:Math.max(0,...window.__longTasks),largestTickGapMs:window.__largestTickGap}));
      results.push({tracks:count,viewport,cpuThrottle:4,firstRowMs,...metrics});
      if(process.argv.includes('--verify')){
        assert(metrics.mountedRows<60,`${count}-track list mounts ${metrics.mountedRows} rows`);
        const first=page.getByRole('button',{name:'Play Large track 0001',exact:true});await first.focus();await first.press('End');
        const label='Play Large track '+String(count).padStart(4,'0');
        await page.waitForFunction(label=>document.activeElement?.getAttribute('aria-label')===label,label);
        const last=page.getByRole('button',{name:label,exact:true});
        const visibility=await last.evaluate(button=>{const box=button.getBoundingClientRect(),parent=button.closest('main'),bounds=parent.getBoundingClientRect(),padding=parseFloat(getComputedStyle(parent).paddingBottom);return {top:box.top,bottom:box.bottom,parentTop:bounds.top,parentBottom:bounds.bottom,padding,scrollTop:parent.scrollTop,scrollHeight:parent.scrollHeight};});
        assert(visibility.top>=visibility.parentTop-2&&visibility.bottom<=visibility.parentBottom-visibility.padding+2,'Keyboard End must reveal the last track above the player/navigation: '+JSON.stringify(visibility));
        assert(await page.locator('button[aria-label^="Play Large track "]').count()<60,'Keyboard focus must not mount the full list');
        await last.press('Home');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Play Large track 0001');
      }
      await context.close();
    }
  }
  console.log(JSON.stringify({environment:'Chromium synthetic metadata; 4x CPU throttle; not a physical AUv3 timing claim',results},null,2));
  const output=process.argv.find(arg=>arg.startsWith('--output='))?.slice(9);if(output)await writeFile(output,JSON.stringify({results},null,2)+'\n');
}finally{await browser?.close();server.kill();await rm(work,{recursive:true,force:true});}
