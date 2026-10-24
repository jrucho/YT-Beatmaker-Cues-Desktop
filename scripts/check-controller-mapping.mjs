import assert from "node:assert/strict";
import { build } from "../server/node_modules/esbuild/lib/main.js";

const result = await build({ entryPoints: ["web/src/native/controllerMapping.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { SP404MKII, SP404MKII_B, LEGACY12, mapControllerMessage } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
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
assert.equal(mapControllerMessage({ type: "noteon", channel: -1, note: 48, velocity: 127 }, SP404MKII, "A"), null);
assert.equal(mapControllerMessage({ type: "cc", channel: 0, controller: 20, value: 0 }, SP404MKII, "A").pressed, false);
const custom = { id: "custom", label: "Custom", padToNote: [60, 64], bankChannels: { J: 16 } };
assert.deepEqual(mapControllerMessage({ type: "noteon", channel: 15, note: 64, velocity: 55 }, custom, "A"), { bank: "J", pad: 2, velocity: 55, pressed: true });
console.log("PASS: all 320 SP-404MKII Mode A/B pad/bank targets, Note Off, velocity-zero Note On, channel isolation, legacy 12 pads, CC releases and custom mappings.");
