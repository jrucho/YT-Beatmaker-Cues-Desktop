// Shared wire semantics, mirrored by LibraryStore::merge. No Node dependencies.
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const same=(a:unknown,b:unknown):boolean=>{
  if(a===b)return true;
  if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>same(v,b[i]));
  if(object(a)&&object(b)){const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&same(a[key],b[key]));}
  return false;
};
const id=(value:unknown)=>object(value)&&typeof value.id==='string'?value.id:'';
export function mergeLibraryValue(base:unknown,edited:unknown,latest:unknown):unknown{
  if(same(base,edited))return structuredClone(latest);
  if(Array.isArray(base)&&Array.isArray(edited)&&Array.isArray(latest)){
    const before=new Map(base.filter(id).map(item=>[id(item),item])),now=new Map(latest.filter(id).map(item=>[id(item),item]));
    const changed=new Set(edited.map(id));
    return [...edited.flatMap(item=>{
      const key=id(item);if(!key)return [structuredClone(item)];
      if(before.has(key)&&!now.has(key)&&same(before.get(key),item))return [];
      return [before.has(key)?mergeLibraryValue(before.get(key),item,now.has(key)?now.get(key):before.get(key)):structuredClone(item)];
    }),...latest.filter(item=>id(item)&&!before.has(id(item))&&!changed.has(id(item))).map(item=>structuredClone(item))];
  }
  if(object(base)&&object(edited)&&object(latest)){
    const result=structuredClone(latest);
    for(const key of Object.keys(base))if(!Object.hasOwn(edited,key))delete result[key];
    for(const key of Object.keys(edited))Object.defineProperty(result,key,{value:Object.hasOwn(base,key)?mergeLibraryValue(base[key],edited[key],latest[key]):structuredClone(edited[key]),enumerable:true,configurable:true,writable:true});
    return result;
  }
  return structuredClone(edited);
}
export const emptyLibrary=()=>({favorites:[],playlists:[],history:[]});
export function validLibrary(value:unknown):value is Record<'favorites'|'playlists'|'history',unknown[]>{return object(value)&&['favorites','playlists','history'].every(key=>Array.isArray(value[key]));}
/** One-time migration is additive: existing shared names/fields take precedence. */
export function importLegacyLibrary(latest:unknown,incoming:unknown){
  if(!validLibrary(latest)||!validLibrary(incoming))throw new Error('Invalid legacy library');
  const result=structuredClone(latest);
  for(const key of ['favorites','history','playlists'] as const){
    const byId=new Map(result[key].map(item=>[id(item),item]));
    for(const item of incoming[key]){
      const existing=byId.get(id(item));
      if(!existing){const copy=structuredClone(item);result[key].push(copy);byId.set(id(copy),copy);}
      else if(key==='playlists'&&object(existing)&&object(item)&&Array.isArray(existing.tracks)&&Array.isArray(item.tracks)){
        const tracks=new Set(existing.tracks.map(id));for(const track of item.tracks)if(!tracks.has(id(track))){existing.tracks.push(structuredClone(track));tracks.add(id(track));}
      }
    }
  }
  result.history=result.history.slice(0,60);return result;
}
