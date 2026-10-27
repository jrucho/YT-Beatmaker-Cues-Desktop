// Compare native DSP to the original worklet code, rather than a rewritten JS formula.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const probe=process.argv[2];if(!probe)throw Error('Usage: node scripts/check-native-effect-kernels.mjs <EffectKernelTests executable>');
const root=path.resolve(import.meta.dirname,'..'),processors=new Map();
const context=vm.createContext({AudioWorkletProcessor:class{constructor(){this.port={onmessage:null};}},registerProcessor:(name,processor)=>processors.set(name,processor)});
for(const file of ['bit-dec-worklet.js','bit12-proc-worklet.js'])vm.runInContext(await readFile(path.join(root,'YTbeatmakercues/worklets',file),'utf8'),context);
let random=0x12345678;const values=[0,-0,0.5,-0.5,1.5,-1.5,1,-1,2,-2];
for(let i=0;i<4096;++i){random=(Math.imul(random,1664525)+1013904223)>>>0;values.push((random/0xffffffff)*4-2);}
const input=Float32Array.from(values),inputBits=Array.from(new Uint32Array(input.buffer)),fixtures=[];
for(const kind of ['bitDecimator','bitCrash','twelveBit'])for(const amount of [0,0.0625-Number.EPSILON,0.0625,0.5,0.9375,1]){
  const node=new (processors.get(kind==='twelveBit'?'bit12-proc':'bit-dec'))();
  if(kind!=='twelveBit')node.port.onmessage({data:{bits:4+Math.round(8*(1-amount))}});
  const output=new Float32Array(input.length);node.process([[input]],[[output]]);
  fixtures.push({kind,amount,input:inputBits,expected:Array.from(new Uint32Array(output.buffer))});
}
const folder=await mkdtemp(path.join(tmpdir(),'beatmaker-fx-reference-'));
try{
  const file=path.join(folder,'worklets.json');await writeFile(file,JSON.stringify(fixtures));
  const result=spawnSync(path.resolve(probe),[file],{encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);console.log(result.stdout.trim());
}finally{await rm(folder,{recursive:true,force:true});}
