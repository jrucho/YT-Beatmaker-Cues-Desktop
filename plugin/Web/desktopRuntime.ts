// Compiled in place of web/src/beatmaker/runtime.ts for the separate desktop beta.
// The desktop shell drives the existing native player; it never creates a second Web Audio output.
import {beatmakerMedia, cuePosition, selectCurrent, usePlayer} from '../player/player';
import {useCueStore, CUE_BANKS} from '../mobile/cueStore';
import {useUi} from '../stores/ui';
import {cleanBackupState} from '../lib/backupState';

const pad = (key: string) => key === '0' ? 10 : Number(key);
const keyFor = (number: number) => number === 10 ? '0' : String(number);
let installed = false;
let syncing = false;
const notify=()=>window.dispatchEvent(new Event('plugin-desktop-state'));
function mirror() {
  const all = JSON.parse(localStorage.getItem('musike:cues:v1') || '{}');
  for (const [track, banks] of Object.entries(all)) for (const [bank, pads] of Object.entries(banks as object)) {
    localStorage.setItem(`ytbm_cues_${track}:bank:${bank}`, JSON.stringify(Object.fromEntries(Object.entries(pads as object).map(([number, time]) => [keyFor(Number(number)), time]))));
  }
}
export function setEngineBank(bank: string) {
  if (!CUE_BANKS.includes(bank as any)) return;
  const track=useCueStore.getState().trackId;
  if(track){
    const all=JSON.parse(localStorage.getItem('musike:cues:v1')||'{}');
    for(const candidate of CUE_BANKS){const saved=localStorage.getItem(`ytbm_cues_${track}:bank:${candidate}`);if(saved)all[track]={...all[track],[candidate]:Object.fromEntries(Object.entries(JSON.parse(saved)).map(([key,time])=>[pad(key),time]))};}
    localStorage.setItem('musike:cues:v1',JSON.stringify(all));
  }
  useCueStore.getState().setBank(bank);
}
function nativeControls() {
  let panel = document.getElementById('plugin-native-controls');
  if (panel) { panel.remove(); return; }
  panel = document.createElement('section');
  panel.id = 'plugin-native-controls';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Native beta controls');
  Object.assign(panel.style,{position:'fixed',right:'24px',top:'90px',zIndex:'10000',background:'#171717',color:'white',padding:'24px',border:'1px solid #444',borderRadius:'16px',maxWidth:'420px'});
  const heading = document.createElement('h2');heading.textContent='Desktop UI beta · native host audio';panel.append(heading);
  for(const [name, action] of [
    ['IN',()=>usePlayer.getState().setLoopFrom()],['OUT',()=>usePlayer.getState().setLoopTo()],['Loop on/off',()=>usePlayer.getState().toggleLoop()],
    ['Keep pitch',()=>usePlayer.getState().setSpeedMode('speed')],['Varispeed',()=>usePlayer.getState().setSpeedMode('pitch')],
    ['Close',()=>panel?.remove()],
  ] as const) {const button=document.createElement('button');button.textContent=name;button.onclick=action;button.style.margin='8px';panel.append(button);}
  const note=document.createElement('p');note.textContent='Core studio controls use the DAW audio bus. Stems, browser FX, sequencer and VJ are not host-routed in this beta.';panel.append(note);
  document.body.append(panel);
}
const unavailable=()=>{throw Error('This desktop beta does not yet host-route stems, browser FX, sequencer or VJ. Use native cue/loop/speed controls.');};
export async function loadBeatmaker() {
  if(installed)return;installed=true;
  const host = window as any;
  host.__pluginImportDesktopCues=(entries:Record<string,Record<string,number|{time:number}>>)=>{
    const all=JSON.parse(localStorage.getItem('musike:cues:v1')||'{}');
    for(const [key,values] of Object.entries(entries)){
      const match=/^ytbm_cues_([\w-]{11}):bank:([A-J])$/.exec(key);
      if(!match)throw Error('Invalid desktop cue bank');
      all[match[1]]={...all[match[1]],[match[2]]:Object.fromEntries(Object.entries(values).map(([key,value])=>[pad(key),typeof value==='number'?value:value.time]))};
    }
    const text=JSON.stringify(all);cleanBackupState({'musike:cues:v1':text});
    localStorage.setItem('musike:cues:v1',text);
    useCueStore.getState().setBank(useCueStore.getState().bank);
  };
  host.musikeBeatmakerHost={active:true,media:beatmakerMedia,trackId:()=>`youtube:${selectCurrent(usePlayer.getState())?.id||'none'}`,cueId:()=>`${selectCurrent(usePlayer.getState())?.id||'none'}:bank:${useCueStore.getState().bank}`,bankName:()=>useCueStore.getState().bank};
  host.musikeBeatmakerEngine={
    snapshot(){const p=usePlayer.getState();return {cues:Object.fromEntries(Object.entries(useCueStore.getState().cues).map(([number,time])=>[keyFor(Number(number)),time])),pitch:p.speed,ready:true,mediaReady:p.duration>0&&p.status!=='loading',rateMode:p.speedMode==='speed'?'SPEED':'PITCH',rateTarget:'track',rateMin:-75,rateMax:100,saved:true};},
    cue(key:string,overwrite=false){const store=useCueStore.getState();const number=pad(key),time=store.cues[number];if(!store.trackId)return;
      if(time!=null&&!overwrite)usePlayer.getState().cue(time,{bank:store.bank,pad:number});
      else {const track=store.trackId,bank=store.bank;void cuePosition().then(at=>{if(useCueStore.getState().trackId===track)useCueStore.getState().setCue(number,at,bank);}).catch(error=>useUi.getState().toast(error.message,'error'));}},
    remove(key:string){useCueStore.getState().clearCue(pad(key));},
    bank(){const store=useCueStore.getState();if(!store.trackId)return;
      const saved=localStorage.getItem(`ytbm_cues_${store.trackId}:bank:${store.bank}`);if(!saved)return;
      const all=JSON.parse(localStorage.getItem('musike:cues:v1')||'{}');
      all[store.trackId]={...all[store.trackId],[store.bank]:Object.fromEntries(Object.entries(JSON.parse(saved)).map(([key,time])=>[pad(key),time]))};
      localStorage.setItem('musike:cues:v1',JSON.stringify(all));store.setBank(store.bank);},
    random(){const p=usePlayer.getState();if(p.duration>0)for(let number=1;number<=16;number++)useCueStore.getState().setCue(number,Math.random()*p.duration);},
    pitch(value:number){usePlayer.getState().setSpeed(value);},advanced:nativeControls,mapping:()=>useUi.getState().setSettingsOpen(true),
    sequencer:unavailable,sidechain:unavailable,fx:unavailable,vj:unavailable,mini:nativeControls,
  };
  mirror();
  useCueStore.subscribe((state,previous)=>{mirror();notify();if(state.bank!==previous.bank&&!syncing){syncing=true;try{window.dispatchEvent(new CustomEvent('beatmaker-bank',{detail:state.bank}));}finally{syncing=false;}}});
  usePlayer.subscribe(notify);
  window.addEventListener('keydown',event=>{
    if(host.__pluginHosted||!host.musikeBeatmakerHost?.active||event.repeat||(event.target as HTMLElement)?.closest('input,textarea,select,[role=dialog]'))return;
    try {if(event.code==='Space'){event.preventDefault();usePlayer.getState().toggle();}
      else if(/^[0-9]$/.test(event.key)){event.preventDefault();host.musikeBeatmakerEngine.cue(event.key,event.shiftKey);}
      else if(event.key.toLowerCase()==='i')usePlayer.getState().setLoopFrom();else if(event.key.toLowerCase()==='o')usePlayer.getState().setLoopTo();}
    catch(error){useUi.getState().toast((error as Error).message,'error');}
  });
}
