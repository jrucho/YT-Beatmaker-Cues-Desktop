import {spawn} from 'node:child_process';
import {mkdir,readFile,open,rename,copyFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {config} from './config.js';
import {emptyLibrary,validLibrary,mergeLibraryValue,importLegacyLibrary} from './libraryMerge.js';
import type {LibraryStorage} from './library.js';

export interface SharedDocument {schema:1;revision:number;library:unknown;media?:Record<string,unknown>;imports?:Record<string,boolean>;[key:string]:unknown}
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
export async function withLibraryLock<T>(directory:string,action:()=>Promise<T>):Promise<T>{
  if(!config.libraryLockHelper)throw new Error('Native library-lock helper is unavailable; rebuild the desktop app');
  await mkdir(directory,{recursive:true});
  const holder=spawn(config.libraryLockHelper,[path.join(directory,'library.lock')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  holder.stdin.on('error',()=>{});holder.stderr.resume();
  const exited=new Promise<void>(resolve=>holder.once('close',()=>resolve()));
  try{
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{holder.kill();reject(new Error('Shared library lock timed out'));},6500);let output='';
      const done=(error?:Error)=>{clearTimeout(timer);holder.stdout.off('data',data);holder.off('error',failed);holder.off('exit',failedExit);error?reject(error):resolve();};
      const failed=(error:Error)=>done(error),failedExit=()=>done(new Error('Shared library is busy or unavailable; retry the edit'));
      const data=(chunk:Buffer)=>{output+=chunk.toString();if(/locked\r?\n/.test(output))done();};
      holder.stdout.on('data',data);holder.once('error',failed);holder.once('exit',failedExit);
    });
    return await action();
  }finally{holder.stdin.end();await exited;}
}
export async function readSharedDocument(directory:string):Promise<SharedDocument>{
  let damaged=false;
  for(const name of ['library-v1.json','library-v1.backup.json']){
    let text:string;try{text=await readFile(path.join(directory,name),'utf8');}catch(error){if(missing(error))continue;throw error;}
    try{const value=JSON.parse(text);if(value.schema===1&&validLibrary(value.library))return value;}catch{}
    damaged=true;
  }
  if(damaged)throw new Error('Shared library needs recovery; original files have been retained');
  return {schema:1,revision:0,library:emptyLibrary(),preferences:{}};
}
export async function writeSharedDocument(directory:string,document:SharedDocument){
  const file=path.join(directory,'library-v1.json'),backup=path.join(directory,'library-v1.backup.json');
  try{
    const before=await readFile(file,'utf8');let healthy=false;try{const parsed=JSON.parse(before);healthy=parsed.schema===1&&validLibrary(parsed.library);}catch{}
    if(healthy)await atomicText(backup,before);else await copyFile(file,path.join(directory,`library-corrupt-${Date.now()}-${randomUUID()}.json`));
  }catch(error){if(!missing(error))throw error;}
  await atomicText(file,JSON.stringify(document));
}
async function atomicText(file:string,text:string){
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{const output=await open(temporary,'wx',0o600);try{await output.writeFile(text,'utf8');await output.sync();}finally{await output.close();}await rename(temporary,file);}
  finally{await rm(temporary,{force:true});}
}
export function sharedFileStorage(legacy:LibraryStorage,legacyDirectory:string,directory:string):LibraryStorage{
  let initialized:Promise<void>|undefined;
  const initialize=()=>initialized??=(async()=>{
    await withLibraryLock(directory,async()=>{
      const document=await readSharedDocument(directory),source='desktop-library:'+path.join(legacyDirectory,'library.json');
      if(document.imports?.[source])return;
      const original=await legacy.read();let localMedia:Record<string,{track:unknown;file:string}>={};
      try{localMedia=JSON.parse(await readFile(path.join(legacyDirectory,'local-media.json'),'utf8'));}catch(error){if(!missing(error))throw error;}
      document.library=importLegacyLibrary(document.library,original?JSON.parse(original):emptyLibrary());
      document.media??={};for(const [id,entry] of Object.entries(localMedia))if(!Object.hasOwn(document.media,id)&&entry.file)Object.defineProperty(document.media,id,{value:{...(entry.track as object),path:entry.file},enumerable:true,writable:true,configurable:true});
      document.imports={...document.imports,[source]:true};++document.revision;await writeSharedDocument(directory,document);
    });
  })().catch(error=>{initialized=undefined;throw error;});
  return {
    reloadBeforeRead:true,
    read:async()=>{await initialize();return JSON.stringify((await readSharedDocument(directory)).library);},
    write:async(json,baseline)=>{await initialize();return withLibraryLock(directory,async()=>{
      const edited=JSON.parse(json);if(!validLibrary(edited))throw new Error('Invalid library edit');
      const document=await readSharedDocument(directory);
      document.library=mergeLibraryValue(baseline?JSON.parse(baseline):emptyLibrary(),edited,document.library);++document.revision;
      if(validLibrary(document.library))document.library.history=document.library.history.slice(0,60);
      await writeSharedDocument(directory,document);return JSON.stringify(document.library);
    });},
  };
}
