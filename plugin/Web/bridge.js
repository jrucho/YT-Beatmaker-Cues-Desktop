(() => {
  let counter = Math.floor(Date.now()*1024+Math.random()*1024);
  const pending = new Map();
  const backend = window.__JUCE__.backend;
  window.__pluginDesktopBeta=window.__JUCE__.initialisationData.desktopBeta?.[0]===true;
  backend.addEventListener('__juce__complete', ({promiseId, result}) => {
    const job = pending.get(promiseId);
    if (!job) return;
    pending.delete(promiseId);
    if (result && result.__error) job.reject(new Error(result.__error));
    else job.resolve(result);
  });
  const invoke = (name, ...params) => new Promise((resolve, reject) => {
    const resultId = counter++;
    pending.set(resultId, {resolve,reject});
    backend.emitEvent('__juce__invoke', {name,params,resultId});
  });
  window.__pluginInvoke = invoke;
  addEventListener('error',event=>{invoke('diagnostic','error: '+event.message).catch(()=>{});});
  addEventListener('unhandledrejection',event=>{invoke('diagnostic','promise: '+String(event.reason?.message||event.reason)).catch(()=>{});});
  invoke('diagnostic','Beatmaker Cues 1.0.4 plug-in bridge started').catch(()=>{});
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
          await libraryWrite.catch(()=>{});libraryBase=await invoke('libraryRead');return {data:libraryBase};
        }
        if (method==='readFile') {const data=localStorage.getItem(key);if(data===null)throw Error('File not found');return {data};}
        if (method==='writeFile') {localStorage.setItem(key,String(args.data));return {uri:key};}
        if (method==='deleteFile') {localStorage.removeItem(key);return {};}
        if (method==='rename') {
          const from='plugin-file:'+args.from;const data=localStorage.getItem(from);if(data===null)throw Error('File not found');
          if(args.to==='library.json'){
            const base=libraryBase;
            const work=libraryWrite.catch(()=>{}).then(async()=>{libraryBase=await invoke('libraryCommit',{base,next:data});localStorage.removeItem(from);});
            libraryWrite=work;await work;return {};
          }
          localStorage.setItem('plugin-file:'+args.to,data);localStorage.removeItem(from);return {};
        }
      }
      if (plugin==='MusikeMidi') return {devices:[{id:1,name:'DAW MIDI input'}]};
      if (plugin==='Share') {
        const key=args.files?.[0];
        return invoke('exportText',{name:args.title||'Beatmaker backup.json',text:localStorage.getItem(key)||''});
      }
      return {};
    }
  };
  window.fetch=window.fetch.bind(window);
  window.__pluginAudioBridge={postMessage:message=>invoke('audio',message)};
  window.__pluginResolveBridge={postMessage:message=>{
      resolveTrack(message.id,message.lang,message.region).then(payload=>window.__musikeResolve?.(message.req,payload),error=>window.__musikeResolve?.(message.req,{error:error.message}));
    }};
  async function resolveTrack(id,lang='en',region='US') {
    const cached=await invoke('cachedTrack',id);
    if(cached?.url)return cached;
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
        if(best){window.__pluginResolverClient=name;return {url:best.url,mime:best.mimeType,title:response.videoDetails?.title||'',duration:Number(response.videoDetails?.lengthSeconds)||0};}
      }catch(error){reason=error.message;}
    }
    window.__pluginResolveError=reason;throw Error(reason);
  }
  let lastStored='', lastSynced='';
  let reconciling=false;
  function persist() {
    const state=Object.fromEntries(Object.keys(localStorage).filter(key=>(key.startsWith('musike:')||key.startsWith('plugin-file:'))&&!key.startsWith('plugin-file:library')).map(key=>[key,localStorage.getItem(key)]));
    const json=JSON.stringify(state);
    if(json!==lastStored){lastStored=json;invoke('store',json).catch(error=>{lastStored='';console.error(error);});}
    const stores=window.__pluginStores;
    if(stores&&!reconciling){
      const cue=stores.cues.getState();
      const sync=JSON.stringify({trackId:cue.trackId,bank:cue.bank,cues:JSON.parse(localStorage.getItem('musike:cues:v1')||'{}')[cue.trackId]||{},preset:localStorage.getItem('musike:midi:preset')||'sp404mkii-a'});
      if(sync!==lastSynced){lastSynced=sync;invoke('syncCues',JSON.parse(sync)).catch(console.error);}
    }
  }
  setInterval(persist,1000);
  addEventListener('plugin-stores-ready',()=>{
    const stores=window.__pluginStores;
    if(!stores)return;
    if(window.__pluginStorageError)stores.ui.getState().toast(window.__pluginStorageError,'error');
    stores.cues.subscribe(()=>{if(!reconciling)queueMicrotask(persist);});
    stores.player.subscribe((current,previous)=>{if(current.queue!==previous.queue||current.index!==previous.index||current.status!==previous.status)queueMicrotask(persist);});
  });
  addEventListener('pagehide',persist);
  backend.addEventListener('pluginAudio',({event,payload})=>window.__musikeAudioEvent?.(event,payload));
  backend.addEventListener('pluginParameters',state=>window.__pluginStores?.player.setState(state));
  backend.addEventListener('pluginPads',events=>{
    for(const event of events){
      if(event.triggered){
        const stores=window.__pluginStores;
        if(stores&&stores.cues.getState().bank!==event.bank){reconciling=true;try{stores.cues.getState().setBank(event.bank);}finally{reconciling=false;}}
      }
      if(event.heldChanged)window.dispatchEvent(new CustomEvent('beatmaker-pad',{detail:{...event,phase:event.pressed?'pressed':'released'}}));
      if(event.triggered)window.dispatchEvent(new CustomEvent('beatmaker-pad',{detail:{...event,phase:'triggered'}}));
    }
  });
  backend.addEventListener('pluginCues',data=>{
    const stores=window.__pluginStores;
    if(!stores||stores.cues.getState().trackId!==data.trackId)return;
    reconciling=true;
    try{
      const all=JSON.parse(localStorage.getItem('musike:cues:v1')||'{}');
      all[data.trackId]=data.cues;localStorage.setItem('musike:cues:v1',JSON.stringify(all));
      stores.cues.getState().setBank(data.bank);
    } finally{reconciling=false;}
  });
  window.__pluginReady=true;
})();
