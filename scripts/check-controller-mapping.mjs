import assert from "node:assert/strict";
import { build } from "../server/node_modules/esbuild/lib/main.js";

const result = await build({ entryPoints: ["web/src/native/controllerMapping.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { SP404MKII, SP404MKII_B, LEGACY12, LINEAR16, mapControllerMessage } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const layout = await build({ entryPoints: ["web/src/mobile/padLayout.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { padVisualOrder } = await import(`data:text/javascript;base64,${Buffer.from(layout.outputFiles[0].text).toString("base64")}`);
const preferences = await build({ entryPoints: ["web/src/mobile/midiPreferences.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const {BANK_PAIRS,nextPairedBank}=await import(`data:text/javascript;base64,${Buffer.from(preferences.outputFiles[0].text).toString("base64")}`);
assert.deepEqual(BANK_PAIRS.map(pair=>pair.join('/')),['A/F','B/G','C/H','D/I','E/J']);
assert.deepEqual([...BANK_PAIRS.flat()].sort(),'ABCDEFGHIJ'.split(''));
for(const [first,second] of BANK_PAIRS){assert.equal(nextPairedBank(first,first,second),second);assert.equal(nextPairedBank(second,first,second),first);assert.equal(nextPairedBank('outside',first,second),first);}
const notes = [48,49,50,51,44,45,46,47,40,41,42,43,36,37,38,39];
for (let bank = 0; bank < 10; bank++) {
  for (let pad = 1; pad <= 16; pad++) {
    const channel = bank < 5 ? 0 : 1;
    const note = 12 + bank % 5 * 16 + notes[pad - 1] - 36;
    const message = { type: "noteon", channel, note, velocity: 88 };
    const expected = { bank: "ABCDEFGHIJ"[bank], pad, velocity: 88, pressed: true };
    assert.deepEqual(mapControllerMessage(message, SP404MKII_B, "J"), expected);
    assert.deepEqual(mapControllerMessage({ ...message, type: "noteoff" }, SP404MKII_B, "A"), { ...expected, pressed: false });
    assert.equal(mapControllerMessage({ ...message, velocity: 0 }, SP404MKII_B, "A").pressed, false);
    assert.equal(mapControllerMessage({ ...message, channel: 2 }, SP404MKII_B, "A"), null);
  }
}
assert.equal(mapControllerMessage({ type: "cc", channel: 0, controller: 20, value: 127 }, SP404MKII_B, "A"), null);
for (let channel = 0; channel < 10; channel++) {
  for (let pad = 1; pad <= 16; pad++) {
    const message = { type: "noteon", channel, note: notes[pad - 1], velocity: 93 };
    const expected = { bank: "ABCDEFGHIJ"[channel], pad, velocity: 93, pressed: true };
    assert.deepEqual(mapControllerMessage(message, SP404MKII, "J"), expected);
    assert.deepEqual(mapControllerMessage({ ...message, type: "noteoff", velocity: 37 }, SP404MKII, "A"), { ...expected, velocity: 37, pressed: false });
    assert.equal(mapControllerMessage({ ...message, velocity: 0 }, SP404MKII, "A").pressed, false);
  }
}
for (let channel = 10; channel < 16; channel++) assert.equal(mapControllerMessage({ type: "noteon", channel, note: 48, velocity: 127 }, SP404MKII, "A"), null);
for (let pad = 1; pad <= 12; pad++) {
  assert.deepEqual(mapControllerMessage({ type: "noteon", channel: 15, note: 35 + pad, velocity: 127 }, LEGACY12, "F"), { bank: "F", pad, velocity: 127, pressed: true });
}
assert.equal(mapControllerMessage({ type: "noteon", channel: 0, note: 48, velocity: 127 }, LEGACY12, "A"), null);
for(let channel=0;channel<16;channel++)for(let bank=0;bank<10;bank++)for(let pad=1;pad<=16;pad++){
  const message={type:'noteon',channel,note:35+pad,velocity:92};
  const expected={bank:'ABCDEFGHIJ'[bank],pad,velocity:92,pressed:true};
  assert.deepEqual(mapControllerMessage(message,LINEAR16,expected.bank),expected);
  assert.deepEqual(mapControllerMessage({...message,type:'noteoff'},LINEAR16,expected.bank),{...expected,pressed:false});
  assert.deepEqual(mapControllerMessage({type:'cc',channel,controller:19+pad,value:92},LINEAR16,expected.bank),expected);
}
assert.equal(mapControllerMessage({type:'noteon',channel:0,note:52,velocity:127},LINEAR16,'A'),null);
assert.equal(mapControllerMessage({ type: "noteon", channel: -1, note: 48, velocity: 127 }, SP404MKII, "A"), null);
assert.equal(mapControllerMessage({ type: "cc", channel: 0, controller: 20, value: 0 }, SP404MKII, "A").pressed, false);
const custom = { id: "custom", label: "Custom", padToNote: [60, 64], bankChannels: { J: 16 } };
assert.deepEqual(mapControllerMessage({ type: "noteon", channel: 15, note: 64, velocity: 55 }, custom, "A"), { bank: "J", pad: 2, velocity: 55, pressed: true });
for(const [mapping,expected] of [[LINEAR16,[13,14,15,16,9,10,11,12,5,6,7,8,1,2,3,4]],[LEGACY12,[10,11,12,7,8,9,4,5,6,1,2,3]]]){
  const pads=mapping.padToNote.map((_,i)=>i+1);
  assert.deepEqual([...pads].sort((a,b)=>padVisualOrder(mapping,a,'top-left')-padVisualOrder(mapping,b,'top-left')),pads);
  assert.deepEqual([...pads].sort((a,b)=>padVisualOrder(mapping,a,'bottom-left')-padVisualOrder(mapping,b,'bottom-left')),expected);
  assert.equal(new Set(pads.map(pad=>padVisualOrder(mapping,pad,'bottom-left'))).size,pads.length);
  assert.deepEqual(mapControllerMessage({type:'noteon',channel:0,note:36,velocity:91},mapping,'D'),{bank:'D',pad:1,velocity:91,pressed:true},'Repositioning must retain note 36 on logical pad 1');
}
for(const mapping of [SP404MKII,SP404MKII_B])for(let pad=1;pad<=16;pad++)assert.equal(padVisualOrder(mapping,pad,'bottom-left'),pad-1,'SP-404 visual order must remain fixed');
for(const [mapping,columns,expected] of [[LINEAR16,8,[9,10,11,12,13,14,15,16,1,2,3,4,5,6,7,8]],[LEGACY12,6,[7,8,9,10,11,12,1,2,3,4,5,6]]]){
  const pads=mapping.padToNote.map((_,i)=>i+1);
  assert.deepEqual(pads.sort((a,b)=>padVisualOrder(mapping,a,'bottom-left',columns)-padVisualOrder(mapping,b,'bottom-left',columns)),expected,'Compact layout must still start pad 1 at the bottom left');
}
console.log("PASS: 320 Roland mappings, linear 16-pad notes/CCs on every channel/current bank, legacy 12 pads, both numbering origins with stable MIDI pad IDs, fixed SP-404 layouts, releases and custom mappings.");
