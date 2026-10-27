// Run with server's tsx loader, after building StoreTests and the desktop lock helper.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {config} from '../server/src/config.ts';
import {fileStorage} from '../server/src/libraryFile.ts';
import {sharedFileStorage,withLibraryLock,readSharedDocument} from '../server/src/sharedLibrary.ts';
import * as library from '../server/src/library.ts';
import {importLocalAudio,localAudio} from '../server/src/localAudio.ts';
const root=path.resolve(import.meta.dirname,'..');
const native=process.env.BEATMAKER_STORE_TESTS||path.join(root,'plugin/build-mac-beta/StoreTests_artefacts/Release/StoreTests');
config.libraryLockHelper=process.env.BEATMAKER_LIBRARY_LOCK_HELPER||path.join(root,'desktop/native-bin',process.arch,'beatmaker-library-lock'+(process.platform==='win32'?'.exe':''));
const run=(args)=>new Promise((resolve,reject)=>{const child=spawn(native,args);let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);child.on('error',reject);child.on('close',code=>code===0?resolve(output):reject(Error(errors||`Native writer exited ${code}`)));});
const work=await mkdtemp(path.join(tmpdir(),'beatmaker-shared-'));
const main=path.join(work,'main'),plugin=path.join(work,'plugin'),shared=path.join(work,'shared');
const track={id:'track000001',title:'Shared 日本語 🎵',artist:'Test',duration:1,kind:'song',thumb:'',art:''};
const playlist=(id,name)=>({id,name,createdAt:1,updatedAt:1,tracks:[track]});
const empty=()=>({favorites:[],history:[],playlists:[]});
try{
  await Promise.all([main,plugin,shared].map(dir=>mkdir(dir)));
  const desktopLegacy={...empty(),playlists:[playlist('desktop001','Desktop original')]};
  const pluginLegacy={...empty(),playlists:[playlist('plugin0001','Plugin original')]};
  await writeFile(path.join(main,'library.json'),JSON.stringify(desktopLegacy));
  await writeFile(path.join(plugin,'library-v1.json'),JSON.stringify({schema:1,revision:1,library:pluginLegacy,preferences:{theme:'dark'},media:{loc12345678:{...track,id:'loc12345678',path:'/missing/kept.wav'}}}));
  await run(['--shared-read',plugin,shared]);
  const storage=sharedFileStorage(fileStorage(main),main,shared);library.useLibraryStorage(storage);
  assert.equal((await library.getLibrary()).playlists.length,2);
  assert.equal((await readSharedDocument(shared)).media.loc12345678.path,'/missing/kept.wav');
  await Promise.all([
    ...(process.env.BEATMAKER_SWIFT_STORE_TESTS?[new Promise((resolve,reject)=>{const child=spawn(process.env.BEATMAKER_SWIFT_STORE_TESTS,['--writer',shared,'swift-A-','20'],{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Swift writer failed')));})]:[]),
    run(['--shared-writer',path.join(work,'nativeA'),shared,'native-A-', '30']),
    run(['--shared-writer',path.join(work,'nativeB'),shared,'native-B-', '30']),
    ...Array.from({length:25},(_,i)=>library.createPlaylist('Desktop concurrent '+i)),
  ]);
  const expected=87+(process.env.BEATMAKER_SWIFT_STORE_TESTS?20:0);
  assert.equal((await library.getLibrary()).playlists.length,expected,'Cross-language edits were lost');
  const before=await storage.read(),edited=JSON.parse(before);edited.playlists.find(p=>p.id==='plugin0001').name='Concurrent native rename';
  const baseFile=path.join(work,'base.json'),editFile=path.join(work,'edit.json');await writeFile(baseFile,before);await writeFile(editFile,JSON.stringify(edited));
  const nodeEdit=JSON.parse(before);nodeEdit.playlists.find(p=>p.id==='plugin0001').tracks.push({...track,id:'track000002'});
  await Promise.all([run(['--commit',shared,baseFile,editFile]),storage.write(JSON.stringify(nodeEdit),before)]);
  const merged=JSON.parse(await storage.read()).playlists.find(p=>p.id==='plugin0001');assert.equal(merged.name,'Concurrent native rename');assert.equal(merged.tracks.length,2);
  await library.deletePlaylist('desktop001');
  const reopened=sharedFileStorage(fileStorage(main),main,shared);assert(!JSON.parse(await reopened.read()).playlists.some(p=>p.id==='desktop001'),'Migration resurrected a removed playlist');
  assert.equal(await readFile(path.join(main,'library.json'),'utf8'),JSON.stringify(desktopLegacy),'Migration overwrote the original main-app library');
  assert.equal(JSON.parse(await readFile(path.join(plugin,'library-v1.json'),'utf8')).preferences.theme,'dark','Shared writes touched product session preferences');
  await writeFile(path.join(main,'library.json'),'{corrupt old source');assert.equal(JSON.parse(await sharedFileStorage(fileStorage(main),main,shared).read()).playlists.length,expected-1);
  await assert.rejects(withLibraryLock(shared,async()=>{throw new Error('injected write failure');}),/injected/);
  await withLibraryLock(shared,async()=>{});
  const holder=spawn(config.libraryLockHelper,[path.join(shared,'library.lock')],{stdio:['pipe','pipe','pipe']});
  await new Promise((resolve,reject)=>{holder.once('error',reject);holder.stdout.once('data',resolve);});
  holder.kill('SIGKILL');await new Promise(resolve=>holder.once('close',resolve));await withLibraryLock(shared,async()=>{});
  const owner=spawn(process.execPath,['--import',path.join(root,'server/node_modules/tsx/dist/loader.mjs'),'--input-type=module','-e',`import {config} from ${JSON.stringify(pathToFileURL(path.join(root,'server/src/config.ts')).href)};import {withLibraryLock} from ${JSON.stringify(pathToFileURL(path.join(root,'server/src/sharedLibrary.ts')).href)};config.libraryLockHelper=${JSON.stringify(config.libraryLockHelper)};await withLibraryLock(${JSON.stringify(shared)},async()=>{console.log('held');await new Promise(()=>{});});`],{stdio:['ignore','pipe','inherit']});
  await new Promise((resolve,reject)=>{owner.once('error',reject);owner.stdout.once('data',resolve);});
  owner.kill('SIGKILL');await new Promise(resolve=>owner.once('close',resolve));await withLibraryLock(shared,async()=>{});
  config.sharedLibraryDir=shared;config.dataDir=main;
  const input=path.join(work,'local.wav');await writeFile(input,Buffer.from('preserved imported audio fixture'));
  const imported=await importLocalAudio(input);assert.equal((await localAudio(imported.id)).track.id,imported.id);
  const document=await readSharedDocument(shared);assert.equal(await readFile(document.media[imported.id].path,'utf8'),'preserved imported audio fixture');
  console.log(`PASS: main/plugin additive migration, ${expected-2} concurrent cross-language writes${process.env.BEATMAKER_SWIFT_STORE_TESTS?' including Swift':''}, field/track merge, deletion persistence, preserved sources/sessions, lock crash release and shared local media`);
}finally{await rm(work,{recursive:true,force:true});}
