import { api } from '../lib/api';
import type { Library, Playlist, Track } from '../lib/types';
import { useLibrary } from '../stores/library';
import { beginEditGesture, endEditGesture, recordEdit, useEditHistory } from './editHistory';
import { usePadSamples, type PadSample } from './padSamples';
import { usePlayer } from '../player/player';

export const mediaInvoke=<T=any>(name:string,...args:unknown[]):Promise<T>=>(window as any).__pluginInvoke(name,...args);
export const shareLocalAudio=(track:Track)=>mediaInvoke<{shared:boolean;cancelled:boolean}>('shareAudio',{id:track.id});
export async function renameLocalAudio(track:Track,title:string){
  const clean=title.trim();if(!clean||clean.length>200)throw new Error('Enter a song name of 1 to 200 characters');
  const apply=async(value:string)=>{
    const result=await mediaInvoke<{track:Track;previousTitle:string;library:string}>('renameLocalAudio',{id:track.id,title:value});
    useLibrary.setState({...JSON.parse(result.library) as Library,status:'ready'});
    const update=(items:Track[])=>items.map(item=>item.id===track.id?{...item,title:result.track.title}:item);
    usePlayer.setState(state=>({queue:update(state.queue),original:state.original?update(state.original):null}));
    return result;
  };
  const result=await apply(clean);
  if(result.previousTitle!==result.track.title)recordEdit({label:'rename song',undo:async()=>{await apply(result.previousTitle);},redo:async()=>{await apply(result.track.title);}});
}
export async function deleteLocalAudio(id:string){
  const player=usePlayer.getState();if(player.queue[player.index]?.id===id)await player.newEmptyTrack();
  else if(player.queue.some(track=>track.id===id))usePlayer.setState({queue:player.queue.filter(track=>track.id!==id),original:player.original?.filter(track=>track.id!==id)??null,index:player.index-player.queue.slice(0,player.index).filter(track=>track.id===id).length});
  const result=await mediaInvoke<{erased:boolean;retainedForAnotherUse:boolean;library:string}>('eraseLocalAudio',{id});
  for(const key of ['musike:cues:v1','musike:loops','musike:track-playback']){const data=JSON.parse(localStorage.getItem(key)||'{}');delete data[id];localStorage.setItem(key,JSON.stringify(data));}
  // A permanently erased file cannot be restored by a stale library-history snapshot.
  useEditHistory.setState({past:[],future:[]});window.dispatchEvent(new Event('plugin-preferences-changed'));
  return result;
}
if(typeof window!=='undefined')(window as any).__pluginDeleteLocalAudio=deleteLocalAudio;
export interface SamplerSource extends Track { peaks:number[] }
const DESTINATIONS='musike:media:destinations';
let importQueue:Promise<unknown>=Promise.resolve();
/** Every new take/import is immediately discoverable and playable. Serialize
 * saves so overlapping native imports cannot create two Imports playlists. */
export function playImportedAudio(tracks:Track[]):Promise<Playlist> {
  const work=importQueue.catch(()=>{}).then(async()=>{
    if(!tracks.length)throw new Error('No audio to import');
    const library=await api.library(),existing=library.playlists.find(playlist=>playlist.name.toLowerCase()==='imports');
    beginEditGesture('library');
    try{
      const saved=existing?await api.addToPlaylist(existing.id,tracks):await api.createPlaylist('Imports',tracks);
      await useLibrary.getState().load(true);
      usePlayer.getState().playList(saved.tracks,Math.max(0,saved.tracks.findIndex(track=>track.id===tracks[0].id)));
      return saved;
    }finally{endEditGesture();}
  });
  importQueue=work;return work;
}
let recovery:Promise<void>|undefined;
export function recoverImportedAudio(){
  return recovery??=(async()=>{
    await mediaInvoke('recordAudio',{cmd:'recover'});
    const [media,library]=await Promise.all([mediaInvoke<(Track&{sourceTrackId?:string})[]>('localMedia'),api.library()]);
    const imports=library.playlists.find(playlist=>playlist.name.toLowerCase()==='imports');
    const unfiled=media.filter(track=>!track.sourceTrackId&&!imports?.tracks.some(item=>item.id===track.id));
    if(unfiled.length)await playImportedAudio(unfiled);
  })().catch(error=>{recovery=undefined;throw error;});
}
export function lastMediaDestinations(kind='imports'):string[] {
  try{const saved=JSON.parse(localStorage.getItem(DESTINATIONS)||'{}')[kind];return Array.isArray(saved)?saved.filter(id=>typeof id==='string'):[];}catch{return [];}
}
export async function saveMediaDestinations(tracks:Track[],ids:string[],name:string,kind='imports'):Promise<Playlist[]> {
  const result:Playlist[]=[];beginEditGesture('library');
  try{
    if(name.trim())result.push(await api.createPlaylist(name.trim(),tracks));
    for(const id of ids)result.push(await api.addToPlaylist(id,tracks));
    if(!result.length)throw new Error('Choose a playlist or enter a new playlist name');
    await useLibrary.getState().load(true);
    let saved:Record<string,string[]>={};try{saved=JSON.parse(localStorage.getItem(DESTINATIONS)||'{}');}catch{}
    localStorage.setItem(DESTINATIONS,JSON.stringify({...saved,[kind]:result.map(playlist=>playlist.id)}));
    window.dispatchEvent(new Event('plugin-preferences-changed'));return result;
  }finally{endEditGesture();}
}

export interface ChopRequest {sourceId:string;from:number;to:number;slices:number;bank:string;pad:number}
type Assignment={bank:string;pad:number;descriptor:PadSample|null};
export async function assignAudioChops(request:ChopRequest) {
  const before:Assignment[]=Array.from({length:request.slices},(_,index)=>({bank:request.bank,pad:request.pad+index,descriptor:usePadSamples.getState().samples[`${request.bank}:${request.pad+index}`]??null}));
  const pads=await mediaInvoke<PadSample[]>('chopAudio',request);usePadSamples.getState().update(pads);
  const after=before.map(({bank,pad})=>({bank,pad,descriptor:pads.find(sample=>sample.bank===bank&&sample.pad===pad)??null}));
  const apply=async(assignments:typeof before)=>usePadSamples.getState().update(await mediaInvoke('assignPadSamples',assignments));
  recordEdit({label:`chop to ${request.bank}${request.pad}–${request.pad+request.slices-1}`,undo:()=>apply(before),redo:()=>apply(after)});
}
