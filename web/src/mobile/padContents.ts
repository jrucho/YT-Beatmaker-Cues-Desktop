import type { ControllerMapping } from '../native/controllerMapping';
import { CUE_BANKS, remapCueContents, useCueStore } from './cueStore';
import { recordEdit } from './editHistory';
import { padArrangement, padVisualOrder, readPadOrder, supportsPadOrder, type PadOrder } from './padLayout';
import { remapPadSamples, type PadPermutation } from './padSamples';
import { mediaInvoke } from './mediaEditing';
import { withoutLooperHistory } from './padLoopers';

const ORDER='musike:midi:pad-order',ARRANGEMENTS='musike:pad-arrangements';
const identity=(count:number)=>Array.from({length:count},(_,i)=>i+1);
const inverse=(mappings:PadPermutation[])=>mappings.map(({bank,pads})=>({bank,pads:pads.map((_,i)=>pads.indexOf(i+1)+1)}));
type StorageEdit=Record<string,string|null>;

async function apply(mappings:PadPermutation[],scope:string|null,storage:StorageEdit={}) {
  await withoutLooperHistory(async()=>{
    await remapPadSamples(mappings);
    try{await mediaInvoke('remapLoopers',{mappings,scope});}
    catch(error){await remapPadSamples(inverse(mappings));throw error;}
  });
  remapCueContents(mappings,scope);
  for(const [key,value] of Object.entries(storage)){if(value==null)localStorage.removeItem(key);else localStorage.setItem(key,value);}
  window.dispatchEvent(new Event('plugin-preferences-changed'));
}

async function edit(label:string,mappings:PadPermutation[],scope:string|null,after:StorageEdit={},history=true) {
  const before=Object.fromEntries(Object.keys(after).map(key=>[key,localStorage.getItem(key)]));
  await apply(mappings,scope,after);
  if(history)recordEdit({label,undo:()=>apply(inverse(mappings),scope,before),redo:()=>apply(mappings,scope,after)});
}

function clearedArrangements(preset:string) {
  let saved:Record<string,number[]>={};try{saved=JSON.parse(localStorage.getItem(ARRANGEMENTS)||'{}');}catch{}
  for(const bank of CUE_BANKS)delete saved[`${preset}:${bank}`];
  return JSON.stringify(saved);
}

/** Upgrade old whole-button arrangements without moving any visible audio. */
export async function flattenPadArrangements(mapping:ControllerMapping) {
  if(!supportsPadOrder(mapping.id))return;
  const mappings=CUE_BANKS.map(bank=>({bank,pads:padArrangement(mapping.id,bank,mapping.padToNote.length)}))
    .filter(({pads})=>pads.some((pad,index)=>pad!==index+1));
  if(mappings.length)await edit('upgrade pad contents',mappings,'all',{[ARRANGEMENTS]:clearedArrangements(mapping.id)},false);
}

/** Change labels around position-stable audio, for all banks and saved songs. */
export async function changePadNumbering(mapping:ControllerMapping,order:PadOrder,columns:number) {
  if(!supportsPadOrder(mapping.id)||order===readPadOrder(mapping.id))return;
  const previous=readPadOrder(mapping.id),count=mapping.padToNote.length;
  const mappings=CUE_BANKS.map(bank=>{
    const old=padArrangement(mapping.id,bank,count);
    return {bank,pads:identity(count).map(pad=>{
      const position=padVisualOrder(mapping,pad,order,columns);
      return old[identity(count).findIndex(source=>padVisualOrder(mapping,source,previous,columns)===position)];
    })};
  });
  const saved={linear16:readPadOrder('linear16'),legacy12:readPadOrder('legacy12'),[mapping.id]:order};
  await edit('pad numbering',mappings,'all',{[ORDER]:JSON.stringify(saved),[ARRANGEMENTS]:clearedArrangements(mapping.id)});
}

/** Empty destinations become moves; occupied destinations swap without loss. */
export async function movePadContents(bank:string,from:number,to:number,count:number) {
  if(from===to||from<1||to<1||from>count||to>count)return;
  const pads=identity(count);[pads[from-1],pads[to-1]]=[pads[to-1],pads[from-1]];
  await edit(`move ${bank}${from} → ${bank}${to}`,[{bank,pads}],useCueStore.getState().trackId);
}
