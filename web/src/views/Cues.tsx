import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowLeftIcon, ArrowsClockwiseIcon, QueueIcon, ArrowsOutSimpleIcon, CheckIcon, EraserIcon, FileAudioIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { Link } from "react-router";
import { Scrubber, Transport } from "../components/Controls";
import { Modal } from "../components/Modal";
import { CueWaveform } from "../components/CueWaveform";
import { FineWaveform } from "../components/FineWaveform";
import { TrackList } from "../components/TrackList";
import { Artwork } from "../components/Artwork";
import { PageHeader } from "../components/Page";
import { formatTime } from "../lib/format";
import { cn } from "../lib/format";
import { useT } from "../i18n";
import { cuePosition, independentTuningAvailable, selectCurrent, usePlayer } from "../player/player";
import { CUE_BANKS, useCueStore } from "../mobile/cueStore";
import { midi, midiAvailable, type MidiDevice, type MidiMessage } from "../native/midi";
import { CONTROLLER_PRESETS, mapControllerMessage, readControllerPreset, saveControllerPreset } from "../native/controllerMapping";
import { padFeedback, releasePointerPadHolds, usePadFeedback } from "../mobile/padFeedback";
import { changePadSample, hasPadSample, padSamplesAvailable, playPadSample, refreshPadSamples, usePadSamples, type PadSample } from "../mobile/padSamples";
import { takeNativePadTouch, useNativePadTouch, type TouchReceipt } from "../mobile/nativePadTouch";
import { iosPadLayoutEnabled, nativePlatform, padArrangement, padVisualOrder, readPadOrder, supportsPadOrder, type PadOrder } from "../mobile/padLayout";
import { changePadNumbering, flattenPadArrangements, movePadContents } from '../mobile/padContents';
import { BANK_PAIRS, nextPairedBank, readBankButtonMode, readMidiVelocity, saveBankButtonMode, saveMidiVelocity, type BankButtonMode } from "../mobile/midiPreferences";
import { toast } from "../stores/ui";
import { useAppearance } from '../stores/appearance';
import { complementaryColor, inkFor } from '../lib/accent';
import { beginEditGesture, endEditGesture } from '../mobile/editHistory';
import { useWarmPadWaveforms } from '../mobile/waveforms';
import { MediaImportPanel, type MediaRequest } from '../components/MediaImportPanel';
import { useRecording, useRecordingStatus } from '../mobile/audioRouting';
import { recordingMidiSuspended } from '../mobile/recordingMidiGuard';
import { CompressorControls } from '../components/CompressorControls';
import { changeLooper, hasPadLooper, pressLooper, releaseLooper, useLooperStatus, usePadLoopers, type PadLoop } from '../mobile/padLoopers';
const EMPTY_LOOPERS:Record<string,PadLoop>={};
let keyboardLooperSequence=0;

const formatSemitones = (st: number) => `${st > 0 ? "+" : ""}${st} st`;

function CueSongs({onSelected}:{onSelected?:()=>void}) {
  const queue = usePlayer(s=>s.queue);
  return <div className="cue-song-browser min-w-0 flex-1">
    <span className="cue-song-caption text-[10px] text-fg-3">Playlist songs · {queue.length}</span>
    <div role="region" aria-label="Playlist songs" className="cue-song-list scroll-area w-full overflow-y-auto rounded-lg text-fg"><TrackList tracks={queue} header={false} showAlbum={false} onSelect={index=>{usePlayer.getState().jumpTo(index);onSelected?.();}}/></div>
  </div>;
}

export default function Cues() {
  const t = useT();
  const track = usePlayer(selectCurrent);
  const loop = usePlayer((s) => s.loop);
  const speed = usePlayer((s) => Math.round(s.speed));
  const speedMode = usePlayer((s) => s.speedMode);
  const tuning = usePlayer((s) => s.tuning);
  const duration = usePlayer((s) => s.duration);
  const cues = useCueStore((s) => s.cues);
  const bank = useCueStore((s) => s.bank);
  const samples = usePadSamples(s => s.samples);
  const sampleSupport = padSamplesAvailable();
  const [sampleEdit, setSampleEdit] = useState(false);
  const [looperEdit,setLooperEdit]=useState(false);
  const [samplePad, setSamplePad] = useState<{bank:string;pad:number}|null>(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [mediaRequest,setMediaRequest]=useState<MediaRequest|null>(null);
  const nextSlot = useCueStore.getState().nextSlot();
  const nextPad = nextSlot?.pad;
  const [mapping, setMapping] = useState(readControllerPreset);
  const padLayoutEnabled = iosPadLayoutEnabled();
  const accent=useAppearance(s=>s.accent),looperColor=useAppearance(s=>s.looperColor);
  const loopColor=looperColor==='complementary'?complementaryColor(accent):looperColor;
  const loopState=usePadLoopers(),loopers=loopState.song===(track?.id??'@empty')?loopState.pads:EMPTY_LOOPERS;
  const loopKeys=Object.keys(loopers).sort().join('|'),nativeLoopLayout=useMemo(()=>Object.fromEntries(loopKeys?loopKeys.split('|').map(key=>[key,true]):[]),[loopKeys,track?.id]);
  useLooperStatus(padLayoutEnabled);
  const hasRecording=useRecording(state=>state.hasTake);
  useRecordingStatus(padLayoutEnabled);
  const [padOrder, setPadOrder] = useState(() => readPadOrder(readControllerPreset().id));
  const [heldPads, setHeldPads] = useState<Record<string, number>>({});
  const feedback = usePadFeedback();
  const [velocityEnabled, setVelocityEnabled] = useState(readMidiVelocity);
  const [bankButtonMode, setBankButtonMode] = useState(readBankButtonMode);
  const [fineEdit,setFineEdit]=useState(false),[finePad,setFinePad]=useState(1);
  const [rearranging,setRearranging]=useState(false),[dragPad,setDragPad]=useState<number|null>(null),[dropPad,setDropPad]=useState<number|null>(null);
  const [arrangementRevision,setArrangementRevision]=useState(0);
  const [contentBusy,setContentBusy]=useState(false),contentWorking=useRef(false);
  const arrangement=padArrangement(mapping.id,bank,mapping.padToNote.length);
  const arrangeActive=useRef(false),dragging=useRef<number|null>(null),dropTarget=useRef<number|null>(null);
  const activePointers=useRef(new Set<number>());
  const pointerClicks=useRef(new Map<number,{pointer:number;at:number;released:boolean}[]>());
  const arrangeCandidate=useRef<{timer:number;pad:number;pointer:number;x:number;y:number}|null>(null);
  const deferredMarks=useRef(new Map<number,{at:Promise<number|null>;ready:boolean;align:boolean}>());
  const [overwrite, setOverwrite] = useState(false);
  const [midiOpen, setMidiOpen] = useState(false);
  const [queuePreference,setQueuePreference]=useState<boolean|null>(null);
  const [wide,setWide]=useState(()=>window.innerWidth>=960&&window.innerHeight>=500);
  const [short,setShort]=useState(()=>window.innerHeight<=360);
  const queueOpen=queuePreference??wide;
  useEffect(()=>{const update=()=>{setWide(window.innerWidth>=960&&window.innerHeight>=500);setShort(window.innerHeight<=360);};window.addEventListener('resize',update);return()=>window.removeEventListener('resize',update);},[]);
  const [devices, setDevices] = useState<MidiDevice[]>([]);
  /** Legacy hold-to-mark timers; preview performance holds leave saved cues intact. */
  const presses = useRef(new Map<number, number>());
  const faderTap = useRef({ started: 0, startX: 0, startY: 0, previous: 0, previousX: 0, previousY: 0 });
  useWarmPadWaveforms(track,duration,bank,cues,samples,mapping.padToNote.length,padLayoutEnabled);

  useEffect(()=>{
    const preventSelection=(event:Event)=>{
      if(event.target instanceof Element&&event.target.closest('.cue-workspace,.cue-workspace-active')&&!event.target.closest('input,textarea,[contenteditable="true"]'))event.preventDefault();
    };
    window.getSelection()?.removeAllRanges();document.addEventListener('selectstart',preventSelection);
    return()=>document.removeEventListener('selectstart',preventSelection);
  },[]);

  useNativePadTouch({ trackId: track?.id ?? null, bank,
    cues: overwrite&&!fineEdit ? {} : cues, samples,loopers:nativeLoopLayout, padCount: mapping.padToNote.length,
    disabled: sampleEdit || looperEdit || !!samplePad || !!mediaRequest || sampleBusy || contentBusy || midiOpen || rearranging || (queueOpen && !wide) });
  useEffect(()=>{if(sampleEdit||fineEdit)setLooperEdit(false);},[sampleEdit,fineEdit]);

  const editContents=async(work:()=>Promise<void>)=>{
    if(contentWorking.current)return;
    contentWorking.current=true;setContentBusy(true);
    try{await work();}catch(error){toast((error as Error).message,'error');}
    finally{contentWorking.current=false;setContentBusy(false);}
  };
  useEffect(()=>{
    if(padLayoutEnabled&&supportsPadOrder(mapping.id)&&CUE_BANKS.some(letter=>padArrangement(mapping.id,letter,mapping.padToNote.length).some((pad,index)=>pad!==index+1)))
      void editContents(()=>flattenPadArrangements(mapping));
  },[mapping.id,samples]);

  const cancelArrangeCandidate=()=>{if(arrangeCandidate.current)clearTimeout(arrangeCandidate.current.timer);arrangeCandidate.current=null;};
  const finishArrange=()=>{arrangeActive.current=false;setRearranging(false);dragging.current=null;dropTarget.current=null;setDragPad(null);setDropPad(null);};
  useEffect(()=>{
    const refresh=()=>{setArrangementRevision(value=>value+1);setPadOrder(readPadOrder(readControllerPreset().id));setVelocityEnabled(readMidiVelocity());setBankButtonMode(readBankButtonMode());};
    const keyActivity=(event:KeyboardEvent)=>{if(/^(Digit|Numpad)/.test(event.code))cancelArrangeCandidate();};
    const padActivity=(event:Event)=>{const value=(event as CustomEvent).detail,candidate=arrangeCandidate.current;
      if(candidate&&(value?.phase==='pressed'||value?.phase==='triggered'&&value.pad!==candidate.pad))cancelArrangeCandidate();};
    window.addEventListener('plugin-preferences-changed',refresh);window.addEventListener('beatmaker-pad',padActivity);
    window.addEventListener('keydown',keyActivity,true);
    return()=>{window.removeEventListener('plugin-preferences-changed',refresh);window.removeEventListener('beatmaker-pad',padActivity);window.removeEventListener('keydown',keyActivity,true);cancelArrangeCandidate();};
  },[]);
  useEffect(()=>{finishArrange();cancelArrangeCandidate();activePointers.current.clear();deferredMarks.current.clear();releasePointerPadHolds();setFinePad(pad=>Math.min(pad,mapping.padToNote.length));},[track?.id,bank,mapping.id,fineEdit]);
  useEffect(()=>{
    if(!fineEdit)return;
    const selectMidiPad=(event:Event)=>{const data=(event as CustomEvent).detail;
      if(data?.phase==='triggered'&&data.source==='native'&&data.midiTriggered!==false&&data.lastMidiTriggered!==false&&Number.isInteger(data.pad)&&data.pad>=1&&data.pad<=mapping.padToNote.length)setFinePad(data.pad);
    };
    window.addEventListener('beatmaker-pad',selectMidiPad);return()=>window.removeEventListener('beatmaker-pad',selectMidiPad);
  },[fineEdit,mapping.padToNote.length]);

  useEffect(() => {
    useCueStore.getState().setTrack(track?.id ?? null);
  }, [track?.id]);

  useEffect(() => {
    const refresh = () => { void refreshPadSamples().catch(error => toast(error.message, 'error')); };
    const update = (event: Event) => usePadSamples.getState().update((event as CustomEvent<PadSample[]>).detail);
    refresh();window.addEventListener('plugin-pad-samples',update);window.addEventListener('pageshow',refresh);document.addEventListener('visibilitychange',refresh);
    return () => {window.removeEventListener('plugin-pad-samples',update);window.removeEventListener('pageshow',refresh);document.removeEventListener('visibilitychange',refresh);};
  }, []);

  const trigger = useCallback((pad: number,gestureId?:string) => {
    const bank=useCueStore.getState().bank;
    if(hasPadLooper(bank,pad,useCueStore.getState().trackId)){void pressLooper(bank,pad,gestureId).catch(error=>toast(error.message,'error'));return;}
    if(hasPadSample(bank,pad)){void playPadSample(bank,pad).catch(error=>toast(error.message,'error'));return;}
    const time = useCueStore.getState().cues[pad];
    if (time == null) return;
    usePlayer.getState().cue(time, { bank: useCueStore.getState().bank, pad });
  }, []);

  const mark = useCallback((pad: number | null, at = cuePosition().catch(() => null), alignTransport = true) => {
    const player = usePlayer.getState();
    if (!player.queue[player.index]) return;
    const { trackId, bank } = useCueStore.getState();
    void at.then((position) => {
      const store = useCueStore.getState();
      if (store.trackId !== trackId || store.bank !== bank || position == null || !Number.isFinite(position)) return;
      if(alignTransport)usePlayer.setState({position});
      if (pad == null) store.setNextCue(position);
      else store.setCue(pad, position);
    }).catch(() => {});
  }, []);

  useEffect(()=>{
    const heldLoopers=new Map<string,{bank:string;pad:number;gestureId:string}>();
    const keyId=(event:KeyboardEvent)=>{
      if(event.code)return event.code;
      const digit=/^[0-9]$/.test(event.key)?event.key:')!@#$%^&*('.indexOf(event.key);
      return digit!==-1&&event.key.length===1?`Digit${digit}`:null;
    };
    const releaseKey=(key:string)=>{
      const held=heldLoopers.get(key);if(!held)return;
      heldLoopers.delete(key);void releaseLooper(held.bank,held.pad,held.gestureId).catch(()=>{});
    };
    const releaseKeys=()=>{for(const key of heldLoopers.keys())releaseKey(key);};
    const visibility=()=>{if(document.hidden)releaseKeys();};
    const focus=(event:FocusEvent)=>{const target=event.target;if(target instanceof HTMLElement&&(target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)||!!target.closest('[role="dialog"]')))releaseKeys();};
    const onKeyUp=(event:KeyboardEvent)=>{
      const key=keyId(event);if(key===null||!heldLoopers.has(key))return;
      // Release belongs to the original physical key/pad, even after Shift,
      // focus or a dialog has changed. It must not toggle recording/playback.
      event.preventDefault();event.stopImmediatePropagation();releaseKey(key);
    };
    const onKey=(event:KeyboardEvent)=>{
      const target=event.target;
      if(event.repeat||event.altKey||target instanceof HTMLElement&&(target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)||!!target.closest('[role="dialog"]'))||document.querySelector('[role="dialog"]'))return;
      const digit=/^(?:Digit|Numpad)([0-9])$/.exec(event.code)?.[1]??(/^[0-9]$/.test(event.key)?event.key:null);
      if(digit===null)return;
      const number=Number(digit),pad=event.shiftKey&&number>=1&&number<=6?number+10:number===0?10:number;
      const store=useCueStore.getState(),looper=hasPadLooper(store.bank,pad,store.trackId);
      if(pad>mapping.padToNote.length||(!looperEdit&&!usePlayer.getState().queue.length&&!hasPadSample(store.bank,pad)&&!looper))return;
      event.preventDefault();event.stopImmediatePropagation();
      if(looperEdit){void editContents(()=>changeLooper(useCueStore.getState().bank,pad,!hasPadLooper(useCueStore.getState().bank,pad,useCueStore.getState().trackId)));return;}
      if(fineEdit)setFinePad(pad);
      if(looper){
        const key=keyId(event);if(key===null||heldLoopers.has(key))return;
        const gestureId=`keyboard:${performance.timeOrigin}:${++keyboardLooperSequence}`;
        heldLoopers.set(key,{bank:store.bank,pad,gestureId});trigger(pad,gestureId);return;
      }
      if(fineEdit){trigger(pad);return;}
      if(hasPadSample(useCueStore.getState().bank,pad))trigger(pad);
      else if(event.metaKey||event.ctrlKey||overwrite||useCueStore.getState().cues[pad]==null)mark(pad);
      else{padFeedback({bank:useCueStore.getState().bank,pad,phase:'triggered'});trigger(pad);}
    };
    window.addEventListener('keydown',onKey,true);
    window.addEventListener('keyup',onKeyUp,true);window.addEventListener('blur',releaseKeys);window.addEventListener('pagehide',releaseKeys);
    document.addEventListener('visibilitychange',visibility);document.addEventListener('focusin',focus,true);
    return()=>{releaseKeys();window.removeEventListener('keydown',onKey,true);window.removeEventListener('keyup',onKeyUp,true);window.removeEventListener('blur',releaseKeys);window.removeEventListener('pagehide',releaseKeys);document.removeEventListener('visibilitychange',visibility);document.removeEventListener('focusin',focus,true);};
  },[mark,trigger,mapping.id,mapping.padToNote.length,overwrite,fineEdit,looperEdit,bank,track?.id]);

  useEffect(() => {
    if (!midiAvailable) return;
    let disposed = false;
    let handle: { remove: () => Promise<void> } | undefined;
    const onMessage = (message: MidiMessage) => {
      const target = mapControllerMessage(message, mapping, useCueStore.getState().bank);
      if (!target) return;
      if(target.pressed&&recordingMidiSuspended())return;
      padFeedback({ ...target, phase: target.pressed ? "pressed" : "released", source:'midi' });
      const key = `${target.bank}:${target.pad}`;
      setHeldPads(previous => {
        const next = { ...previous };
        if (target.pressed) next[key] = target.velocity;
        else delete next[key];
        return next;
      });
      if (!target.pressed) return;
      const store = useCueStore.getState();
      store.setBank(target.bank);
      if(fineEdit){setFinePad(target.pad);trigger(target.pad);return;}
      if(hasPadLooper(target.bank,target.pad,store.trackId)){trigger(target.pad);return;}
      if(hasPadSample(target.bank,target.pad)){trigger(target.pad);return;}
      const time = useCueStore.getState().cues[target.pad];
      if (time != null && !overwrite) { trigger(target.pad); return; }
      const trackId = store.trackId;
      void cuePosition().then(position => {
        if (!recordingMidiSuspended()&&useCueStore.getState().trackId === trackId) {
          useCueStore.getState().setCue(target.pad, position, target.bank);
        }
      }).catch(() => {});
    };
    const connect = async () => {
      const result = await midi.list().catch(() => ({ devices: [] }));
      if (disposed) return;
      setDevices(result.devices);
      handle = await midi.addListener("message", onMessage).catch(() => undefined);
      if (disposed) void handle?.remove();
    };
    void connect();
    return () => {
      disposed = true;
      void handle?.remove();
    };
  }, [trigger, mapping, overwrite, fineEdit]);

  const refreshMidi = () => {
    void midi.refresh().then(() => midi.list()).then((result) => setDevices(result.devices)).catch(() => setDevices([]));
  };

  /**
   * Pads play on press, not on release: waiting for the finger to lift adds the whole tap to the delay.
   * Preview holds preserve existing cues; empty pads and explicit Overwrite still mark.
   */
  const padPlayback = (pad: number, eventTime: number, pointerType?: string) => {
    const looper=hasPadLooper(bank,pad,useCueStore.getState().trackId),sample = !looper&&hasPadSample(bank,pad);
    const touch = looper||sample || cues[pad] != null && (!overwrite||fineEdit) ? takeNativePadTouch(bank, pad, sample, looper?0:cues[pad], eventTime, pointerType,looper) : undefined;
    const trackId=useCueStore.getState().trackId,atDown=cues[pad];
    const playWith = (receipt?: TouchReceipt) => {
      const current=useCueStore.getState();
      if(current.trackId!==trackId||current.bank!==bank||hasPadLooper(bank,pad,current.trackId)!==looper||!looper&&hasPadSample(bank,pad)!==sample||!looper&&!sample&&current.cues[pad]!==atDown)return;
      if(receipt)receipt.reconcile(() => trigger(pad));else trigger(pad);
    };
    const play = () => {if(touch instanceof Promise)void touch.then(playWith).catch(error=>toast(error.message,'error'));else playWith(touch);};
    return {sample,looper,touch,play};
  };
  const down = (pad: number, eventTime: number, pointerType?: string) => {
    padFeedback({ bank: useCueStore.getState().bank, pad, phase: "pressed", source:'pointer' });
    const previous = presses.current.get(pad);
    if (previous != null) window.clearTimeout(previous);
    presses.current.delete(pad);
    // Open management on release so finger-up cannot dismiss the new dialog.
    if(sampleEdit||looperEdit)return;
    const {sample,looper,touch,play}=padPlayback(pad,eventTime,pointerType);
    if(sample||looper){play();return;}
    if (cues[pad] == null || overwrite) {
      if(padLayoutEnabled&&supportsPadOrder(mapping.id)){deferredMarks.current.set(pad,{at:cuePosition().catch(()=>null),ready:true,align:true});return;}
      mark(pad);
      return;
    }
    if(padLayoutEnabled){play();return;} // A performance hold must not move an existing cue.
    // Capture before triggering the saved cue: holding to overwrite must mark where the finger went down,
    // not the old cue plus the long-press delay.
    const at = touch instanceof Promise ? touch.then(receipt=>receipt?.position??cuePosition()).catch(()=>null)
      : touch ? Promise.resolve(touch.position) : cuePosition().catch(() => null);
    if(padLayoutEnabled&&supportsPadOrder(mapping.id))deferredMarks.current.set(pad,{at,ready:false,align:false});
    presses.current.set(pad, window.setTimeout(() => {
      presses.current.delete(pad);
      const deferred=deferredMarks.current.get(pad);
      if(deferred)deferred.ready=true;else mark(pad, at, false);
    }, 600));
    play();
  };

  const up = (pad?: number, cancelled=false) => {
    if (pad) padFeedback({ bank: useCueStore.getState().bank, pad, phase: "released", source:'pointer' });
    if (pad) {
      const timer = presses.current.get(pad);
      if (timer != null) window.clearTimeout(timer);
      presses.current.delete(pad);
      const deferred=deferredMarks.current.get(pad);deferredMarks.current.delete(pad);
      if(deferred?.ready&&!cancelled&&!arrangeActive.current)mark(pad,deferred.at,deferred.align);
    }
  };

  useEffect(() => () => {
    for (const timer of presses.current.values()) window.clearTimeout(timer);
    presses.current.clear();
    releasePointerPadHolds();
  }, [track?.id, bank]);

  const hit = (pad: number) => {
    if(looperEdit){void editContents(()=>changeLooper(bank,pad,!hasPadLooper(bank,pad,useCueStore.getState().trackId)));return;}
    if(fineEdit){setFinePad(pad);trigger(pad);return;}
    if(rearranging)return;
    if(sampleEdit){setSamplePad({bank,pad});return;}
    if (hasPadSample(bank,pad)||cues[pad] != null && !overwrite) trigger(pad);
    else mark(pad);
  };

  const padDown=(pad:number,event:React.PointerEvent<HTMLButtonElement>)=>{
    if(contentWorking.current)return;
    if(padLayoutEnabled){const now=performance.now(),pending=(pointerClicks.current.get(pad)||[]).filter(value=>now-value.at<60000);if(pending.some(value=>value.pointer===event.pointerId&&!value.released))return;pending.push({pointer:event.pointerId,at:now,released:false});pointerClicks.current.set(pad,pending.slice(-256));}
    if(fineEdit){setFinePad(pad);padFeedback({bank,pad,phase:'pressed',source:'pointer'});padPlayback(pad,event.timeStamp,event.pointerType).play();return;}
    if(arrangeActive.current){dragging.current=pad;dropTarget.current=pad;setDragPad(pad);setDropPad(pad);return;}
    const single=activePointers.current.size===0&&feedback.pressed.size===0;cancelArrangeCandidate();activePointers.current.add(event.pointerId);
    down(pad,event.timeStamp,event.pointerType);
    if(!padLayoutEnabled||!supportsPadOrder(mapping.id)||!single||sampleEdit||looperEdit||hasPadLooper(bank,pad,track?.id??null)||sampleBusy||samplePad)return;
    const pointer=event.pointerId,x=event.clientX,y=event.clientY;
    const timer=window.setTimeout(()=>{
      if(activePointers.current.size!==1||!activePointers.current.has(pointer))return;
      deferredMarks.current.delete(pad);const markTimer=presses.current.get(pad);if(markTimer!=null)clearTimeout(markTimer);presses.current.delete(pad);
      arrangeActive.current=true;setRearranging(true);dragging.current=pad;dropTarget.current=pad;setDragPad(pad);setDropPad(pad);arrangeCandidate.current=null;
    },3000);
    arrangeCandidate.current={timer,pad,pointer,x,y};
  };
  const padMove=(event:React.PointerEvent<HTMLButtonElement>)=>{
    const candidate=arrangeCandidate.current;
    if(candidate&&Math.hypot(event.clientX-candidate.x,event.clientY-candidate.y)>12)cancelArrangeCandidate();
    if(!arrangeActive.current||dragging.current==null)return;
    const target=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('.cue-pad[data-pad-number]');
    const pad=target?Number(target.dataset.padNumber):null;dropTarget.current=pad;setDropPad(pad);
  };
  const padUp=(pad:number,event:React.PointerEvent<HTMLButtonElement>,cancelled=false)=>{
    if(!looperEdit&&hasPadLooper(bank,pad,track?.id??null))void releaseLooper(bank,pad).catch(()=>{});
    let tracked=!padLayoutEnabled;
    if(padLayoutEnabled){const pending=pointerClicks.current.get(pad),press=pending?.slice().reverse().find(value=>value.pointer===event.pointerId&&!value.released);tracked=!!press;if(press){press.released=true;press.at=performance.now();}}
    if(looperEdit&&tracked&&!cancelled)hit(pad);
    cancelArrangeCandidate();activePointers.current.delete(event.pointerId);
    if(arrangeActive.current){
      const from=dragging.current,to=dropTarget.current;
       if(!cancelled&&from!=null&&to!=null&&from!==to)void editContents(()=>movePadContents(bank,from,to,mapping.padToNote.length));
      dragging.current=null;dropTarget.current=null;setDragPad(null);setDropPad(null);up(pad,true);return;
    }
    up(pad,cancelled);
  };
  const fineButton=<button type="button" aria-label="Fine waveform edit" aria-pressed={fineEdit} title="Expand waveform" className={cn('cue-fine-toggle grid size-8 shrink-0 place-items-center rounded-full',fineEdit?'bg-accent text-accent-ink':'bg-surface-3 text-fg-2')} onClick={()=>{setFineEdit(on=>!on);if(!fineEdit){setSampleEdit(false);setFinePad(feedback.active?Number(feedback.active.slice(2))||1:1);}}}><ArrowsOutSimpleIcon size={16}/></button>;
  const arrangeButtons=<span className="flex items-center gap-1"><button type="button" disabled={contentBusy} aria-label="Finish rearranging pads" className="cue-arrange-done flex h-8 items-center gap-1 rounded-full bg-accent px-2 text-xs text-accent-ink" onClick={finishArrange}><CheckIcon size={15}/>Done</button></span>;

  return (
    <div className="cue-workspace pb-8" style={{'--cue-looper-color':loopColor,'--cue-looper-ink':inkFor(loopColor)} as CSSProperties} onContextMenu={event=>{if(!(event.target instanceof Element&&event.target.closest('input,textarea,[contenteditable="true"]')))event.preventDefault();}}>
      <PageHeader alwaysSettings title={t.cues.title} actions={<>
        {short&&padLayoutEnabled&&<span className="cue-header-fine hidden">{rearranging?arrangeButtons:fineButton}</span>}
        {short&&<button type="button" className="cue-header-mark hidden rounded-full bg-accent px-2 text-xs font-semibold text-accent-ink" disabled={nextPad==null} aria-label={nextPad==null?t.cues.bankFull:t.cues.markNext(nextPad)} onPointerDown={event=>{if(event.button===0)mark(null);}} onClick={event=>{if(event.detail===0)mark(null);}}>{nextSlot?`${t.cues.mark} ${nextSlot.bank}${nextSlot.pad}`:t.cues.mark}</button>}
        <button type="button" className="cue-queue-toggle inline-flex h-8 items-center gap-1 rounded-full bg-surface-2 px-2.5 text-xs" aria-label="Toggle playlist" aria-expanded={queueOpen} onClick={()=>setQueuePreference(!queueOpen)}><QueueIcon size={17}/><span className="max-sm:hidden">Playlist</span></button>
        {!padLayoutEnabled&&<Link to="/library" className="cue-library-back inline-flex h-8 items-center gap-1 rounded-full bg-surface-2 px-2.5 text-xs font-medium" aria-label={`${t.common.back}: ${t.nav.library}`}><ArrowLeftIcon size={14}/>{t.nav.library}</Link>}
      </>} />

      <div className="cue-body px-4">
        <p className="cue-intro max-w-[46ch] text-sm text-fg-2">{t.cues.subtitle}</p>
        {track || sampleSupport ? (
          <>
            <div className="cue-transport mt-4 flex items-center gap-3 rounded-[16px] bg-surface-2 p-3">
              <Artwork src={track?.thumb} className="cue-artwork size-12 rounded-[10px]" />
              <div className="cue-track-label min-w-0" title={track?`${track.title} · ${track.artist}`:padLayoutEnabled?'Empty track':'Sample pads'}><p className="truncate text-sm font-medium">{track?.title??(padLayoutEnabled?'Empty track':'Sample pads')}</p><p className="truncate text-xs text-fg-2">{track?.artist??(padLayoutEnabled?'Record audio or play sample pads':'Load samples, or choose a song for cues')}</p></div>
              <div className={padLayoutEnabled?'cue-mark-actions':undefined}>
              {padLayoutEnabled&&!rearranging&&fineButton}
              <button
                type="button"
                disabled={nextPad == null}
                aria-label={nextPad == null ? t.cues.bankFull : t.cues.markNext(nextPad)}
                onPointerDown={(e) => { if (e.button === 0) mark(null); }}
                onClick={(e) => { if (e.detail === 0) mark(null); }}
                className="cue-mark h-9 shrink-0 touch-manipulation rounded-full bg-accent px-3 text-xs font-semibold text-accent-ink active:scale-95 disabled:opacity-40"
              >
                {nextPad == null ? t.cues.bankFull : `${t.cues.mark} ${nextSlot?.bank}${nextPad}`}
              </button>
              {padLayoutEnabled&&rearranging&&arrangeButtons}
              </div>
            </div>

            {fineEdit?(loopers[`${bank}:${finePad}`]?<p className="cue-waveform flex items-center justify-center px-3 text-xs text-fg-3">Event looper · select a cue or sample to edit its waveform</p>:<FineWaveform key={`${track?.id}:${bank}:${finePad}`} pad={finePad}/>):<CueWaveform padCount={mapping.padToNote.length}/>}
            <div className="cue-stage" data-queue-open={queueOpen}>
            {queueOpen&&<><button type="button" className="cue-queue-backdrop hidden" aria-label="Close playlist" onClick={()=>setQueuePreference(false)}/><aside className="cue-queue-panel"><button type="button" className="cue-queue-close hidden" aria-label="Close playlist panel" onClick={()=>setQueuePreference(false)}>×</button><CueSongs onSelected={wide?undefined:()=>setQueuePreference(false)}/></aside></>}
            <div className="cue-performance">
            <div className="cue-pads-panel">
            <div className="cue-bankbar mt-5 flex items-center gap-2">
              <span className="text-xs font-medium tracking-wide text-fg-3 uppercase">{t.cues.bank}</span>
              <div data-bank-mode={padLayoutEnabled?bankButtonMode:'separate'} className="cue-bank-buttons no-scrollbar flex flex-1 gap-1.5 overflow-x-auto">
                {padLayoutEnabled&&bankButtonMode==='paired'?BANK_PAIRS.map(([first,second])=>{
                  const active=bank===first||bank===second;
                  return <button key={first} type="button" aria-label={`Bank ${first}/${second}${active?`, selected ${bank}`:''}`} aria-pressed={active} className={cn('cue-bank-pair grid h-8 shrink-0 place-items-center rounded-full text-xs font-semibold transition-colors',active?'bg-accent text-accent-ink':'bg-surface-2 text-fg-2',bank===second&&'cue-bank-second-active')} onClick={()=>useCueStore.getState().setBank(nextPairedBank(bank,first,second))}>
                    <span><span className={bank===first?'cue-bank-selected-letter':undefined}>{first}</span><span aria-hidden="true">/</span><span className={bank===second?'cue-bank-selected-letter':undefined}>{second}</span></span>
                  </button>;
                }):CUE_BANKS.map((letter) => (
                  <button
                    key={letter}
                    type="button"
                    onClick={() => useCueStore.getState().setBank(letter)}
                    className={cn(
                      "grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold transition-colors",
                      bank === letter ? "bg-accent text-accent-ink" : "bg-surface-2 text-fg-2 active:bg-surface-3",
                    )}
                  >
                    {letter}
                  </button>
                ))}
              </div>
            </div>

            <div className="cue-overwrite-row mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-fg-3">{t.cues.markHint}</p>
              <select aria-label="Cue bank" className="cue-bank-compact hidden rounded-full bg-surface-2 text-xs" value={bank} onChange={event=>{useCueStore.getState().setBank(event.target.value as typeof bank);event.currentTarget.blur();}}>{CUE_BANKS.map(bank=><option key={bank} value={bank}>{bank}</option>)}</select>
              <select aria-label="Pad layout preset" title={mapping.label} value={mapping.id} className="cue-preset rounded-full bg-surface-2 px-2 py-1 text-xs" onChange={event=>{
                const preset=CONTROLLER_PRESETS.find(preset=>preset.id===event.target.value)!;
                saveControllerPreset(preset.id);setMapping(preset);setPadOrder(readPadOrder(preset.id));setHeldPads({});event.currentTarget.blur();
              }}>{CONTROLLER_PRESETS.map(preset=><option key={preset.id} value={preset.id}>{preset.id==='linear16'?'16 pads':preset.id==='legacy12'?'12 pads':preset.id==='sp404mkii-b'?'SP-404 B':'SP-404 A'}</option>)}</select>
              <button type="button" aria-label={`${t.cues.midi} settings`} title={`${t.cues.midi} · ${mapping.label}`} className="cue-midi-settings shrink-0 rounded-full bg-surface-2 px-2 py-1.5 text-[11px] font-medium" onClick={()=>setMidiOpen(true)}>{t.cues.midi}</button>
               {sampleSupport&&<button type="button" aria-label="Manage pad samples" title={sampleEdit?'Finish sample editing':'Load or remove a sample: enable, then tap a pad'} aria-pressed={sampleEdit} className={cn('cue-sample-edit grid size-7 shrink-0 place-items-center rounded-full',sampleEdit?'bg-accent text-accent-ink':'bg-surface-2 text-fg-2')} onClick={()=>{setFineEdit(false);setSampleEdit(!sampleEdit);}}><svg data-icon="drum" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><ellipse cx="12" cy="10" rx="9" ry="3"/><path d="M3 10v8c0 1.7 4 3 9 3s9-1.3 9-3v-8M5 12l3 8 4-7 4 7 3-8M5 2l7 5M19 2l-5 5"/></svg></button>}
               {padLayoutEnabled&&<button type="button" aria-label="Import songs and chop audio" title={hasRecording?'Recording · finish take':'Import songs and chop audio'} data-recording={hasRecording} className="cue-song-import relative grid size-7 shrink-0 place-items-center rounded-full bg-surface-2 text-fg-2" onClick={()=>setMediaRequest(hasRecording?{record:true}:{})}><FileAudioIcon size={16}/>{hasRecording&&<span className="absolute right-0 top-0 size-2 rounded-full bg-danger"/>}</button>}
               {padLayoutEnabled&&<CompressorControls/>}
               {padLayoutEnabled&&<button type="button" aria-label="Assign looper pads" aria-pressed={looperEdit} title="Assign/remove event-loop pads" className={cn('cue-looper-edit grid size-7 shrink-0 place-items-center rounded-full',looperEdit?'bg-accent text-accent-ink':'bg-surface-2 text-fg-2')} onClick={()=>{setSampleEdit(false);setFineEdit(false);setLooperEdit(value=>!value);}}><ArrowsClockwiseIcon size={16}/></button>}
                <button type="button" aria-label={t.cues.clearBank} title={t.cues.clearBank} onClick={()=>useCueStore.getState().clearBank()} className={cn('cue-clear-bank shrink-0 rounded-full bg-surface-2 text-[11px] text-fg-2 active:bg-surface-3',padLayoutEnabled?'cue-toolbar-icon grid size-7 place-items-center':'px-2.5 py-1.5')}>{padLayoutEnabled?<EraserIcon size={16} aria-hidden="true"/>:t.cues.clearBank}</button>
               <button
                 type="button"
                 aria-label={t.cues.overwrite}
                 title={t.cues.overwrite}
                aria-pressed={overwrite}
                onClick={() => setOverwrite((on) => !on)}
                className={cn(
                  "cue-overwrite-toggle shrink-0 rounded-full text-[11px] font-semibold transition-colors",
                  padLayoutEnabled ? "cue-toolbar-icon grid size-7 place-items-center" : "px-3 py-1.5",
                  overwrite ? "bg-accent text-accent-ink" : "bg-surface-2 text-fg-2",
                )}
              >
                  {padLayoutEnabled?<PencilSimpleIcon size={16} aria-hidden="true"/>:t.cues.overwrite}
               </button>
               {padLayoutEnabled&&<button type="button" aria-label="Open audio recorder" aria-pressed={hasRecording} title={hasRecording?'Recording · open recorder':'Record audio'} data-recording={hasRecording} className={cn('cue-record grid size-7 shrink-0 place-items-center rounded-full text-danger',hasRecording?'bg-danger/15 ring-1 ring-danger/50':'bg-surface-2')} onClick={()=>setMediaRequest({record:true})}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="currentColor"/></svg></button>}
            </div>

            <div data-arranging={rearranging} data-arrangement-revision={arrangementRevision} data-pad-count={mapping.padToNote.length} data-pad-order={padLayoutEnabled&&supportsPadOrder(mapping.id)?padOrder:'top-left'} className={cn("cue-pad-grid mt-3 grid gap-2", mapping.padToNote.length === 12 ? "grid-cols-3" : "grid-cols-4")}>
              {Array.from({ length: mapping.padToNote.length }, (_, i) => i + 1).map((pad) => {
                const time = cues[pad];
                const loopPad=loopers[`${bank}:${pad}`],sample=loopPad?undefined:samples[`${bank}:${pad}`];
                return (
                  <div key={pad} className="relative" style={padLayoutEnabled?{
                    order:'var(--cue-pad-display-order)',
                    '--cue-pad-standard-order':padVisualOrder(mapping,arrangement.indexOf(pad)+1,padOrder),
                    '--cue-pad-compact-order':padVisualOrder(mapping,arrangement.indexOf(pad)+1,padOrder,mapping.padToNote.length===12?6:8),
                  } as CSSProperties:undefined}>
                    <button
                      type="button"
                      disabled={contentBusy}
                      onPointerDown={(e) => {
                         if (e.pointerType !== 'touch' && e.button !== 0) return;
                        padDown(pad, e);
                        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* A delayed WebKit touch can already have ended; still reconcile its native hit. */ }
                      }}
                      onPointerMove={padMove}
                      onPointerUp={event => padUp(pad,event)}
                      onPointerLeave={event=>{if(!event.currentTarget.hasPointerCapture(event.pointerId))padUp(pad,event,true);}}
                      onPointerCancel={event => padUp(pad,event,true)}
                      data-pad-state={feedback.pressed.has(`${bank}:${pad}`) ? "pressed" : feedback.flashing.has(`${bank}:${pad}`) ? "triggered" : feedback.active === `${bank}:${pad}` ? "active" : "idle"}
                      onContextMenu={(e) => e.preventDefault()}
                      onKeyDown={event=>{if(event.key==='Enter'||event.key===' ')pointerClicks.current.delete(pad);}}
                      onClick={(event) => {
                        const pending=(pointerClicks.current.get(pad)||[]).filter(value=>performance.now()-value.at<60000);
                        const pointerAlreadyHandled=padLayoutEnabled&&pending.length>0;
                         // WebKit may emit more than one compatibility click for
                         // a multi-finger gesture. Keep its pointer ownership;
                         // a click must never spend it and replay the same hit.
                        if(pending.length)pointerClicks.current.set(pad,pending);else pointerClicks.current.delete(pad);
                         if(!contentWorking.current&&(sampleEdit||event.detail===0&&!pointerAlreadyHandled))hit(pad);
                      }}
                       aria-label={loopPad?`${t.cues.pad(pad)}: Event looper ${['stopped','recording','playing','overdubbing'][loopPad.mode]}`:sample?`${t.cues.pad(pad)}: Sample ${sample.name}`:time == null ? `${t.cues.pad(pad)}: ${t.cues.empty}` : `${t.cues.pad(pad)}: ${formatTime(time)}`}
                       title={loopPad?'Tap: record / play / overdub · Double tap: stop · Hold 1.2 s: clear · Double tap and hold: layer undo/redo':sample?.error||sample?.name||(sampleEdit?'Load a sample into this pad':undefined)}
                         data-pad-kind={loopPad?'looper':sample?'sample':'cue'}
                         data-looper-active={!!loopPad&&loopPad.mode!==0}
                       data-pad-number={pad}
                      className={cn(
                        "cue-pad flex aspect-[1.45] w-full touch-none flex-col justify-between rounded-[14px] p-2.5 text-left transition-[transform,background-color] select-none active:scale-[0.97]",
                         time == null && !sample&&!loopPad
                          ? "bg-surface-2 active:bg-surface-3"
                          : "bg-accent-soft text-accent-text",
                        heldPads[`${bank}:${pad}`] ? "brightness-150" : "",
                         feedback.pressed.has(`${bank}:${pad}`) || feedback.flashing.has(`${bank}:${pad}`) ? "brightness-150 scale-[0.97]" : "",
                         fineEdit&&finePad===pad&&'cue-pad-fine-selected',rearranging&&'cue-pad-jiggle',dragPad===pad&&'cue-pad-dragging',dropPad===pad&&'cue-pad-drop-target',
                         loopPad&&(loopPad.mode===1||loopPad.mode===3)&&'ring-1 ring-danger',
                      )}
                    >
                      <span className={cn("text-xs font-semibold", !loopPad && (time == null && !sample ? "text-fg-3" : "text-accent-text"))}>
                        {pad}{loopPad?' · LOOP':sample?' · SMP':looperEdit?' · + LOOP':sampleEdit?' · +':''}
                      </span>
                      <span className={cn("block max-w-full truncate font-mono text-[11px]", !loopPad && (time == null && !sample ? "text-fg-3" : "text-accent-text"))}>
                        {loopPad?(loopPad.mode===1?'REC':loopPad.mode===3?'DUB':loopPad.mode===2?'PLAY':loopPad.length?'LOOP':'Ready')+` · ${loopPad.duration.toFixed(2)}s${loopPad.undone?' · Undo':''}`:sample?(sample.error?'Missing sample':sample.ready?sample.name:'Loading…'):time == null ? t.cues.empty : formatTime(time)}
                      </span>
                    </button>
                    {time != null && !sample&&!loopPad && (
                      <button
                        type="button"
                        aria-label={`${t.cues.pad(pad)}: ${t.common.close}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          useCueStore.getState().clearCue(pad);
                        }}
                        className="cue-pad-clear absolute top-1 right-1 grid size-6 place-items-center rounded-full bg-bg/70 text-[13px] leading-none text-fg-2 active:bg-bg"
                      >
                        {padLayoutEnabled&&nativePlatform()!=='android'?<svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 3.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" strokeWidth={1} strokeLinecap="round"/></svg>:'×'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            </div>
            <div className="cue-controls-panel">
            <section className="cue-speed mt-6 rounded-[16px] bg-surface-2 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-semibold">{speedMode === "pitch" ? t.cues.pitch : t.cues.speed}</h2>
                <span className="text-right">
                  <span className="block font-mono text-sm text-accent-text">{speed > 0 ? "+" : ""}{speed}%</span>
                </span>
              </div>
              <input
                type="range"
                min={-50}
                max={100}
                step={1}
                value={speed}
                style={{'--cue-speed-fill':`${(speed+50)/150*100}%`} as CSSProperties}
                onChange={(e) => usePlayer.getState().setSpeed(Number(e.target.value))}
                onDoubleClick={() => usePlayer.getState().setSpeed(0)}
                onPointerDown={(e) => {
                  beginEditGesture(`playback:${track?.id}`);
                  const tap = faderTap.current;
                  tap.started = performance.now();
                  tap.startX = e.clientX;
                  tap.startY = e.clientY;
                }}
                onPointerUp={(e) => {
                  endEditGesture();
                  if (e.pointerType === "mouse") return;
                  const tap = faderTap.current;
                  const now = performance.now();
                  const moved = Math.hypot(e.clientX - tap.startX, e.clientY - tap.startY);
                  if (moved > 10 || now - tap.started > 250) {
                    tap.previous = 0;
                    return;
                  }
                  if (tap.previous > 0 && now - tap.previous < 300 && Math.hypot(e.clientX - tap.previousX, e.clientY - tap.previousY) < 24) {
                    usePlayer.getState().setSpeed(0);
                    tap.previous = 0;
                  } else {
                    tap.previous = now;
                    tap.previousX = e.clientX;
                    tap.previousY = e.clientY;
                  }
                }}
                onPointerCancel={() => { endEditGesture();faderTap.current.previous = 0; }}
                className="mt-3 w-full touch-manipulation accent-[var(--color-accent)]"
                aria-label={speedMode === "pitch" ? t.cues.pitch : t.cues.speed}
              />
              {speedMode === "speed" && independentTuningAvailable && (
                <div className="cue-tuning mt-3 flex items-center justify-between gap-3">
                  <p className="text-[11px] leading-snug text-fg-3">{t.cues.semitoneNote}</p>
                  <div className="flex shrink-0 gap-1 rounded-full bg-surface-3 p-1">
                    <button
                      type="button"
                      aria-label={t.cues.semitoneDown}
                      disabled={tuning <= -12}
                      onClick={() => usePlayer.getState().setTuning(tuning - 1)}
                      className="h-8 rounded-full px-2.5 text-[11px] font-semibold active:bg-surface-4 disabled:opacity-40"
                    >
                      <span className="cue-label-long">−1 st</span><span className="cue-label-short hidden">−</span>
                    </button>
                    <span className="grid min-w-12 place-items-center font-mono text-[11px] text-accent-text" aria-live="polite">
                      {formatSemitones(tuning)}
                    </span>
                    <button
                      type="button"
                      aria-label={t.cues.semitoneUp}
                      disabled={tuning >= 12}
                      onClick={() => usePlayer.getState().setTuning(tuning + 1)}
                      className="h-8 rounded-full px-2.5 text-[11px] font-semibold active:bg-surface-4 disabled:opacity-40"
                    >
                      <span className="cue-label-long">+1 st</span><span className="cue-label-short hidden">+</span>
                    </button>
                  </div>
                </div>
              )}
              <div className="cue-speed-modes mt-3 flex items-center gap-2">
                <div className="grid flex-1 grid-cols-2 gap-1 rounded-full bg-surface-3 p-1">
                  <button
                    type="button"
                    aria-label={t.cues.pitchMode}
                    onClick={() => usePlayer.getState().setSpeedMode("pitch")}
                    className={cn(
                      "h-8 rounded-full text-[11px] font-semibold transition-colors",
                      speedMode === "pitch" ? "bg-accent text-accent-ink" : "text-fg-2",
                    )}
                  >
                    <span className="cue-label-long">{t.cues.pitchMode}</span><span className="cue-label-short hidden">Pitch</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t.cues.speedMode}
                    onClick={() => usePlayer.getState().setSpeedMode("speed")}
                    className={cn(
                      "h-8 rounded-full text-[11px] font-semibold transition-colors",
                      speedMode === "speed" ? "bg-accent text-accent-ink" : "text-fg-2",
                    )}
                  >
                    <span className="cue-label-long">{t.cues.speedMode}</span><span className="cue-label-short hidden">Speed</span>
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    usePlayer.getState().setSpeed(0);
                    if (speedMode === "speed") usePlayer.getState().setTuning(0);
                  }}
                  aria-label={t.cues.reset}
                  title={t.cues.reset}
                  className="cue-reset h-10 rounded-full bg-surface-3 px-3 text-xs font-semibold active:scale-95"
                >
                  <ArrowsClockwiseIcon size={14}/><span className="cue-reset-text">{t.cues.reset}</span>
                </button>
              </div>
            </section>

            <section className="cue-loop mt-4 rounded-[16px] bg-surface-2 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-semibold"><span className="cue-label-long">{t.cues.loop}</span><span className="cue-label-short hidden">Loop</span></h2>
                <span className="font-mono text-xs text-fg-2">
                  {loop.from == null ? "—" : formatTime(loop.from)} → {loop.to == null ? "—" : formatTime(loop.to)}
                </span>
              </div>
              <p className="mt-1 text-xs text-fg-3">{t.cues.loopHint}</p>
              <div className="mt-3 grid grid-cols-4 gap-2">
                  <button
                    type="button"
                    aria-label={t.cues.setIn}
                    onClick={() => usePlayer.getState().setLoopFrom()}
                  className="h-10 rounded-full bg-surface-3 text-xs font-semibold active:scale-95"
                >
                    <span className="cue-label-long">{t.cues.setIn}</span><span className="cue-label-short hidden">IN</span>
                </button>
                  <button
                    type="button"
                    aria-label={t.cues.setOut}
                    onClick={() => usePlayer.getState().setLoopTo()}
                  className="h-10 rounded-full bg-surface-3 text-xs font-semibold active:scale-95"
                >
                    <span className="cue-label-long">{t.cues.setOut}</span><span className="cue-label-short hidden">OUT</span>
                </button>
                <button
                    type="button"
                    aria-label={loop.on ? t.cues.loopOn : t.cues.loopOff}
                    aria-pressed={loop.on}
                    disabled={loop.from == null || loop.to == null || loop.to <= loop.from}
                  onClick={() => usePlayer.getState().toggleLoop()}
                  className={cn(
                    "h-10 rounded-full text-xs font-semibold transition-colors disabled:opacity-40",
                    loop.on ? "bg-accent text-accent-ink" : "bg-surface-3",
                  )}
                >
                    <span className="cue-label-long">{loop.on ? t.cues.loopOn : t.cues.loopOff}</span><span className="cue-label-short hidden">Loop</span>
                </button>
                  <button
                    type="button"
                    aria-label={t.common.close}
                    onClick={() => usePlayer.getState().clearLoop()}
                  className="h-10 rounded-full bg-surface-3 text-xs font-semibold active:scale-95"
                >
                    <span className="cue-label-long">{t.common.close}</span><span className="cue-label-short hidden">Clear</span>
                </button>
              </div>
            </section>

            </div>
            </div>
            </div>
            <div className="cue-playback-transport cue-bottom-playback"><Transport compact/><Scrubber className="cue-scrubber"/></div>
            <Modal open={midiOpen} onClose={()=>setMidiOpen(false)} title={t.cues.midi}>
            <div className="scroll-area max-h-[70dvh] overflow-y-auto">
            <section className="rounded-[16px] bg-surface-2 p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">{t.cues.midi}</h2>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-fg-2">
                    {devices.length ? t.cues.midiDevices(devices.length) : t.cues.midiNone}
                  </span>
                  <button
                    type="button"
                    onClick={refreshMidi}
                    aria-label={t.cues.midi}
                    className="grid size-8 place-items-center rounded-full bg-surface-3 text-fg-2 active:scale-90"
                  >
                    <ArrowsClockwiseIcon size={16} />
                  </button>
                </div>
              </div>
              <p className="mt-1 text-xs text-fg-3">{t.cues.midiHint}</p>
              <p className="mt-2 text-xs text-fg-3">{mapping.description ?? "Notes 36–47 · current bank"}</p>
              {padLayoutEnabled&&<>
                <div className="mt-4 flex items-center justify-between gap-3 text-xs">
                  <span>MIDI velocity</span>
                  <button type="button" role="switch" aria-label="MIDI velocity" aria-checked={velocityEnabled} className={cn('rounded-full px-3 py-2 font-semibold',velocityEnabled?'bg-accent text-accent-ink':'bg-surface-3 text-fg-2')} onClick={()=>{const enabled=!velocityEnabled;saveMidiVelocity(enabled);setVelocityEnabled(enabled);}}>{velocityEnabled?'On':'Off · full level'}</button>
                </div>
                <p className="mt-1 text-[11px] text-fg-3">On follows MIDI note velocity for cues and samples. Off plays every note at full level.</p>
                <label className="mt-4 flex flex-col gap-2 text-xs text-fg-2"><span>Bank buttons</span>
                  <select aria-label="Bank buttons" value={bankButtonMode} className="rounded-lg bg-surface-3 px-3 py-2 text-fg" onChange={event=>{const mode=event.target.value as BankButtonMode;saveBankButtonMode(mode);setBankButtonMode(mode);event.currentTarget.blur();}}>
                    <option value="separate">Separate · A–J</option>
                    <option value="paired">Paired · A/F, B/G, C/H, D/I, E/J</option>
                  </select>
                  <span className="text-[11px] text-fg-3">Tap a pair to switch banks. F–J pulse and the selected letter is underlined.</span>
                </label>
              </>}
              {padLayoutEnabled&&supportsPadOrder(mapping.id)&&<label className="mt-4 flex flex-col gap-2 text-xs text-fg-2">
                <span>Pad numbering</span>
                <select aria-label="Pad numbering" disabled={contentBusy} value={padOrder} className="rounded-lg bg-surface-3 px-3 py-2 text-fg" onChange={event=>{
                  const order=event.target.value as PadOrder,select=event.currentTarget,grid=document.querySelector('.cue-pad-grid');
                  const columns=grid?getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length:mapping.padToNote.length===12?3:4;
                  void editContents(()=>changePadNumbering(mapping,order,columns));select.blur();
                }}>
                  <option value="top-left">Top left → right, then down</option>
                  <option value="bottom-left">Bottom left → right, then up</option>
                </select>
                <span className="text-[11px] text-fg-3">Saved separately for 16 and 12 pads. Sounds stay in place; only the numbers change.</span>
              </label>}
              {devices.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {devices.map((device) => (
                    <li key={device.id} className="truncate rounded-md bg-surface-3 px-2 py-1 text-xs text-fg-2">
                      {device.name}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {Object.keys(cues).length>0&&<section className="mt-3 rounded-[16px] bg-surface-2 p-3">
              <h3 className="mb-2 text-xs font-semibold">{t.cues.title} · {t.cues.bank} {bank}</h3>
              <div className="grid grid-cols-4 gap-2">{Object.entries(cues).map(([number,time])=><button key={number} type="button" aria-label={`${t.cues.pad(Number(number))}: ${t.common.close}`} onClick={()=>useCueStore.getState().clearCue(Number(number))} className="flex h-9 items-center justify-between rounded-lg bg-surface-3 px-2 text-xs"><span>{number} · {formatTime(time)}</span><span aria-hidden="true">×</span></button>)}</div>
            </section>}
            <div className="mt-3"><Transport/></div>
            </div>
            </Modal>
          </>
        ) : (
          <p className="mt-8 rounded-[16px] bg-surface-2 p-5 text-sm text-fg-2">{t.cues.noTrack}</p>
        )}
      </div>
      <Modal open={samplePad!==null} onClose={()=>setSamplePad(null)} title={samplePad?`Sample pad ${samplePad.bank}${samplePad.pad}`:'Sample pad'}>
        {samplePad&&<div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-fg-2">{samples[`${samplePad.bank}:${samplePad.pad}`]?.name??'No sample loaded. This pad works as a normal cue pad.'}</p>
          {samples[`${samplePad.bank}:${samplePad.pad}`]?.error&&<p role="alert" className="text-sm text-danger">{samples[`${samplePad.bank}:${samplePad.pad}`].error}</p>}
          <p className="text-xs text-fg-3">A loaded sample plays as a one-shot, even without a song. It never marks or jumps to a cue. Remove it to restore normal cue behavior.</p>
           <button type="button" disabled={sampleBusy} className="rounded-full bg-accent px-4 py-2 text-accent-ink" onClick={()=>{setSampleBusy(true);void changePadSample('load',samplePad.bank,samplePad.pad).then(()=>setSamplePad(null)).catch(error=>toast(error.message,'error')).finally(()=>setSampleBusy(false));}}>{sampleBusy?'Loading…':samples[`${samplePad.bank}:${samplePad.pad}`]?'Replace sample…':'Load sample…'}</button>
           {padLayoutEnabled&&track&&<button type="button" className="rounded-full bg-surface-3 px-4 py-2" onClick={()=>{setMediaRequest({track,bank:samplePad.bank,pad:samplePad.pad});setSamplePad(null);}}>Chop current song…</button>}
          {samples[`${samplePad.bank}:${samplePad.pad}`]&&<button type="button" disabled={sampleBusy} className="rounded-full bg-surface-3 px-4 py-2" onClick={()=>{setSampleBusy(true);void changePadSample('remove',samplePad.bank,samplePad.pad).then(()=>setSamplePad(null)).catch(error=>toast(error.message,'error')).finally(()=>setSampleBusy(false));}}>Remove sample</button>}
        </div>}
       </Modal>
       {mediaRequest&&<MediaImportPanel request={mediaRequest} padCount={mapping.padToNote.length} onClose={()=>setMediaRequest(null)}/>}
    </div>
  );
}
