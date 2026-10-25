import {copyFile,mkdir,readFile,rename,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {config} from './config.js';
import type {Track} from './types.js';

interface Media {track:Track;file:string;mime:string}
let writes:Promise<unknown>=Promise.resolve();
const registry=()=>path.join(config.dataDir,'local-media.json');
async function read():Promise<Record<string,Media>>{
  try{return JSON.parse(await readFile(registry(),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {};throw new Error('Local audio index needs recovery; files are retained');}
}
export async function importLocalAudio(input:string):Promise<Track>{
  const extension=path.extname(input).toLowerCase();
  const types:Record<string,string>={'.wav':'audio/wav','.aif':'audio/aiff','.aiff':'audio/aiff','.flac':'audio/flac','.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg'};
  if(!types[extension])throw new Error('Unsupported audio file format');
  const info=await stat(input);if(!info.isFile()||info.size<=0)throw new Error('Audio file is empty or unavailable');
  const id='loc'+randomUUID().replaceAll('-','').slice(0,8);
  const directory=path.join(config.dataDir,'Media');await mkdir(directory,{recursive:true});
  const file=path.join(directory,id+extension);await copyFile(input,file);
  const track:Track={id,title:path.basename(input,extension),artist:'Local audio',duration:0,kind:'song',thumb:'',art:''};
  const job=writes.catch(()=>{}).then(async()=>{const entries=await read();entries[id]={track,file,mime:types[extension]!};
    const tmp=registry()+'.tmp';await writeFile(tmp,JSON.stringify(entries),'utf8');await rename(tmp,registry());});
  writes=job;await job;return track;
}
export async function localAudio(id:string):Promise<Media|null>{
  if(!/^loc[0-9a-f]{8}$/.test(id))return null;
  const entry=(await read())[id];if(!entry)return null;
  try{await stat(entry.file);}catch{throw new Error('Local audio is missing. Its library entry was kept; re-import the file to restore playback.');}
  return entry;
}
