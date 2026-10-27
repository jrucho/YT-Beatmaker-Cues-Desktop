import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {build} from '../server/node_modules/esbuild/lib/main.js';

const source=await readFile('server/src/playlists.ts','utf8');
let previous;try{previous=execFileSync('git',['show','7436987:server/src/playlists.ts'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});}catch{/* Source ZIP/shallow checkout: run current-code assertions without historical timings. */}
async function moduleFor(contents){
  const bundle=await build({stdin:{contents,loader:'ts',resolveDir:path.resolve('server/src')},bundle:true,write:false,platform:'node',format:'esm',plugins:[{
    name:'playlist-fixture-client',setup(builder){builder.onResolve({filter:/^\.\/search\.js$/},()=>({path:'search',namespace:'fixture'}));builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const withClient=async fn=>fn(globalThis.__playlistFixtureYT);export const text=value=>value==null?"":String(value);export const toTrack=value=>value;'}));},
  }]});
  return import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text+'\n//'+Math.random()).toString('base64'));
}
function fixture(total=500,delay=15){
  let calls=0;
  const wait=async()=>{++calls;await new Promise(resolve=>setTimeout(resolve,delay));};
  const page=index=>({info:{title:'Large public playlist',author:{name:'Fixture'},thumbnails:[]},items:Array.from({length:Math.min(100,total-index*100)},(_,row)=>({id:'bench'+String(index*100+row).padStart(6,'0'),title:'Track '+(index*100+row),artist:'Fixture',duration:180,kind:'song',thumb:'',art:''})),has_continuation:(index+1)*100<total,getContinuation:async()=>{await wait();return page(index+1);}});
  globalThis.__playlistFixtureYT={getPlaylist:async()=>{await wait();return page(0);}};
  return ()=>calls;
}
const link='https://www.youtube.com/playlist?list=PLfixture50000';
const metrics=[];
for(const [name,code] of [...(previous?[['previous',previous]]:[]),['current',source]]){
  const calls=fixture();const api=await moduleFor(code);const started=performance.now();
  await api.searchPlaylists(link);const titleMs=performance.now()-started;let previewMs;
  const result=await api.getPlaylist(link,undefined,{onProgress:()=>{previewMs??=performance.now()-started;}});
  metrics.push({name,metadataRequests:calls(),titleMs:Math.round(titleMs),firstPreviewMs:Math.round(previewMs??performance.now()-started),completeMs:Math.round(performance.now()-started)});
  assert.equal(result.tracks.length,500);
  if(name==='current'){assert.equal(calls(),5);const before=calls();await api.getPlaylist(link);assert.equal(calls(),before,'Warm reopen must not fetch playlist again');}
}
{
  const calls=fixture();const api=await moduleFor(source),controller=new AbortController();
  const [cancelled,complete]=await Promise.all([api.getPlaylist(link,undefined,{signal:controller.signal,onProgress:page=>{if(page.tracks.length>=200)controller.abort();}}).catch(error=>error.name),api.getPlaylist(link)]);
  assert.equal(cancelled,'AbortError');assert.equal(complete.tracks.length,500);assert.equal(calls(),5,'Concurrent consumers share one continuation sequence');
}
{
  const calls=fixture();const api=await moduleFor(source),controller=new AbortController();
  await assert.rejects(api.getPlaylist(link,undefined,{signal:controller.signal,onProgress:()=>controller.abort()}),{name:'AbortError'});
  assert.equal(calls(),1,'Closing after first page must stop further metadata downloads');
  assert.equal((await api.getPlaylist(link)).tracks.length,500);assert.equal(calls(),5,'Reopen resumes the cached first page');
}
{
  const calls=fixture(600,0),api=await moduleFor(source);const page=await api.getPlaylist(link);assert.equal(page.tracks.length,500);assert.equal(page.truncated,true);assert.equal(calls(),5);
}
console.log(JSON.stringify({conditions:'Synthetic YouTube pages; 100 tracks/page, 15 ms/request. Request counts and incremental results test real playlist code, not actual platform network latency.',metrics},null,2));
console.log('PASS: no duplicate full fetch, early preview, warm cache, concurrent deduplication, independent cancellation and 500-track limit');
