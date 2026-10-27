// Actual browser OfflineAudioContext vs portable native DSP, using original factories.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
const root=path.resolve(import.meta.dirname,'..'),probe=path.resolve(process.argv.slice(2).find(arg=>!arg.startsWith('--'))||'plugin/build-mac-beta/FxGraphTests_artefacts/Release/FxGraphTests');
const source=await readFile(path.join(root,'YTbeatmakercues/content.js'),'utf8');
function extract(name){
  const begin=source.indexOf('function '+name+'(');assert(begin>=0,name);
  let at=source.indexOf('{',begin),depth=0,quote='';
  for(let i=at;i<source.length;++i){const ch=source[i];if(quote){if(ch==='\\'){++i;continue;}if(ch===quote)quote='';continue;}
    if(ch==='"'||ch==="'"||ch==='`'){quote=ch;continue;}
    if(ch==='/'&&source[i+1]==='/'){i=source.indexOf('\n',i);continue;}
    if(ch==='/'&&source[i+1]==='*'){i=source.indexOf('*/',i+2)+1;continue;}
    if(ch==='{')++depth;if(ch==='}'&&--depth===0)return source.slice(begin,i+1);
  }throw Error('Unterminated '+name);
}
const factories={none:'createBypassEffect',delay:'createDelayEffect',tapeEcho:'createTapeEchoEffect',echoBreak:'createEchoBreakEffect',oneShotDelay:'createOneShotDelayEffect',freezeLooper:'createFreezeLooperEffect',isolator:'createIsolatorEffect',equalizer:'createEqualizerEffect',subsonic:'createSubsonicEffect',filterDrive:'createFilterDriveEffect',distortion:'createDistortionEffect',overdrive:'createDistortionEffect',fuzz:'createDistortionEffect',autopan:'createAutopanEffect',tremoloPan:'createTremoloPanEffect',ringMod:'createRingModEffect',chorus:'createChorusEffect',flanger:'createFlangerEffect',pitch:'createPitchEffect',octave:'createOctaveEffect',chromPitchShift:'createChromPitchShiftEffect',pitchFine:'createPitchFineEffect',duckComp:'createDuckCompEffect',compressor:'createCompressorEffect',resonator:'createResonatorEffect',wah:'createWahEffect',centerCancel:'createCenterCancelEffect'};
const names=[...new Set(['createLevelComp','makeDriveCurve',...Object.values(factories)])];
let pad=extract('createFxPadEngine').replaceAll("await setEffect(0,'stutterGrain');","await setEffect(0,'none');").replaceAll("await setEffect(1,'delay');","await setEffect(1,'none');").replaceAll("await setEffect(2,'flanger');","await setEffect(2,'none');").replaceAll("await setEffect(3,'reverb');","await setEffect(3,'none');");
const code=names.map(extract).join('\n')+'\nasync '+pad;
const folder=await mkdtemp(path.join(tmpdir(),'beatmaker-fx-graph-'));let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage(),results=[];
  const rates=process.argv.includes('--all-rates')?[44100,48000,96000]:[48000];
  for(const rate of rates){
    const length=Math.ceil(rate*1.5),left=new Float32Array(length),right=new Float32Array(length);
    for(let n=0;n<length;++n){const t=n/rate,level=n<length/3?0.2:n<2*length/3?1:0.05;left[n]=level*(0.7*Math.sin(2*Math.PI*440*t)+0.13*Math.sin(2*Math.PI*3107*t));right[n]=level*(0.4*Math.cos(2*Math.PI*713*t)+0.07*Math.sin(2*Math.PI*6211*t));}
    left[0]=1;right[0]=-0.5;
    if(process.argv.includes('--impulse')){left.fill(0);right.fill(0);left[0]=1;right[0]=-0.5;}
    const input=[Array.from(new Uint32Array(left.buffer)),Array.from(new Uint32Array(right.buffer))];
    const only=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7).split(',');
    const scenarios=[...Object.keys(factories).filter(type=>!only||only.includes(type)).map(type=>({mode:'slot',effects:[type,'none','none','none']})),...(!only||only.includes('graph')?[{mode:'graph',effects:['none','centerCancel','oneShotDelay','isolator'],multi:true},{mode:'graph',effects:['none','centerCancel','oneShotDelay','isolator'],multi:true,skipMaster:true},{mode:'graph',effects:['none','none','none','none'],multi:true,skipMaster:true},{mode:'graph',effects:['none','none','none','none'],multi:true},{mode:'graph',effects:['delay','none','none','none'],multi:false},{mode:'graph',effects:['none','none','none','none'],padActive:false}]:[])];
    if(process.argv.includes('--diagnose-corners'))for(const effects of [['none','centerCancel','none','none'],['none','none','oneShotDelay','none'],['none','none','none','isolator'],['isolator','isolator','isolator','isolator']])scenarios.push({mode:'graph',effects,multi:true,skipMaster:true});
    if(!only||only.includes('graph'))scenarios.push({mode:'graph',effects:['none','centerCancel','none','centerCancel'],multi:true,updates:[{frame:512,x:0.8,y:0.2},{frame:1152,x:0.1,y:0.9},{frame:2048,multi:false},{frame:4096,multi:true,x:0.6,y:0.4}]});
    if(!only)for(const type of ['isolator','filterDrive','equalizer','duckComp','delay','oneShotDelay','chorus'])scenarios.push({mode:'slot',effects:[type,'none','none','none'],updates:[{frame:512,x:0.8,y:0.2},{frame:4096,x:0.1,y:0.9},{frame:8192,x:0.6,y:0.4}]});
    for(const scenario of scenarios){
      const request={sampleRate:rate,x:0.3,y:0.65,held:true,input,...scenario};
      const expected=await page.evaluate(async({request,code,factories})=>{
        const api=new Function(code+';return {factories:{'+Object.entries(factories).map(([key,name])=>JSON.stringify(key)+':'+name).join(',')+'},pad:createFxPadEngine,leveler:createLevelComp};')();
        const ctx=new OfflineAudioContext(2,request.input[0].length,request.sampleRate),buffer=ctx.createBuffer(2,request.input[0].length,request.sampleRate);
        for(let c=0;c<2;++c)buffer.getChannelData(c).set(new Float32Array(Uint32Array.from(request.input[c]).buffer));
        const source=ctx.createBufferSource();source.buffer=buffer;
        if(request.mode==='slot'){
          const type=request.effects[0],effect=api.factories[type](ctx,type==='overdrive'?4:type==='fuzz'?8:type==='distortion'?2:undefined);
          effect.update(request.x,request.y,request.held);source.connect(effect.in);effect.out.connect(ctx.destination);
          let current={...request};for(const update of request.updates||[])ctx.suspend(update.frame/request.sampleRate).then(()=>{current={...current,...update};effect.update(current.x,current.y,current.held);void ctx.resume();});
        }else{
          const pad=await api.pad(ctx);for(let i=0;i<4;++i)await pad.setEffect(i,request.effects[i]);pad.setMultiMode(!!request.multi);pad.triggerCorner(request.x,request.y,request.held);
          let current={...request};
          for(const update of request.updates||[])ctx.suspend(update.frame/request.sampleRate).then(()=>{const previous=current;current={...current,...update};if(current.multi!==previous.multi)pad.setMultiMode(current.multi);pad.triggerCorner(current.x,current.y,current.held);void ctx.resume();});
          if(request.padActive===false)source.connect(api.leveler(ctx)).connect(ctx.destination);
          else{source.connect(pad.nodeIn);if(request.skipMaster)pad.nodeOut.connect(ctx.destination);else pad.nodeOut.connect(api.leveler(ctx)).connect(ctx.destination);}
        }
        source.start();const output=await ctx.startRendering();return [Array.from(output.getChannelData(0)),Array.from(output.getChannelData(1))];
      },{request,code,factories});
      const file=path.join(folder,'request.json'),output=path.join(folder,'native.f32');await writeFile(file,JSON.stringify(request));
      const native=spawnSync(probe,['--render',file,output],{encoding:'utf8'});assert.equal(native.status,0,native.stdout+native.stderr);
      const bytes=await readFile(output);assert.equal(bytes.length,length*8);let largest=0,errorEnergy=0,energy=0,worstFrame=0;
      for(let n=0;n<length;++n)for(let c=0;c<2;++c){const reference=expected[c][n],value=bytes.readFloatLE((n*2+c)*4),difference=value-reference;assert(Number.isFinite(value));if(Math.abs(difference)>largest){largest=Math.abs(difference);worstFrame=n;}errorEnergy+=difference*difference;energy+=reference*reference;}
      assert(energy>1e-8,'Reference render is silent; the fixture must include the effect response');
      const normalizedRms=Math.sqrt(errorEnergy/energy);const result={rate,...scenario,maxError:largest,normalizedRms};results.push(result);
      console.log(JSON.stringify(result));
      if(process.argv.includes('--impulse'))console.log(JSON.stringify({reference:expected[0].flatMap((v,i)=>Math.abs(v)>0.0001?[[i,v]]:[]).slice(0,20),native:Array.from({length},(_,i)=>[i,bytes.readFloatLE(i*8)]).filter(([,v])=>Math.abs(v)>0.0001).slice(0,20)}));
      // Browser SIMD delay read-position arithmetic and oscillator phase tables
      // vary by platform. Keep a separate, explicit numerical envelope for LFO
      // stages; static routing/filter/dynamics comparisons stay much tighter.
      const modulated=scenario.effects.some(type=>['chorus','flanger','pitch','octave','chromPitchShift','pitchFine','ringMod','autopan','tremoloPan','wah'].includes(type));
      if(!process.argv.includes('--report-only'))assert(largest<(modulated?0.005:0.0001)&&normalizedRms<(modulated?0.001:0.0001),'Browser/native FX mismatch: '+JSON.stringify({...result,worstFrame}));
    }
  }
  console.log(`${process.argv.includes('--report-only')?'DIAGNOSTIC ONLY':'PASS'}: ${results.length} original Web Audio effect/graph comparisons`);
}finally{await browser?.close();await rm(folder,{recursive:true,force:true});}
