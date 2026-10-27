import assert from 'node:assert/strict';
import {build} from '../server/node_modules/esbuild/lib/main.js';
const bundle=await build({entryPoints:['web/src/lib/api.ts'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'language-fixture',setup(builder){builder.onResolve({filter:/\/i18n$/},()=>({path:'language',namespace:'fixture'}));builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const getLang=()=>"en";export const getT=()=>({player:{httpError:n=>"HTTP "+n}});'}));}}]});
const {api}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const original=globalThis.fetch;
const header={id:'PLfixture50000',title:'Étés 🎹',author:'Test',thumb:'',truncated:false};
const track=(id,title)=>({id,title,artist:'Test',duration:180,thumb:'',art:'',kind:'song'});
function stream(messages){const bytes=new TextEncoder().encode(messages.map(message=>JSON.stringify(message)+'\n').join(''));return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close();}}),{headers:{'content-type':'application/x-ndjson; charset=utf-8'}});}
try{
  globalThis.fetch=async()=>stream([{type:'page',page:{...header,tracks:[track('bench000001','Été 🎹')],complete:false}},{type:'page',page:{...header,tracks:[track('bench000002','Second'),track('bench000001','Updated 🎹')],complete:true}},{type:'done',page:{...header,tracks:[],complete:true}}]);
  const seen=[];const page=await api.youtubePlaylist(header.id,undefined,page=>seen.push(page));
  assert.equal(seen[0].tracks.length,1);assert.equal(seen[0].tracks[0].title,'Été 🎹');
  assert.deepEqual(page.tracks.map(track=>track.id),['bench000001','bench000002']);assert.equal(page.tracks[0].title,'Updated 🎹');
  globalThis.fetch=async()=>stream([{type:'page',page:{...header,tracks:[],complete:false}}]);await assert.rejects(api.youtubePlaylist(header.id,undefined,()=>{}),/did not complete/);
  globalThis.fetch=async()=>stream([{type:'error',status:403,error:'Private playlist'}]);await assert.rejects(api.youtubePlaylist(header.id,undefined,()=>{}),/Private playlist/);
  globalThis.fetch=async()=>new Response(JSON.stringify({...header,tracks:[],complete:true}),{headers:{'content-type':'application/json'}});assert.equal((await api.youtubePlaylist(header.id,undefined,()=>{})).title,header.title);
  console.log('PASS: incremental deltas, split UTF-8, duplicate updates/order, incomplete transfer rejection, errors and legacy JSON compatibility');
}finally{globalThis.fetch=original;}
