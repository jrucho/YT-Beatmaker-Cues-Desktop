// Shared mobile UI/bridge regression checks. Set MUSIKE_TEST_PLATFORM=ios to exercise WK message/reply audio.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "../server/node_modules/esbuild/lib/main.js";
import { chromium } from "playwright";

const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { MemoryRouter } from 'react-router';
      import Cues from './src/views/Cues';
      import { usePlayer } from './src/player/player';
      import { useCueStore } from './src/mobile/cueStore';
      import { useUi } from './src/stores/ui';
      import { useShortcuts } from './src/hooks/useShortcuts';
      import { usePadSamples } from './src/mobile/padSamples';
      window.fixture = { player: usePlayer, cues: useCueStore, ui: useUi, samples:usePadSamples };
      function Keyboard() { useShortcuts(); return null; }
      createRoot(document.getElementById('root')).render(<MemoryRouter><Keyboard /><Cues /></MemoryRouter>);
    `,
    resolveDir: fileURLToPath(new URL("../web", import.meta.url)),
    loader: "tsx",
  },
  bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
  define: { __APP_VERSION__: '"test"', "process.env.NODE_ENV": '"development"', 'import.meta.env.VITE_TV': '"0"' },
});
const platform = process.env.MUSIKE_TEST_PLATFORM ?? "android";
const server = createServer((req, res) => {
  if (req.url === "/fixture.js") {
    res.setHeader("content-type", "text/javascript");
    return res.end(bundle.outputFiles[0].text);
  }
  if (req.url.startsWith("/api/")) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ favorites: [], history: [], playlists: [] }));
  }
  res.setHeader("content-type", "text/html");
  res.end('<html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  });
  const page = await browser.newPage({ hasTouch: true, viewport: { width: 420, height: 1100 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript((platform) => {
    window.__pluginHosted = new URL(location.href).searchParams.get('hosted') === '1';
    if (platform === "android") window.androidBridge = {};
    const listeners = {};
    window.emitMidi = message => listeners.MusikeMidi?.(message);
    window.nativeFixture = { calls: [], position: 0, sourceId: 0, queue: { tracks: [], index: 0, repeat: "off" }, eventsEnabled: true };
    window.sampleFixture = [];
    window.__pluginInvoke = async (name, request) => {
      if(name === 'waveform') return {peaks:Array.from({length:1024},(_,i)=>.1+(i%20)/20),progress:1};
      if(name === 'padSamples') return window.sampleFixture;
      if(name !== 'padSample') throw Error(`Unexpected native method ${name}`);
      window.nativeFixture.calls.push({method:'padSample',...request});
      if(request.cmd === 'trigger') return true;
      window.sampleFixture=window.sampleFixture.filter(p=>p.bank!==request.bank||p.pad!==request.pad);
      if(request.cmd === 'load') window.sampleFixture.push({bank:request.bank,pad:request.pad,name:'Kick fixture',duration:.5,ready:true});
      return window.sampleFixture;
    };
    window.emitAudio = (event, data = {}) => {
      if (!window.nativeFixture.eventsEnabled) return;
      const payload = { sourceId: window.nativeFixture.sourceId, ...data };
      if (listeners.MusikeAudio) listeners.MusikeAudio({ event, ...payload });
      else window.__musikeAudioEvent?.(event, payload);
    };
    window.audioSnapshot = () => {
      const state = window.nativeFixture;
      const track = state.queue.tracks[state.queue.index];
      return { sourceId: state.sourceId, queueIndex: state.queue.index, trackId: track?.id, url: state.url,
        position: state.position, duration: 60, buffered: state.url ? 60 : 0, playing: !!state.url, ready: !!state.url,
        loop: track?.loop ?? { from: null, to: null, on: false } };
    };
    window.nativeEnd = () => {
      const state = window.nativeFixture;
      if (state.queue.repeat !== "one") {
        if (state.queue.index + 1 < state.queue.tracks.length) state.queue.index++;
        else if (state.queue.repeat === "all") state.queue.index = 0;
        else return;
      }
      state.position = 0;
      state.url = `https://fixture.invalid/${state.queue.tracks[state.queue.index].id}.m4a`;
      window.emitAudio("track", window.audioSnapshot());
    };
    const audioMethods = ["setSource", "setQueue", "snapshot", "play", "pause", "seek", "cue", "position", "loop", "volume", "muted", "rate"];
    window.Capacitor = {
      PluginHeaders: [
        { name: "MusikeAudio", methods: [...audioMethods.map(name => ({ name, rtype: "promise" })), { name: "addListener", rtype: "callback" }] },
        { name: "MusikeMidi", methods: [{ name: "list", rtype: "promise" }, { name: "addListener", rtype: "callback" }, { name: "removeListener", rtype: "promise" }] },
      ],
      nativeCallback(plugin, method, _options, callback) {
        if (method === "addListener") listeners[plugin] = callback;
        return "fixture-listener";
      },
      async nativePromise(plugin, method, args) {
        if (plugin === "MusikeMidi") return { devices: [] };
        const state = window.nativeFixture;
        state.calls.push({ method, ...args });
        switch (method) {
          case "setSource":
            state.sourceId = args.sourceId;
            state.position = args.startAt ?? 0;
            state.url = args.url;
            if (args.queue) state.queue = structuredClone(args.queue);
            queueMicrotask(() => window.emitAudio("ready", { duration: 60 }));
            break;
          case "setQueue": {
            if (args.sourceId !== state.sourceId) break;
            const current = state.queue.tracks[state.queue.index]?.id;
            const index = args.queue.tracks.findIndex(t => t.id === current);
            state.queue = structuredClone(args.queue);
            if (index >= 0) state.queue.index = index;
            break;
          }
          case "snapshot": return window.audioSnapshot();
          case "play": window.emitAudio("playing"); break;
          case "pause": window.emitAudio("pause"); break;
          case "cue":
          case "seek":
            state.position = args.to;
            window.emitAudio("seeked", { position: args.to });
            if (method === "cue") window.emitAudio("playing");
            if (method === "cue" && args.pad) window.emitAudio("pad", { bank: args.bank, pad: args.pad });
            break;
          case "position": return { position: state.position };
        }
        return {};
      },
    };
    if (platform === "ios") {
      window.webkit = { messageHandlers: {
        bridge: { postMessage() {} },
        musikeAudio: { postMessage: ({ cmd, ...args }) => Promise.resolve().then(() => window.Capacitor.nativePromise("MusikeAudio", cmd === "load" ? "setSource" : cmd === "queue" ? "setQueue" : cmd, args)) },
      } };
    }
  }, platform);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.fixture);
  await page.evaluate(() => window.fixture.player.getState().playList([
    { id: "testaudio00", title: "Cue fixture", artist: "Test", duration: 60, kind: "song", thumb: "", art: "" },
  ]));
  await page.waitForFunction(() => window.fixture.player.getState().status === "playing");
  const pad = n => page.getByRole("button", { name: new RegExp(`^Pad ${n}: (?:Empty|\\d)`) });
  const position = async (actual, displayed = actual) => page.evaluate(({ actual, displayed }) => {
    window.nativeFixture.position = actual;
    window.emitAudio("time", { position: displayed, duration: 60 });
  }, { actual, displayed });

  await position(5.125, 4.8);
  await pad(1).tap();
  await page.waitForFunction(() => window.fixture.cues.getState().cues[1] === 5.125);
  const loadCount = await page.evaluate(() => window.nativeFixture.calls.filter(c => c.method === "setSource").length);
  await position(22);
  // A saved cue fires on DOWN, before a click or finger release.
  const padBox = await pad(1).boundingBox();
  await page.mouse.move(padBox.x + padBox.width / 2, padBox.y + padBox.height / 2);
  await page.mouse.down();
  assert.equal(await pad(1).getAttribute("data-pad-state"), "pressed", "Touch/mouse pad reacts before release");
  await page.waitForFunction(() => window.nativeFixture.calls.some(c => c.method === "cue" && c.to === 5.125));
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[aria-label^="Pad 1:"]')?.dataset.padState !== "pressed");
  assert.equal(await page.evaluate(() => window.nativeFixture.position), 5.125, "Cue lands on its saved fractional timestamp");
  assert.equal(await page.evaluate(() => window.nativeFixture.calls.filter(c => c.method === "setSource").length), loadCount, "Cue does not reload the track");
  await position(17.25);
  await page.keyboard.press('3');
  await page.waitForFunction(()=>window.fixture.cues.getState().cues[3]===17.25);
  await page.evaluate(()=>window.fixture.cues.getState().clearCue(3));
  await page.keyboard.press('Meta+2');
  await page.waitForFunction(()=>window.fixture.cues.getState().cues[2]===17.25);
  await position(25);
  await page.keyboard.press('2');
  await page.waitForFunction(()=>window.nativeFixture.position===17.25);
  await page.evaluate(()=>window.fixture.cues.getState().clearCue(2));

  await position(7.375, 7.1);
  await page.getByRole("button", { name: "Set IN", exact: true }).tap();
  await page.waitForFunction(() => window.fixture.player.getState().loop.from === 7.375);
  await position(10.875, 10.6);
  await page.getByRole("button", { name: "Set OUT", exact: true }).tap();
  await page.waitForFunction(() => window.fixture.player.getState().loop.to === 10.875);
  assert.deepEqual(await page.evaluate(() => window.fixture.player.getState().loop), { from: 7.375, to: 10.875, on: true }, "IN/OUT capture the native playhead and enable the loop");
  await page.waitForFunction(() => window.nativeFixture.calls.some(c => c.method === "loop" && c.on && c.from === 7.375 && c.to === 10.875));
  await pad(1).tap();
  assert.equal(await page.evaluate(() => window.fixture.player.getState().loop.on), false, "Cue outside the loop exits it instead of returning to IN");
  assert.equal(await page.evaluate(() => window.nativeFixture.position), 5.125);

  await position(18.625, 18.4);
  await pad(1).scrollIntoViewIfNeeded();
  const heldPad = await pad(1).boundingBox();
  await page.mouse.move(heldPad.x + heldPad.width / 2, heldPad.y + heldPad.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => window.fixture.cues.getState().cues[1] === 18.625);
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.fixture.cues.getState().cues[1]), 18.625, "Long-press overwrite captures the position before jumping to the old cue");

  await page.getByRole("button", { name: "B", exact: true }).tap();
  for (const [padNumber, at] of [[1, 0], [2, 2.25], [3, 4.5]]) {
    await position(at);
    await page.getByRole("button", { name: `Mark pad ${padNumber}`, exact: true }).tap();
    await page.waitForFunction(({ padNumber, at }) => window.fixture.cues.getState().cues[padNumber] === at, { padNumber, at });
  }
  assert.deepEqual(await page.evaluate(() => window.fixture.cues.getState().cues), { 1: 0, 2: 2.25, 3: 4.5 }, "Mark advances through pads without overwriting earlier marks, including a cue at zero");
  await page.getByRole("button", { name: "Pad 2: Close", exact: true }).tap();
  await position(6.75);
  await page.getByRole("button", { name: "Mark pad 2", exact: true }).tap();
  await page.waitForFunction(() => window.fixture.cues.getState().cues[2] === 6.75);
  assert.equal(await page.evaluate(() => window.fixture.cues.getState().cues[1]), 0, "Mark fills a cleared pad without replacing pad 1");
  for (let padNumber = 4; padNumber <= 16; padNumber++) {
    await position(padNumber * 2);
    await page.getByRole("button", { name: `Mark pad ${padNumber}`, exact: true }).tap();
  }
  await position(33.5);
  await page.getByRole("button", { name: "Mark pad 1", exact: true }).tap();
  await page.waitForFunction(() => window.fixture.cues.getState().bank === "C" && window.fixture.cues.getState().cues[1] === 33.5);
  assert.equal(await page.evaluate(() => window.fixture.player.getState().status), "playing", "Sequential marking does not interrupt playback");
  assert.equal(await page.evaluate(() => window.nativeFixture.calls.filter(c => c.method === "setSource").length), loadCount, "Sequential marking never reloads the source");
  await page.getByRole("button", { name: "C", exact: true }).tap();
  await page.getByRole("button", { name: "Clear bank", exact: true }).tap();
  await position(11.125);
  await page.getByRole("button", { name: "Mark pad 1", exact: true }).tap();
  await page.waitForFunction(() => window.fixture.cues.getState().cues[1] === 11.125);
  await page.getByRole("button", { name: "A", exact: true }).tap();
  assert.equal(await page.evaluate(() => window.fixture.cues.getState().cues[1]), 18.625, "Sequential marking stays within the selected bank");

  await position(14.25);
  await page.evaluate(() => window.emitMidi({ type: "noteon", channel: 3, note: 48, velocity: 101 }));
  await page.waitForFunction(() => window.fixture.cues.getState().bank === "D" && window.fixture.cues.getState().cues[1] === 14.25);
  await position(25);
  await page.evaluate(() => window.emitMidi({ type: "noteon", channel: 3, note: 48, velocity: 77 }));
  await page.waitForFunction(() => window.nativeFixture.position === 14.25);
  await page.evaluate(() => window.emitMidi({ type: "noteoff", channel: 3, note: 48, velocity: 0 }));
  await page.waitForFunction(() => document.querySelector('[aria-label^="Pad 1:"]')?.dataset.padState !== "pressed");
  assert.equal(await page.evaluate(() => window.fixture.player.getState().status), "playing", "Note Off preserves one-shot cue playback");

  const fader = page.locator('input[type="range"]');
  await page.evaluate(() => window.fixture.player.getState().setSpeed(0));
  await fader.focus();
  await fader.press("ArrowRight");
  await page.waitForFunction(() => window.fixture.player.getState().speed === 1);
  await page.waitForFunction(() => window.nativeFixture.calls.some(c => c.method === "rate" && c.value === 1.01 && c.preservePitch));
  await fader.press("ArrowRight");
  assert.equal(await page.evaluate(() => window.fixture.player.getState().speed), 2, "Pitch-kept fader advances in 1% steps");
  await page.evaluate(() => window.fixture.player.getState().setSpeed(30));
  await page.getByRole("button", { name: "One semitone up" }).tap();
  await page.waitForFunction(() => window.nativeFixture.calls.some(c => c.method === "rate" && c.value === 1.3 && c.preservePitch && c.semitones === 1));
  assert.equal(await page.evaluate(() => window.fixture.player.getState().speed), 30, "Tuning leaves the speed fader unchanged");
  await page.getByRole("button", { name: "Pitch (varispeed)", exact: true }).tap();
  assert.equal(await page.getByRole("button", { name: "One semitone up" }).count(), 0, "Varispeed has only its fader");
  await page.evaluate(() => window.fixture.player.getState().setSpeed(0));
  await fader.focus();
  await fader.press("ArrowLeft");
  await page.waitForFunction(() => window.fixture.player.getState().speed === -1);
  await page.waitForFunction(() => window.nativeFixture.calls.some(c => c.method === "rate" && c.value === 0.99 && !c.preservePitch));
  assert.equal(await page.evaluate(() => window.fixture.player.getState().tuning), 1, "Fine varispeed changes preserve the independent tuning setting");
  await page.getByRole("button", { name: "Speed (pitch kept)", exact: true }).tap();
  await page.evaluate(() => { window.fixture.player.getState().setSpeed(35); window.fixture.player.getState().setTuning(2); });
  await fader.scrollIntoViewIfNeeded();
  const box = await fader.boundingBox();
  await page.touchscreen.tap(box.x + box.width * 0.7, box.y + box.height / 2);
  await page.touchscreen.tap(box.x + box.width * 0.7, box.y + box.height / 2);
  assert.equal(await page.evaluate(() => window.fixture.player.getState().speed), 0, "Double tapping the fader resets speed");
  assert.equal(await page.evaluate(() => window.fixture.player.getState().tuning), 2, "Fader reset preserves independent tuning");

  await page.evaluate(() => {
    window.fixture.player.getState().playTrack({ id: "testaudio01", title: "Loading cue fixture", artist: "Test", duration: 60, kind: "song", thumb: "", art: "" });
    window.fixture.player.getState().cue(9.375);
  });
  await page.waitForFunction(() => window.fixture.player.getState().status === "playing");
  await page.waitForFunction(() => window.nativeFixture.calls.filter(c => c.method === "setSource").at(-1)?.startAt === 9.375);
  assert.equal(await page.evaluate(() => window.nativeFixture.position), 9.375, "A cue during source preparation is carried into the native load, never started from zero");

  await page.evaluate(() => window.fixture.player.getState().playList([0, 1, 2].map(n => ({
    id: `background${n}`, title: `Background ${n}`, artist: "Test", duration: 60, kind: "song", thumb: "", art: "",
  }))));
  await page.waitForFunction(() => window.fixture.player.getState().status === "playing");
  const backgroundLoads = await page.evaluate(() => window.nativeFixture.calls.filter(c => c.method === "setSource").length);
  await page.evaluate(() => window.nativeEnd());
  await page.waitForFunction(() => window.fixture.player.getState().index === 1);
  assert.equal(await page.evaluate(() => window.nativeFixture.calls.filter(c => c.method === "setSource").length), backgroundLoads, "A native track change is adopted without reloading it from JavaScript");
  await page.evaluate(() => {
    window.nativeFixture.eventsEnabled = false;
    window.nativeEnd();
    window.nativeFixture.position = 12.75;
  });
  assert.equal(await page.evaluate(() => window.fixture.player.getState().index), 1, "The UI can miss events while its WebView is suspended");
  await page.evaluate(() => { window.nativeFixture.eventsEnabled = true; document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForFunction(() => window.fixture.player.getState().index === 2 && window.fixture.player.getState().position === 12.75);
  assert.equal(await page.evaluate(() => window.nativeFixture.calls.filter(c => c.method === "setSource").length), backgroundLoads, "Foreground reconciliation keeps the native song and exact playhead without replaying an old track");

  await page.evaluate(() => {
    const oldSource = window.nativeFixture.sourceId;
    window.__musikeAudioEl.src = "https://fixture.invalid/next.m4a";
    window.emitAudio("time", { sourceId: oldSource, position: 49 });
    window.emitAudio("seeked", { sourceId: oldSource, position: 49 });
  });
  assert.notEqual(await page.evaluate(() => window.__musikeAudioEl.currentTime), 49, "Late events from the previous source are ignored");

  await page.evaluate(() => {
    window.fixture.player.setState({ position: 23.75, status: "paused" });
    window.dispatchEvent(new Event("pagehide"));
  });
  await page.reload();
  await page.waitForFunction(() => window.fixture);
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.fixture.player.getState().position), 23.75, "Cold native snapshot preserves saved resume position");
  await page.evaluate(() => window.fixture.player.getState().toggle());
  await page.waitForFunction(() => window.fixture.player.getState().status === "playing");
  assert.equal(await page.evaluate(() => window.nativeFixture.calls.find(c => c.method === "setSource")?.startAt), 23.75, "First Play after reopen loads the song at its saved position");
  await page.getByLabel("Pad layout preset", { exact: true }).selectOption("legacy12");
  assert.equal(await page.getByRole("button", { name: /^Pad \d+: (?:Empty|\d)/ }).count(), 12, "Legacy preset displays twelve pads");
  assert(await pad(1).evaluate(button => button.parentElement.parentElement.classList.contains("grid-cols-3")), "Legacy mobile grid selects three-column layout");
  assert.deepEqual(await page.getByRole("button", { name: /^Pad \d+: (?:Empty|\d)/ }).evaluateAll(pads => pads.map(pad => Number(pad.getAttribute("aria-label").match(/^Pad (\d+)/)[1]))), Array.from({ length: 12 }, (_, i) => i + 1), "Legacy pads follow row-major order 1–3, 4–6, 7–9, 10–12");
  await page.evaluate(() => {
    const store = window.fixture.cues.getState();
    store.setBank("H"); store.setCue(13, 44);
    for (let pad = 1; pad <= 12; pad++) store.setCue(pad, pad);
  });
  await position(31.25);
  await page.getByRole("button", { name: "Mark pad 1", exact: true }).tap();
  await page.waitForFunction(() => window.fixture.cues.getState().bank === "I" && window.fixture.cues.getState().cues[1] === 31.25);
  await page.reload();
  await page.waitForFunction(() => window.fixture);
  assert.equal(await page.getByLabel("Pad layout preset", { exact: true }).inputValue(), "legacy12", "Controller preset survives reopening");
  assert.equal(await page.getByRole("button", { name: /^Pad \d+: (?:Empty|\d)/ }).count(), 12, "Reopened legacy grid still has twelve pads");
  await page.getByLabel("Pad layout preset", { exact: true }).selectOption("sp404mkii-a");
  await page.evaluate(() => window.fixture.cues.getState().setBank("H"));
  assert.equal(await page.getByRole("button", { name: /^Pad \d+: (?:Empty|\d)/ }).count(), 16);
  assert.equal(await page.evaluate(() => window.fixture.cues.getState().cues[13]), 44, "Hidden extended cues survive legacy mode");
  await page.evaluate(()=>window.fixture.player.getState().playList([{id:'testaudio00',title:'First playlist song',artist:'Test',duration:60,kind:'song',thumb:'',art:''},{id:'testaudio01',title:'Second playlist song',artist:'Test',duration:60,kind:'song',thumb:'',art:''}]));
  await page.getByRole('button',{name:'Toggle playlist',exact:true}).click();
  assert.equal(await page.getByRole('region',{name:'Playlist songs',exact:true}).locator('li').count(),2);
  await page.getByRole('region',{name:'Playlist songs',exact:true}).getByRole('button',{name:'Play Second playlist song',exact:true}).click();
  await page.waitForFunction(()=>window.fixture.player.getState().index===1);
  assert.equal(await page.evaluate(()=>window.fixture.player.getState().queue.length),2,'Song selection retains the selected playlist');
  await page.addStyleTag({content:'.cue-waveform{position:relative;width:360px;height:80px}.cue-waveform canvas{width:100%;height:80px}.cue-wave-marker{position:absolute;top:0;height:70px;width:16px;transform:translateX(-50%)}'});
  await page.evaluate(()=>{window.__pluginInvoke=async()=>({peaks:Array.from({length:1024},(_,i)=>.1+(i%20)/20),progress:1});window.fixture.cues.getState().setBank('A');window.fixture.cues.getState().setCue(1,10);window.fixture.cues.getState().setCue(2,20);});
  await page.getByRole('slider',{name:'Move cue A1',exact:true}).waitFor();
  const wave=await page.getByLabel('Song waveform',{exact:true}).boundingBox();
  const marker=await page.getByRole('slider',{name:'Move cue A1',exact:true}).boundingBox();
  await page.mouse.move(marker.x+marker.width/2,marker.y+30);await page.mouse.down();await page.mouse.move(wave.x+wave.width/2,wave.y+30);await page.mouse.up();
  await page.waitForFunction(()=>Math.abs(window.fixture.cues.getState().cues[1]-30)<.1);
  await page.getByRole('slider',{name:'Move cue A2',exact:true}).dblclick();
  assert.equal(await page.evaluate(()=>window.fixture.cues.getState().cues[2]),undefined,'Double-click erases a waveform cue');
  assert(await page.evaluate(() => {
    window.fixture.ui.setState({menu:null,addToPlaylist:null});
    const before = window.fixture.player.getState().shuffle;
    window.dispatchEvent(new KeyboardEvent('keydown', {key:'s',code:'KeyS',bubbles:true,cancelable:true}));
    return window.fixture.player.getState().shuffle !== before;
  }), 'Standalone keeps player keyboard shortcuts');

  await page.goto(`http://127.0.0.1:${server.address().port}/?hosted=1`);
  await page.waitForFunction(() => window.fixture);
  await page.evaluate(() => window.fixture.player.getState().playList([
    { id: 'hostedtest0', title: 'DAW keyboard fixture', artist: 'Test', duration: 60, kind: 'song', thumb: '', art: '' },
  ]));
  await page.waitForFunction(() => window.fixture.player.getState().status === 'playing');
  await page.evaluate(() => { window.fixture.cues.getState().setBank('A'); window.fixture.cues.getState().setCue(1, 5.125); });
  const hostedKeys = await page.evaluate(() => {
    const snapshot = () => {
      const p = window.fixture.player.getState(), ui = window.fixture.ui.getState();
      return JSON.stringify({ shuffle:p.shuffle, repeat:p.repeat, muted:p.muted, volume:p.volume, position:p.position,
        status:p.status, preferVideo:p.preferVideo, loop:p.loop, cues:window.fixture.cues.getState().cues,
        panel:ui.panelOpen, drawer:ui.drawerOpen, shortcuts:ui.shortcutsOpen, theater:ui.theater, route:location.href });
    };
    const before = snapshot(), cancelled = [];
    for (const key of [...'abcdefghijklmnopqrstuvwxyz-', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '/', '?']) {
      for (const modifiers of [{}, {shiftKey:true}, {ctrlKey:true}]) {
        const event = new KeyboardEvent('keydown', {key, code:key === ' ' ? 'Space' : /^[0-9]$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, bubbles:true, cancelable:true, ...modifiers});
        if (!window.dispatchEvent(event)) cancelled.push(key);
      }
    }
    return {before, after:snapshot(), cancelled};
  });
  assert.equal(hostedKeys.after, hostedKeys.before, 'DAW letter/transport keys do not alter player/UI/cues in hosted mode');
  assert.deepEqual(hostedKeys.cancelled, [], 'Hosted player never prevents DAW keyboard shortcuts');
  await position(21.125);await page.keyboard.press('1');
  await page.waitForFunction(()=>window.nativeFixture.position===5.125);
  await position(18.75);await page.keyboard.press('3');
  await page.waitForFunction(()=>window.fixture.cues.getState().cues[3]===18.75);
  await position(24.125);await page.keyboard.press('Control+3');
  await page.waitForFunction(()=>window.fixture.cues.getState().cues[3]===24.125);
  await page.keyboard.press('Shift+4');
  await page.waitForFunction(()=>window.fixture.cues.getState().cues[14]===24.125);
  await page.evaluate(()=>{window.fixture.cues.getState().clearCue(3);window.fixture.cues.getState().clearCue(14);});
  await pad(1).tap();
  await page.waitForFunction(() => window.nativeFixture.calls.some(c => c.method === 'cue' && c.to === 5.125));
  await position(12);
  await page.evaluate(() => window.emitMidi({type:'noteon',channel:0,note:48,velocity:100}));
  await page.waitForFunction(() => window.nativeFixture.position === 5.125);
  await page.getByRole('button',{name:'Manage pad samples',exact:true}).click();
  await pad(2).tap();
  await page.getByRole('button',{name:'Load sample…',exact:true}).click();
  const samplePad = page.getByRole('button',{name:'Pad 2: Sample Kick fixture',exact:true});
  await samplePad.waitFor();
  await page.getByRole('button',{name:'Manage pad samples',exact:true}).click();
  await position(19.25);
  await samplePad.tap();
  await page.waitForFunction(() => window.nativeFixture.calls.some(c=>c.method==='padSample'&&c.cmd==='trigger'&&c.pad===2));
  assert.equal(await page.evaluate(()=>window.nativeFixture.position),19.25,'Sample pad does not seek the song');
  assert.equal(await page.evaluate(()=>window.fixture.cues.getState().cues[2]),undefined,'Sample pad never marks a cue');
  await page.locator('.cue-overwrite-row>button:last-child').click();
  await page.evaluate(()=>window.emitMidi({type:'noteon',channel:0,note:49,velocity:100}));
  await page.waitForFunction(()=>window.nativeFixture.calls.filter(c=>c.method==='padSample'&&c.cmd==='trigger'&&c.pad===2).length>=2);
  assert.equal(await page.evaluate(()=>window.fixture.cues.getState().cues[2]),undefined,'MIDI overwrite does not mark sample pads');
  await page.evaluate(()=>window.fixture.player.setState({queue:[],index:0,status:'idle',position:0,duration:0}));
  await samplePad.tap();
  await page.waitForFunction(()=>window.nativeFixture.calls.filter(c=>c.method==='padSample'&&c.cmd==='trigger'&&c.pad===2).length>=3);
  await page.getByRole('button',{name:'Manage pad samples',exact:true}).click();
  await samplePad.tap();
  await page.getByRole('button',{name:'Remove sample',exact:true}).click();
  await page.getByRole('button',{name:'Manage pad samples',exact:true}).click();
  await page.evaluate(()=>window.fixture.player.getState().playList([{id:'cuefallback',title:'Cue fallback',artist:'Test',duration:60,kind:'song',thumb:'',art:''}]));
  await page.waitForFunction(()=>window.fixture.player.getState().status==='playing');
  await position(12.25);await pad(2).tap();
  await page.waitForFunction(()=>window.fixture.cues.getState().cues[2]===12.25);
  assert.deepEqual(errors, []);
  console.log(`PASS (${platform} bridge): cue editing/transport, standalone shortcuts, hosted DAW keyboard isolation, sample loading/touch/MIDI without a song or cue marking, removal and cue fallback.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
