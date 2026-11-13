(() => {
  let counter = Math.floor(Date.now()*1024+Math.random()*1024);
  const pending = new Map();
  const backend = window.__JUCE__.backend;
  const features=window.__JUCE__.initialisationData.performanceFeatures?.[0]===true||window.__JUCE__.initialisationData.iosPreviewFeatures?.[0]===true;
  window.__pluginFeatures=features;
  window.__pluginPlatform=window.__JUCE__.initialisationData.nativePlatform?.[0]||(window.__JUCE__.getAndroidUserScripts?'android':window.__JUCE__.initialisationData.desktopPlatform?.[0]?'desktop':'ios');
  // Some Android WebViews embedded by JUCE resolve vh/dvh to zero even while
  // innerHeight is correct. Use measured pixels for the app and dialog bounds.
  {
    const android = !!window.__JUCE__.getAndroidUserScripts;
    const updateViewport = () => {
      const root = document.documentElement;
      if (!root) return;
      const height = window.innerHeight;
      if (height > 0) {
        const landscape = window.innerWidth > height;
        root.dataset.pluginLayout = landscape ? 'landscape' : 'portrait';
        root.dataset.pluginCompact = height <= (landscape ? 600 : 680) ? 'true' : 'false';
        root.dataset.pluginDense = height <= 360 ? 'true' : 'false';
        if (android) root.dataset.pluginAndroid = '';
        root.dataset.pluginDesktop = window.__JUCE__.initialisationData.desktopPlatform?.[0]===true ? 'true' : 'false';
        root.dataset.pluginFeatures=String(features);
        root.dataset.pluginIosPreview=String(features); // Legacy shared responsive-CSS attribute.
        root.dataset.pluginLowHeight = height < 540 ? 'true' : 'false';
        root.style.setProperty('--plugin-viewport-height', height + 'px');
        root.style.setProperty('--plugin-vh', (height / 100) + 'px');
      }
    };
    updateViewport();
    addEventListener('resize', updateViewport);
    addEventListener('pageshow', updateViewport);
    document.addEventListener('visibilitychange', updateViewport);
    document.addEventListener('DOMContentLoaded', updateViewport);
    window.visualViewport?.addEventListener('resize', updateViewport);
  }
  window.__pluginHosted=window.__JUCE__.initialisationData.hostedPlugin?.[0]===true;
  window.__pluginDesktopBeta=window.__JUCE__.initialisationData.desktopBeta?.[0]===true;
  window.__pluginIOSPreview=window.__JUCE__.initialisationData.iosPreviewFeatures?.[0]===true;
  const songPlaybackKey='musike:track-playback';
  let reconcilingPlayback=false;
  const cleanSongPlayback=value=>({
    speed:Math.max(-75,Math.min(100,Math.round(Number.isFinite(value?.speed)?value.speed:0))),
    speedMode:value?.speedMode==='pitch'?'pitch':'speed',
    tuning:Math.max(-12,Math.min(12,Math.round(Number.isFinite(value?.tuning)?value.tuning:0)))
  });
  const songPlaybackMap=()=>{try{const value=JSON.parse(localStorage.getItem(songPlaybackKey)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}};
  const rememberSongPlayback=(id,value)=>{
    if(!id)return;const all=songPlaybackMap(),settings=cleanSongPlayback(value);
    if(JSON.stringify(all[id])===JSON.stringify(settings))return;
    all[id]=settings;localStorage.setItem(songPlaybackKey,JSON.stringify(all));
    window.dispatchEvent(new Event('plugin-preferences-changed'));
  };
  backend.addEventListener('__juce__complete', ({promiseId, result}) => {
    const job = pending.get(promiseId);
    if (!job) return;
    pending.delete(promiseId);
    try{
      if(typeof result?.__pluginBase64==='string'){
        const bytes=Uint8Array.from(atob(result.__pluginBase64),character=>character.charCodeAt(0));
        result=JSON.parse(new TextDecoder().decode(bytes));
      }
    }catch(error){job.reject(error);return;}
    if (result && result.__error) job.reject(new Error(result.__error));
    else job.resolve(result);
  });
  const androidPerformance=()=>window.__disableAndroidPerformance?undefined:window.__beatmakerPerformance;
  const nativePadAvailable=window.__JUCE__.initialisationData.nativePadInput?.[0]===true;
  let nativePadState=null;
  let performanceSourceId=0,performanceTrackId='',padMap=null,lastPadMap='',claimedTouch=null;
  const syncPadMap=()=>{
    const bridge=window.__beatmakerPerformance;
    if(!bridge&&!nativePadAvailable)return;
    const platform=bridge?window.__pluginAndroidPlatform:nativePadState;
    const matchingTrack=padMap?.trackId===performanceTrackId&&platform?.sourceId===performanceSourceId
      &&(!nativePadAvailable||platform?.trackId===padMap?.trackId)&&window.__musikeAudioEl?.readyState>0;
    const encoded=JSON.stringify(padMap&&!document.hidden?{
      ...padMap,sourceId:performanceSourceId,generation:platform?.audioGeneration??-1,
      trackRevision:platform?.trackRevision??-1,layoutRevision:platform?.layoutRevision??-1,
      bank:padMap.bank.charCodeAt(0)-65,enabled:bridge?!window.__disableAndroidPerformance&&!window.__disableAndroidPadTouch:!!platform?.supported&&!window.__disableNativePadInput,
      pads:padMap.pads.filter(pad=>pad.sample||pad.looper||matchingTrack)
    }:{});
    if(encoded===lastPadMap)return;
    try{
      if(bridge)bridge.regions(JSON.stringify({...JSON.parse(encoded),clockId:performance.timeOrigin,jsTime:performance.now()}));
      else invoke('padTouchRegions',JSON.parse(encoded)).catch(error=>{lastPadMap='';console.error(error);});
      lastPadMap=encoded;
    }catch{}
  };
  const consumeClaimedTouch=(sourceId,bank,pad,sample)=>{
    if(!claimedTouch||claimedTouch.sourceId!==sourceId||claimedTouch.bank!==bank||claimedTouch.pad!==pad||claimedTouch.sample!==sample)return false;
    claimedTouch=null;return true;
  };
  const touchReceipt=(sourceId,bank,pad,sample,position,stale=false)=>{
    let reconciled=false;
    return {position:stale?NaN:position,reconcile:trigger=>{
      if(reconciled||stale)return;
      reconciled=true;claimedTouch={sourceId,bank,pad,sample};
      try{trigger();}finally{claimedTouch=null;}
    }};
  };
  if(window.__JUCE__.getAndroidUserScripts||nativePadAvailable){
    window.__pluginPadTouch={
      configure:map=>{padMap=map;syncPadMap();},
      take:(bank,pad,sample,to,eventTime,pointerType,looper=false)=>{
        const sourceId=performanceSourceId,bankIndex=bank.charCodeAt(0)-65,padIndex=pad-1;
        if(nativePadAvailable){
          const platform=nativePadState;
          if(!platform?.supported||window.__disableNativePadInput)return;
          const eventEpochMs=eventTime>1e12?eventTime:performance.timeOrigin+eventTime;
          return invoke('padTouchClaim',{sourceId,bank:bankIndex,pad:padIndex,sample,looper,to:to??0,eventEpochMs,orderedTouch:features&&pointerType==='touch',generation:platform.audioGeneration,trackRevision:platform.trackRevision}).then(result=>{
            if(!result?.accepted&&!result?.stale)return;
            return touchReceipt(sourceId,bankIndex,padIndex,sample,result.position??NaN,!!result.stale);
          });
        }
        try{
          const bridge=androidPerformance(),position=bridge?.consumeTouch(sourceId,bankIndex,padIndex,sample,to??0,eventTime,looper,features&&pointerType==='touch');
          if(!Number.isFinite(position)){if(bridge?.consumedStale?.())return touchReceipt(sourceId,bankIndex,padIndex,sample,NaN,true);return;}
          return touchReceipt(sourceId,bankIndex,padIndex,sample,position);
        }catch{}
      }
    };
    addEventListener('pagehide',()=>{try{if(nativePadAvailable)invoke('padTouchRegions',null).catch(()=>{});else window.__beatmakerPerformance?.regions('{}');lastPadMap='';}catch{}});
  }
  const invoke = (name, ...params) => {
    if(name==='looperPad'&&params[0]?.cmd==='press'&&!params[0]?.gestureId){const request=params[0];if(consumeClaimedTouch(performanceSourceId,request.bank?.charCodeAt(0)-65,request.pad-1,false))return Promise.resolve(true);}
    if(name==='padSample'&&params[0]?.cmd==='trigger'){
      const request=params[0],bank=request.bank?.charCodeAt(0)-65,pad=request.pad-1;
      if(consumeClaimedTouch(performanceSourceId,bank,pad,true))return Promise.resolve(true);
      try{if(androidPerformance()?.audio(4,0,0,bank,pad))return Promise.resolve(true);}catch{}
    }
    return new Promise((resolve, reject) => {
    const resultId = counter++;
    pending.set(resultId, {resolve,reject});
    backend.emitEvent('__juce__invoke', {name,params,resultId});
    });
  };
  window.__pluginInvoke = invoke;
  if(features){
    let queued=false,previous=null;
    const syncCuePage=()=>{queued=false;const active=!!document.querySelector('.cue-workspace');if(active===previous)return;previous=active;
      document.documentElement.dataset.pluginCuePage=String(active);invoke('cueWorkspace',active).catch(console.error);};
    const schedule=()=>{if(!queued){queued=true;queueMicrotask(syncCuePage);}};
    new MutationObserver(schedule).observe(document,{subtree:true,childList:true});document.addEventListener('DOMContentLoaded',schedule);schedule();
    document.addEventListener('touchmove',event=>{
      if(!previous)return;const target=event.target;
      if(target instanceof Element&&target.closest('.cue-song-list,[role="dialog"],input,select,textarea'))return;
      if(event.cancelable)event.preventDefault();
    },{passive:false});
  }
  if(nativePadAvailable){
    const update=state=>{nativePadState=state;syncPadMap();};
    backend.addEventListener('pluginPadInputState',update);invoke('padTouchState').then(update).catch(console.error);
  }
  // Native Mac hosted editors route musical keyboard presses directly to the
  // host responder. Tell that router when keys must instead stay in text/UI.
  if(window.__pluginHosted){
    let lastFocus='',queued=false;
    const syncKeyboardFocus=()=>{
      queued=false;
      const active=document.activeElement;
      const editing=!!document.querySelector('[role="dialog"]')||!!(active&&(active.isContentEditable||active.matches('input:not([type="range"]):not([type="checkbox"]):not([type="radio"]),textarea,select,[role="textbox"],[role="combobox"]')));
      const state={editing,padsActive:!!document.querySelector('.cue-pad-grid,.bm-pads')};
      window.__pluginKeyboardFocus=state;
      const encoded=JSON.stringify(state);if(encoded===lastFocus)return;
      invoke('keyboardFocus',state).then(()=>{lastFocus=encoded;}).catch(console.error);
    };
    // WKWebView can defer native messages emitted during DOM mutation delivery.
    // Send after that delivery and only deduplicate acknowledged native state.
    const schedule=()=>{if(!queued){queued=true;setTimeout(syncKeyboardFocus,0);}};
    document.addEventListener('focusin',schedule,true);document.addEventListener('focusout',schedule,true);
    new MutationObserver(schedule).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['role','contenteditable']});
    document.addEventListener('DOMContentLoaded',schedule);schedule();
  }
  if (window.__JUCE__.getAndroidUserScripts) {
    const applyPlatform = state => {
      const scale = window.devicePixelRatio || 1,root=document.documentElement,previous=window.__pluginAndroidPlatform;
      let insetsChanged=false;
      for (const edge of ['top', 'left', 'right', 'bottom']) {
        const name='--plugin-safe-'+edge,value=Math.max(0,state[edge]||0)/scale+'px';
        if(root.style.getPropertyValue(name)!==value){root.style.setProperty(name,value);insetsChanged=true;}
      }
      window.__pluginAndroidPlatform = state;
      if(previous?.sourceId!==state.sourceId||previous?.audioGeneration!==state.audioGeneration)syncPadMap();
      if(insetsChanged)window.dispatchEvent(new Event('plugin-android-insets'));
    };
    backend.addEventListener('pluginAndroidPlatform', applyPlatform);
    invoke('androidPlatform').then(applyPlatform).catch(console.error);
  }
  addEventListener('error',event=>{invoke('diagnostic','error: '+event.message).catch(()=>{});});
  addEventListener('unhandledrejection',event=>{invoke('diagnostic','promise: '+String(event.reason?.message||event.reason)).catch(()=>{});});
  invoke('diagnostic','Beatmaker Cues '+(window.__JUCE__.initialisationData.appVersion?.[0]||'development')+' plug-in bridge started').catch(()=>{});
  window.__musikeTransport = async request => {
    const response=await invoke('http',{url:request.url,method:request.method,headers:request.headers,data:request.body});
    return {status:response.status,headers:response.headers||{},body:typeof response.data==='string'?response.data:JSON.stringify(response.data)};
  };
  // Separate each plug-in instance's DAW-restored state from the web origin's shared storage.
  try {
    const saved = window.__JUCE__.initialisationData.pluginStorage?.[0] || '{}';
    const state = JSON.parse(saved);
    const data=new Map(Object.entries(state));
    const storage=new Proxy({}, {
      get(_target,key){
        if(key==='getItem')return name=>data.get(String(name))??null;
        if(key==='setItem')return (name,value)=>data.set(String(name),String(value));
        if(key==='removeItem')return name=>data.delete(String(name));
        if(key==='clear')return ()=>data.clear();
        if(key==='key')return index=>Array.from(data.keys())[index]??null;
        if(key==='length')return data.size;
        return data.get(String(key));
      },
      ownKeys(){return Array.from(data.keys());},
      getOwnPropertyDescriptor(_target,key){return data.has(String(key))?{enumerable:true,configurable:true,value:data.get(String(key))}:undefined;},
      set(_target,key,value){data.set(String(key),String(value));return true;},
      deleteProperty(_target,key){data.delete(String(key));return true;}
    });
    Object.defineProperty(window,'localStorage',{configurable:true,value:storage});
  } catch {}
  window.__pluginInit=invoke('initialState').then(saved=>{
    const session=JSON.parse(saved?.session||'{}');
    for(const [key,value] of Object.entries(session))localStorage.setItem(key,value);
    const durable=JSON.parse(typeof saved==='string'?saved:saved?.defaults||'{}');
    for(const [key,value] of Object.entries(durable))if(localStorage.getItem(key)===null)localStorage.setItem(key,value);
  }).catch(error=>{window.__pluginStorageError=error.message;return invoke('diagnostic','Persistent storage: '+error.message);});
  let libraryBase='';
  let libraryVersion=null;
  let libraryWrite=Promise.resolve();
  const listeners = new Map();
  const methods = (names) => names.map(name => ({name,rtype:'promise'}));
  window.Capacitor = {
    getPlatform:()=> 'ios', isNativePlatform:()=>true,
    isPluginAvailable:()=>true,
    PluginHeaders: [
      {name:'CapacitorHttp',methods:methods(['request'])},
      {name:'Filesystem',methods:methods(['readFile','writeFile','deleteFile','rename','stat'])},
      {name:'Share',methods:methods(['share'])},
      {name:'SystemBars',methods:methods(['setStyle'])},
      {name:'Keyboard',methods:[...methods(['hide','setResizeMode']),{name:'addListener',rtype:'callback'},...methods(['removeListener'])]},
      {name:'App',methods:[{name:'addListener',rtype:'callback'},...methods(['removeListener'])]},
      {name:'MusikeMidi',methods:[...methods(['list','refresh','removeListener']),{name:'addListener',rtype:'callback'}]}
    ],
    nativeCallback(plugin,method,options,callback) {
      if (method==='addListener') {
        const id='plugin-listener-'+counter++;
        listeners.set(id,{plugin,event:options.eventName,callback});
        return id;
      }
    },
    async nativePromise(plugin,method,args={}) {
      if (method==='removeListener') {listeners.delete(args.callbackId);return {};}
      if (plugin==='CapacitorHttp') return invoke('http',args);
      if (plugin==='Filesystem') {
        const key='plugin-file:'+args.path;
        if (method==='readFile'&&args.path==='library.json'){
          await libraryWrite.catch(()=>{});
          const version=await invoke('libraryVersion');
          if(libraryVersion!==version||!libraryBase){const snapshot=await invoke('librarySnapshot');libraryBase=snapshot.json;libraryVersion=snapshot.version;}
          return {data:libraryBase};
        }
        if (method==='readFile') {const data=localStorage.getItem(key);if(data===null)throw Error('File not found');return {data};}
        if (method==='writeFile') {localStorage.setItem(key,String(args.data));return {uri:key};}
        if (method==='deleteFile') {localStorage.removeItem(key);return {};}
        if (method==='rename') {
          const from='plugin-file:'+args.from;const data=localStorage.getItem(from);if(data===null)throw Error('File not found');
          if(args.to==='library.json'){
            const base=libraryBase;
            const work=libraryWrite.catch(()=>{}).then(async()=>{
              libraryBase=await invoke('libraryCommit',{base,next:data});libraryVersion=null;localStorage.removeItem(from);
              if(features&&base){
                const before=JSON.parse(base),after=JSON.parse(libraryBase),select=value=>JSON.stringify({favorites:value.favorites,playlists:value.playlists});
                if(select(before)!==select(after)){
                  const committed=libraryBase;
                  const apply=async(base,next)=>{
                    const current=JSON.parse((await invoke('librarySnapshot')).json),old=JSON.parse(base),desired=JSON.parse(next);
                    libraryBase=await invoke('libraryCommit',{base:JSON.stringify({...current,favorites:old.favorites,playlists:old.playlists}),next:JSON.stringify({...current,favorites:desired.favorites,playlists:desired.playlists})});
                    libraryVersion=null;await window.__pluginStores?.library.getState().load();
                  };
                  window.dispatchEvent(new CustomEvent('plugin-record-edit',{detail:{label:'library edit',key:'library',undo:()=>apply(committed,base),redo:()=>apply(base,committed)}}));
                }
              }
            });
            libraryWrite=work;await work;return {};
          }
          localStorage.setItem('plugin-file:'+args.to,data);localStorage.removeItem(from);return {};
        }
      }
      if (plugin==='MusikeMidi') return {devices:[{id:1,name:'DAW MIDI input'}]};
      if (plugin==='Share') {
        const key=args.files?.[0];
        try{return await invoke('exportText',{name:args.title||'Beatmaker backup.json',text:localStorage.getItem(key)||''});}finally{localStorage.removeItem(key);}
      }
      return {};
    }
  };
  window.fetch=window.fetch.bind(window);
  window.__pluginAudioBridge={
    ...(window.__JUCE__.initialisationData.songTransitions?.[0]===true?{navigate:request=>invoke('audio',{cmd:'navigate',...request}).then(result=>result?.accepted===true)}:{}),
    postMessage:message=>{
      if(features&&message.cmd==='rate'){
        const state=window.__pluginStores?.player.getState(),id=state?.queue[state.index]?.id;
        if(id)message={...message,trackId:id};
      }
      if(message.cmd==='load'){
        performanceSourceId=message.sourceId;
        performanceTrackId=message.queue?.tracks?.[message.queue.index]?.id||'';
        syncPadMap();
      }
      const action={cue:0,seek:1,play:2,pause:3}[message.cmd];
      if(action!==undefined){
        const sourceId=message.sourceId??performanceSourceId;
        const bank=message.bank?.charCodeAt(0)-65||0,pad=message.pad==null?-1:message.pad-1;
        const reconciled=action===0&&consumeClaimedTouch(sourceId,bank,pad,false);
        try{if(reconciled||androidPerformance()?.audio(action,sourceId,message.to||0,bank,pad)){
          if(action===0||action===1)queueMicrotask(()=>window.__musikeAudioEvent?.('seeked',{sourceId,position:message.to}));
          return Promise.resolve({});
        }}catch{}
      }
      return invoke('audio',message).then(result=>{
        if(message.cmd==='load'&&!message.url&&message.sourceId===performanceSourceId&&result?.previousCues)applyNativeCues(result.previousCues);
        return result;
      });
    },
    position:sourceId=>{
      try{const position=androidPerformance()?.position(sourceId);if(Number.isFinite(position))return Promise.resolve(position);}catch{}
      return invoke('audio',{cmd:'position',sourceId}).then(state=>state.position);
    },
    snapshot:()=>invoke('audio',{cmd:'snapshot'})
  };
  window.__pluginResolveBridge={postMessage:message=>{
      resolveTrack(message.id,message.lang,message.region).then(payload=>window.__musikeResolve?.(message.req,payload),error=>window.__musikeResolve?.(message.req,{error:error.message}));
    }};
  async function resolveTrack(id,lang='en',region='US') {
    const started=performance.now();
    const cached=await invoke('cachedTrack',id);
    window.__pluginLastResolution={cacheLookupMs:performance.now()-started,cacheHit:!!cached?.url};
    if(cached?.url){window.__pluginLastResolution.resolveMs=performance.now()-started;return cached;}
    const ua='Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
    const post=async(path,body,name,version,clientId)=>{
      const response=await invoke('http',{url:'https://www.youtube.com/youtubei/v1/'+path,method:'POST',headers:{'content-type':'application/json','User-Agent':ua,'X-YouTube-Client-Name':clientId,'X-YouTube-Client-Version':version,'X-Goog-Api-Format-Version':'2','Origin':'https://www.youtube.com'},data:JSON.stringify(body)});
      if(response.status!==200)throw Error('YouTube HTTP '+response.status);
      return typeof response.data==='string'?JSON.parse(response.data):response.data;
    };
    const makeClient=(name,version)=>({clientName:name,clientVersion:version,hl:lang,gl:region,userAgent:ua+',gzip(gfe)',platform:'DESKTOP'});
    let visitor=localStorage.getItem('plugin:visitor')||'';
    if(!visitor){try{const response=await post('visitor_id?prettyPrint=false',{context:{client:makeClient('VISIONOS','1.02')}},'VISIONOS','1.02','101');visitor=response.responseContext?.visitorData||'';localStorage.setItem('plugin:visitor',visitor);}catch{}}
    let reason='No playable audio format';
    for(const [name,version,clientId] of [['VISIONOS','1.02','101'],['ANDROID_VR','1.60.19','28'],['IOS','20.10.4','5']]){
      try{
        const response=await post('player?prettyPrint=false&alt=json',{videoId:id,racyCheckOk:true,contentCheckOk:true,context:{client:{...makeClient(name,version),visitorData:visitor,originalUrl:'https://www.youtube.com/watch?v='+id}},playbackContext:{contentPlaybackContext:{html5Preference:'HTML5_PREF_WANTS'}}},name,version,clientId);
        if(response.playabilityStatus?.status!=='OK'){reason=response.playabilityStatus?.reason||reason;continue;}
        const best=(response.streamingData?.adaptiveFormats||[]).filter(f=>f.url&&f.mimeType?.startsWith('audio/mp4')).sort((a,b)=>b.bitrate-a.bitrate)[0];
        if(best){window.__pluginResolverClient=name;window.__pluginLastResolution.resolveMs=performance.now()-started;return {url:best.url,mime:best.mimeType,title:response.videoDetails?.title||'',duration:Number(response.videoDetails?.lengthSeconds)||0};}
      }catch(error){reason=error.message;}
    }
    window.__pluginResolveError=reason;throw Error(reason);
  }
  let lastStored='', lastSynced='';
  let reconciling=false;
  function persist() {
    const state=Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith('musike:')).map(key=>[key,localStorage.getItem(key)]));
    const json=JSON.stringify(state);
    if(json!==lastStored){lastStored=json;invoke('store',json).catch(error=>{lastStored='';console.error(error);});}
    const stores=window.__pluginStores;
    if(stores&&!reconciling){
      const cue=stores.cues.getState();
      const sync=JSON.stringify({trackId:cue.trackId,bank:cue.bank,cues:JSON.parse(localStorage.getItem('musike:cues:v1')||'{}')[cue.trackId]||{},preset:localStorage.getItem('musike:midi:preset')||(window.__pluginHosted?'linear16':'sp404mkii-a')});
      if(sync!==lastSynced){lastSynced=sync;invoke('syncCues',JSON.parse(sync)).catch(console.error);}
    }
  }
  setInterval(persist,1000);
  addEventListener('plugin-stores-ready',()=>{
    const stores=window.__pluginStores;
    if(!stores)return;
    if(window.__pluginStorageError)stores.ui.getState().toast(window.__pluginStorageError,'error');
    if(features){
      const current=stores.player.getState(),id=current.queue[current.index]?.id;
      if(id){const saved=songPlaybackMap()[id];if(saved){reconcilingPlayback=true;try{stores.player.setState(cleanSongPlayback(saved));}finally{reconcilingPlayback=false;}}else rememberSongPlayback(id,current);}
      stores.player.subscribe((current,previous)=>{
        const id=current.queue[current.index]?.id,oldId=previous.queue[previous.index]?.id;
        if(id!==oldId){if(id){reconcilingPlayback=true;try{stores.player.setState(cleanSongPlayback(songPlaybackMap()[id]));}finally{reconcilingPlayback=false;}}return;}
        if(id&&(current.speed!==previous.speed||current.speedMode!==previous.speedMode||current.tuning!==previous.tuning)){
          rememberSongPlayback(id,current);
          if(!reconcilingPlayback){
            const before=cleanSongPlayback(previous),after=cleanSongPlayback(current);
            const apply=value=>{rememberSongPlayback(id,value);const player=stores.player.getState();if(player.queue[player.index]?.id===id){player.setSpeedMode(value.speedMode);player.setSpeed(value.speed);player.setTuning(value.tuning);}};
            window.dispatchEvent(new CustomEvent('plugin-record-edit',{detail:{label:'song playback',key:`playback:${id}`,undo:()=>apply(before),redo:()=>apply(after)}}));
          }
        }
      });
    }
    stores.cues.subscribe(()=>{if(!reconciling)queueMicrotask(persist);});
    stores.player.subscribe((current,previous)=>{if(current.queue!==previous.queue||current.index!==previous.index||current.status!==previous.status)queueMicrotask(persist);});
  });
  addEventListener('pagehide',persist);
  addEventListener('plugin-preferences-changed',persist);
  backend.addEventListener('pluginAudio',({event,payload})=>{
    if(features&&(event==='track'||event==='snapshot')&&payload.trackId&&payload.playback&&(payload.sourceId==null||payload.sourceId===performanceSourceId)){
      rememberSongPlayback(payload.trackId,payload.playback);
      const state=window.__pluginStores?.player.getState();
      if(state?.queue[state.index]?.id===payload.trackId){reconcilingPlayback=true;try{window.__pluginStores.player.setState(cleanSongPlayback(payload.playback));}finally{reconcilingPlayback=false;}}
    }
    if((event==='track'||event==='snapshot')&&payload.trackId!=null){performanceTrackId=payload.trackId;syncPadMap();}
    window.__musikeAudioEvent?.(event,payload);
    if(event==='ready'||event==='track'||event==='snapshot')syncPadMap();
  });
  backend.addEventListener('pluginParameters',state=>{
    const current=window.__pluginStores?.player.getState();
    if(features&&(state.playbackReady===false||state.trackId&&state.trackId!==current?.queue[current.index]?.id))return;
    reconcilingPlayback=true;try{window.__pluginStores?.player.setState(state);}finally{reconcilingPlayback=false;}
  });
  backend.addEventListener('pluginPadSamples',pads=>window.dispatchEvent(new CustomEvent('plugin-pad-samples',{detail:pads})));
  backend.addEventListener('pluginPads',events=>{
    for(const event of events){
      if(event.midiTriggered===undefined?event.triggered&&event.lastTriggered!==false:event.midiTriggered&&event.lastMidiTriggered){
        const stores=window.__pluginStores;
        if(stores&&stores.cues.getState().bank!==event.bank){reconciling=true;try{stores.cues.getState().setBank(event.bank);}finally{reconciling=false;}}
      }
      if(event.heldChanged)window.dispatchEvent(new CustomEvent('beatmaker-pad',{detail:{...event,phase:event.pressed?'pressed':'released',source:'native'}}));
      if(event.triggered||event.midiTriggered)window.dispatchEvent(new CustomEvent('beatmaker-pad',{detail:{...event,phase:'triggered',source:'native'}}));
    }
  });
  function applyNativeCues(data){
    const stores=window.__pluginStores;
    if(!stores||stores.cues.getState().trackId!==data.trackId)return;
    reconciling=true;
    try{
      const all=JSON.parse(localStorage.getItem('musike:cues:v1')||'{}');
      const previous=all[data.trackId]||{};
      all[data.trackId]=data.cues;localStorage.setItem('musike:cues:v1',JSON.stringify(all));
      stores.cues.getState().setBank(data.bank);
      const activeBanks=value=>JSON.stringify(Object.fromEntries(Object.entries(value).filter(([,pads])=>Object.keys(pads||{}).length).sort(([a],[b])=>a.localeCompare(b))));
      if(features&&activeBanks(previous)!==activeBanks(data.cues)){
        const apply=value=>{const all=JSON.parse(localStorage.getItem('musike:cues:v1')||'{}');all[data.trackId]=value;localStorage.setItem('musike:cues:v1',JSON.stringify(all));
          if(stores.cues.getState().trackId===data.trackId)stores.cues.getState().setBank(stores.cues.getState().bank);window.dispatchEvent(new Event('plugin-preferences-changed'));};
        window.dispatchEvent(new CustomEvent('plugin-record-edit',{detail:{label:'MIDI cue edit',undo:()=>apply(previous),redo:()=>apply(data.cues)}}));
      }
    } finally{reconciling=false;}
  }
  backend.addEventListener('pluginCues',applyNativeCues);
  window.__pluginReady=true;
})();
