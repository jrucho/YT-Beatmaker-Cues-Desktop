import assert from 'node:assert/strict';
import {build} from '../server/node_modules/esbuild/lib/main.js';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const bundle=await build({entryPoints:['server/src/library.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const fresh=()=>import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text+'\n//'+Math.random()).toString('base64'));
const root=await mkdtemp(path.join(tmpdir(),'beatmaker-library-'));
try{
 let disk=null,fail=false,reads=0;
 const storage={read:async()=>{++reads;await new Promise(r=>setTimeout(r,5));return disk;},write:async text=>{if(fail){fail=false;throw Error('simulated full disk');}disk=text;}};
 let lib=await fresh();lib.useLibraryStorage(storage);
 await Promise.all(Array.from({length:10},()=>lib.getLibrary()));assert.equal(reads,1,'Concurrent initial reads use one load');
 const p=await lib.createPlaylist('Persistent');
 fail=true;await assert.rejects(lib.renamePlaylist(p.id,'Failed save'));
 await lib.renamePlaylist(p.id,'Recovered save');
 lib=await fresh();lib.useLibraryStorage(storage);assert.equal((await lib.getLibrary()).playlists[0].name,'Recovered save');
 console.log('PASS: single-flight initialization, failed-write recovery and cold library restore');
 const files=await build({entryPoints:['server/src/libraryFile.ts'],bundle:true,write:false,platform:'node',format:'esm',define:{'import.meta.url':JSON.stringify(new URL('../server/src/config.ts',import.meta.url).href)}});
 const {fileStorage}=await import('data:text/javascript;base64,'+Buffer.from(files.outputFiles[0].text).toString('base64'));
 const data={favorites:[],playlists:[{id:'playlist0',name:'Safe',createdAt:1,updatedAt:1,tracks:[]}],history:[]};
 const diskStore=fileStorage(root);await diskStore.write(JSON.stringify(data));data.playlists[0].name='Updated';await diskStore.write(JSON.stringify(data));
 await writeFile(path.join(root,'library.json'),'{broken');
 assert.equal(JSON.parse(await diskStore.read()).playlists[0].name,'Safe','Backup recovers corrupt primary');
 await diskStore.write(JSON.stringify(data));assert.equal(JSON.parse(await readFile(path.join(root,'library.json'),'utf8')).playlists[0].name,'Updated');
 console.log('PASS: atomic file writes, valid backup recovery and retained corrupt data');
}finally{await rm(root,{recursive:true,force:true});}
