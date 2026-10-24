// End-to-end checks against the built app and a real, isolated Musike server.
// Only the external music catalog and remote media are replaced with deterministic fixtures.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "yt-beatmaker-check-"));
const probe = createServer();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(root, "server/node_modules/tsx/dist/cli.mjs"), path.join(root, "server/src/index.ts")], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MUSIKE_DATA_DIR: temporary },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
server.stderr.on("data", data => { serverOutput += data; });
server.stdout.on("data", data => { serverOutput += data; });
let browser;

const tracks = Array.from({ length: 12 }, (_, i) => ({
  id: `testaudio${String(i).padStart(2, "0")}`,
  title: ["Midnight Tapes", "Dome EP", "Calor", "Liminal", "Pyramid", "After Hours"][i % 6] + (i > 5 ? " II" : ""),
  artist: ["Studio Sessions", "The Night Shift", "Lime"][i % 3], duration: 30,
  art: `https://fixture.invalid/cover-${i}.svg`, thumb: `https://fixture.invalid/cover-${i}.svg`, kind: "song",
}));

function wave() {
  const rate = 44100, samples = rate * 30;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i / rate * 440 * 2 * Math.PI) * 1000), 44 + i * 2);
  return bytes;
}

function mediaResponse(route, bytes, contentType) {
  const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  return route.fulfill({ status: range ? 206 : 200, contentType,
    headers: { "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${bytes.length}` } : {}) },
    body: bytes.subarray(start, end + 1) });
}

try {
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) { healthy = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(healthy, `Test server did not start: ${serverOutput}`);
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    headless: true, args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
  const errors = [], failedAssets = [];
  page.on("pageerror", error => errors.push(error.stack));
  page.on("response", response => {
    if (response.url().includes("/beatmaker/") && response.status() >= 400) failedAssets.push(`${response.status()} ${response.url()}`);
  });
  page.on("dialog", dialog => dialog.dismiss());
  await page.addInitScript(() => {
    window.__playedMedia = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__playedMedia.push(this.src); return play.call(this); };
  });
  const queries = [];
  await page.route("https://fixture.invalid/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#32403b"/><circle cx="180" cy="170" r="90" fill="#9ca58d" opacity=".35"/></svg>' }));
  await page.route("**/api/search?*", route => {
    const q = new URL(route.request().url()).searchParams.get("q"); queries.push(q);
    return q === "failure" ? route.fulfill({ status: 503, json: { error: "Fixture catalog unavailable" } }) : route.fulfill({ json: { tracks: q === "empty" ? [] : tracks } });
  });
  await page.route("**/api/prepare/*", route => route.fulfill({ json: {} }));
  const youtubePlaylist = { id: "PLfixtureSampleCrate", title: "YouTube sample crate", author: "Fixture curator", thumb: tracks[0].thumb };
  await page.route("**/api/search/playlists?*", route => {
    const q = new URL(route.request().url()).searchParams.get("q");
    return q === "playlist-failure" ? route.fulfill({ status: 503, json: { error: "Playlist search unavailable" } }) : route.fulfill({ json: { playlists: [youtubePlaylist, ...Array.from({ length: 5 }, (_, n) => ({ ...youtubePlaylist, id: `${youtubePlaylist.id}${n}`, title: `Sample collection ${n + 1}` }))] } });
  });
  await page.route("**/api/youtube/playlists/*", route => route.fulfill({ json: { ...youtubePlaylist, tracks: tracks.slice(0, 2), truncated: false } }));
  const wav = wave();
  await page.route("**/api/stream/*/audio", route => mediaResponse(route, wav, "audio/wav"));

  await page.goto(`${origin}/?workspace=beatmaker`);
  await page.getByRole("heading", { name: "Find a sound. Make it yours." }).waitFor();
  await page.getByRole("button", { name: "Preview Midnight Tapes", exact: true }).waitFor();
  const globalPlayer = page.locator("footer.ds-player");
  assert(await globalPlayer.isVisible(), "Discovery shows the global player bar");
  for (const name of ["Previous track", "Next track"]) assert(await globalPlayer.getByRole("button", { name, exact: true }).isVisible(), `Global player exposes ${name}`);
  assert(await globalPlayer.getByRole("slider", { name: "Playback position", exact: true }).isVisible(), "Global player exposes the seek bar");
  assert(await globalPlayer.getByRole("slider", { name: "Discovery volume", exact: true }).isVisible(), "Global player exposes volume");
  assert(queries.includes("jazz instrumental"), "Opening discovery requests a real catalog search");
  for (const title of ["Soul & dust", "Jazz cuts", "Drum breaks", "Ambient spaces", "Rare grooves", "Global sounds"]) {
    await page.locator(".ds-crate").filter({ hasText: title }).click();
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
    await page.getByRole("button", { name: "Preview Midnight Tapes", exact: true }).waitFor();
  }
  await page.getByRole("button", { name: "Discover a random music category" }).click();
  await page.getByRole("button", { name: "Preview Midnight Tapes", exact: true }).waitFor();
  const discoverySearch = page.getByRole("textbox", { name: "Discover samples search" });
  await discoverySearch.fill("empty"); await page.getByRole("button", { name: "START DIGGING" }).click();
  await page.getByText("No matches", { exact: true }).waitFor();
  await discoverySearch.fill("failure"); await page.getByRole("button", { name: "START DIGGING" }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("Fixture catalog unavailable", { exact: true }).waitFor();

  for (const pack of ["kick", "snare", "hihat"]) {
    await page.locator(".ds-packs button").filter({ hasText: pack === "hihat" ? "Hi-hat collection" : `${pack === "kick" ? "Kick" : "Snare"} collection` }).click();
    assert.equal(await page.locator(".ds-sample").count(), 10, "Each real sample bank has ten hits");
    await page.getByRole("button", { name: `Preview ${pack} 1`, exact: true }).click();
    assert(await page.evaluate(path => window.__playedMedia.some(url => url.endsWith(path)), `/beatmaker/sounds/${pack}1.wav`), "Sample preview plays its bundled WAV");
    for (let n = 1; n <= 10; n++) {
      const response = await fetch(`${origin}/beatmaker/sounds/${pack}${n}.wav`);
      assert(response.ok, `Sample ${pack}${n} is packaged`);
      assert((await response.arrayBuffer()).byteLength > 44, "Sample file contains audio bytes");
    }
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: `Download ${pack} 1 WAV`, exact: true }).click();
    assert.equal((await download).suggestedFilename(), `${pack}1.wav`);
  }
  await discoverySearch.fill("Nujabes"); await page.getByRole("button", { name: "START DIGGING" }).click();
  await page.getByRole("button", { name: "Preview Midnight Tapes", exact: true }).click();
  await page.getByRole("button", { name: "Pause Midnight Tapes", exact: true }).waitFor();
  const discoverProgress = globalPlayer.getByRole("slider", { name: "Playback position", exact: true });
  const bar = await discoverProgress.boundingBox();
  assert(bar && bar.width > 100, "Global player seek bar spans the footer");
  await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.waitForFunction(() => {
    const value = Number(document.querySelector('footer.ds-player [aria-label="Playback position"]')?.getAttribute("aria-valuenow"));
    return value >= 12 && value <= 18;
  }, null, { timeout: 5000 });
  assert(await globalPlayer.getByRole("button", { name: "Add Midnight Tapes to favorites", exact: true }).isVisible(), "Global player favorites the active track");
  assert(await page.getByRole("button", { name: "Load Midnight Tapes into studio", exact: true }).first().isVisible(), "Track cards keep their direct studio action");
  const markCues = globalPlayer.getByRole("button", { name: "Open the studio to mark cues for Midnight Tapes", exact: true });
  assert(await markCues.isVisible(), "Global player offers cue marking");
  await page.getByRole("button", { name: "Save Midnight Tapes", exact: true }).click();
  await page.getByRole("button", { name: "Unsave Midnight Tapes", exact: true }).waitFor();
  assert((await (await fetch(`${origin}/api/library`)).json()).favorites.some(t => t.id === tracks[0].id), "Favorite button persists to the real library API");
  await markCues.click();
  await page.locator(".bm-footer").getByText("Ready", { exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Set cue 1", exact: true }).waitFor();
  await page.getByRole("button", { name: "Set cue 1", exact: true }).click();
  const firstCue = await page.evaluate(() => window.musikeBeatmakerEngine.snapshot().cues["1"]);
  assert(firstCue >= 10, "Marking cues opens the studio without restarting discovery playback");
  await page.locator("#bm-timeline .cue-marker").first().waitFor();
  await page.waitForFunction(() => {
    const pin = document.querySelector("#bm-timeline .cue-marker");
    return !!pin && getComputedStyle(pin).backgroundColor === "rgb(245, 245, 245)";
  });
  assert.equal(
    await page.evaluate(() => {
      const pin = document.querySelector("#bm-timeline .cue-marker");
      return pin ? getComputedStyle(pin).backgroundColor : "";
    }),
    "rgb(245, 245, 245)",
    "Cue pins are white on the studio timeline",
  );
  await page.getByRole("button", { name: "Set cue 11", exact: true }).click();
  await page.getByRole("button", { name: "B", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.musikeBeatmakerEngine.snapshot().cues), {}, "Banks are independent");
  await page.getByRole("button", { name: "Set cue 2", exact: true }).click();
  await page.getByRole("button", { name: "A", exact: true }).click();
  assert.equal(await page.evaluate(() => window.musikeBeatmakerEngine.snapshot().cues["1"]), firstCue);
  assert.equal(await page.locator(".bm-pad-hit").count(), 16, "Desktop has sixteen physical pads");
  await page.getByRole("button", { name: "D", exact: true }).click();
  for (let i = 0; i < 17; i++) await page.getByRole("button", { name: "MARK", exact: true }).click();
  await page.waitForFunction(() => window.musikeBeatmakerHost.cueId().endsWith(":bank:E"));
  assert.equal(await page.getByRole("button", { name: "E", exact: true }).getAttribute("aria-pressed"), "true", "Mark rollover updates visible bank");
  assert.equal(Object.keys(await page.evaluate(() => JSON.parse(localStorage.getItem("ytbm_cues_testaudio00:bank:D")))).length, 16, "Mark fills all sixteen pads without overwriting");
  await page.evaluate(() => window.musikeBeatmakerHost.midi([0x95, 48, 101]));
  await page.waitForFunction(() => window.musikeBeatmakerEngine.snapshot().cues["1"] != null);
  assert.equal(await page.evaluate(() => window.musikeBeatmakerHost.cueId()), "testaudio00:bank:F", "Mode A MIDI switches to channel bank and marks empty pad");
  const midiCue = await page.evaluate(() => window.musikeBeatmakerEngine.snapshot().cues["1"]);
  await page.evaluate(() => { window.musikeBeatmakerHost.media().currentTime = 20; window.musikeBeatmakerHost.midi([0x95, 48, 90]); window.musikeBeatmakerHost.midi([0x85, 48, 0]); });
  await page.waitForFunction(cue => Math.abs(window.musikeBeatmakerHost.media().currentTime - cue) < 1, midiCue);
  assert(Math.abs(await page.evaluate(() => window.musikeBeatmakerHost.media().currentTime) - midiCue) < 1, "MIDI retriggers a saved cue and Note Off preserves one-shot playback");
  await page.getByLabel("MIDI controller preset", { exact: true }).selectOption("sp404mkii-b");
  await page.evaluate(() => window.musikeBeatmakerHost.midi([0x91, 88, 110]));
  assert.equal(await page.evaluate(() => window.musikeBeatmakerHost.cueId()), "testaudio00:bank:J", "Mode B MIDI selects J1 from channel 2, note 88");
  await page.getByLabel("MIDI controller preset", { exact: true }).selectOption("sp404mkii-a");
  await page.getByLabel("MIDI controller preset", { exact: true }).selectOption("legacy12");
  assert.equal(await page.locator(".bm-pad-hit").count(), 12, "Desktop legacy preset displays twelve pads");
  await page.getByRole("button", { name: "D", exact: true }).click();
  await page.getByRole("button", { name: "MARK", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "E", exact: true }).getAttribute("aria-pressed"), "true", "Desktop legacy Mark rolls after twelve pads");
  await page.getByLabel("MIDI controller preset", { exact: true }).selectOption("sp404mkii-a");
  assert.equal(await page.locator(".bm-pad-hit").count(), 16);
  assert.equal(Object.keys(await page.evaluate(() => JSON.parse(localStorage.getItem("ytbm_cues_testaudio00:bank:D")))).length, 16, "Desktop extended cues survive legacy mode");
  await page.getByRole("button", { name: "A", exact: true }).click();
  await page.getByRole("slider", { name: "Playback position", exact: true }).fill("15");
  await page.locator(".bm-brand").click(); await page.keyboard.press("1"); await page.waitForTimeout(300);
  assert(Math.abs(await page.evaluate(() => window.musikeBeatmakerHost.media().currentTime) - firstCue) < 1, "Keyboard cue seeks the real player");
  await page.getByRole("slider", { name: "Pitch percentage", exact: true }).fill("12");
  assert.equal(await page.evaluate(() => window.musikeBeatmakerHost.media().playbackRate), 1.12);
  await page.getByRole("slider", { name: "Pitch percentage", exact: true }).fill("0");
  await page.getByRole("slider", { name: "Master volume" }).fill("0.4");
  assert.equal(await page.evaluate(() => window.musikeBeatmakerHost.media().volume), 0.4);
  await page.getByRole("button", { name: "Return to start", exact: true }).click();
  assert(await page.evaluate(() => window.musikeBeatmakerHost.media().currentTime) < 1);
  await page.getByRole("slider", { name: "Playback position", exact: true }).fill("3");
  await page.locator(".bm-brand").click(); await page.keyboard.press("i"); await page.waitForTimeout(150);
  await page.getByRole("slider", { name: "Playback position", exact: true }).fill("4");
  await page.locator(".bm-brand").click(); await page.keyboard.press("o"); await page.waitForTimeout(150);
  const region = await page.evaluate(async () => (await chrome.storage.local.get("ytbm-region-loop:youtube:testaudio00"))["ytbm-region-loop:youtube:testaudio00"]);
  assert(region.enabled && region.out > region.in, "IN/OUT keyboard actions enable a real persisted region loop");
  await page.keyboard.down("i"); await page.keyboard.down("o"); await page.keyboard.up("i"); await page.keyboard.up("o");
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(async () => (await chrome.storage.local.get("ytbm-region-loop:youtube:testaudio00"))["ytbm-region-loop:youtube:testaudio00"].enabled), false);
  await page.getByRole("button", { name: "Randomize cues" }).click();
  assert((await page.evaluate(() => Object.keys(window.musikeBeatmakerEngine.snapshot().cues).length)) >= 10);
  await page.getByRole("button", { name: "Guide", exact: true }).click(); await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog", { name: "Beatmaker guide" }).count(), 0);
  await page.getByRole("button", { name: "MAP", exact: true }).click();
  assert(await page.locator(".looper-midimap-container").filter({ hasText: "MIDI Mapping" }).isVisible(), "MAP opens actual MIDI mappings");
  await page.getByRole("button", { name: "MAP", exact: true }).click();
  await page.getByRole("button", { name: "CUES / LOOP", exact: true }).click();
  await page.locator("#ytbm-mini-bar").getByRole("button", { name: "Advanced", exact: true }).click();
  assert.equal(await page.locator("#ytbm-mini-bar").count(), 0, "Original Advanced action removes the compact bar");
  await page.getByRole("button", { name: "CUES / LOOP", exact: true }).click();
  assert(await page.locator("#ytbm-mini-bar").isVisible(), "Compact bar can be rebuilt after the original Advanced action");
  await page.getByRole("button", { name: "CUES / LOOP", exact: true }).click();
  for (const label of ["ADVANCED", "SEQUENCER", "FX PAD", "SIDECHAIN"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.waitForTimeout(150);
    await page.getByRole("button", { name: label, exact: true }).click();
  }
  await page.getByRole("button", { name: "ADVANCED", exact: true }).click();
  await page.locator(".looper-panel-container").getByRole("button", { name: "Percent", exact: true }).click();
  await page.getByRole("button", { name: "ADVANCED", exact: true }).click();
  await page.getByRole("slider", { name: "Pitch percentage", exact: true }).fill("12");
  assert(Math.abs(await page.evaluate(() => window.musikeBeatmakerHost.media().playbackRate) - 1.12) < 0.0001, "Native percent fader stays in percent when the original panel is in semitone mode");
  await page.getByRole("slider", { name: "Pitch percentage", exact: true }).fill("0");
  assert.equal(await page.getByRole("button", { name: "VJ", exact: true }).isDisabled(), true, "Video-only controls do not pretend to work with audio");
  const videoBytes = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const chunks = [];
    const result = new Promise(resolve => { recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))); });
    recorder.ondataavailable = event => chunks.push(event.data);
    recorder.start();
    let frame = 0;
    const draw = setInterval(() => { context.fillStyle = "#19231d"; context.fillRect(0, 0, 320, 180); context.fillStyle = "#ddd"; context.fillRect(frame++ % 200, 40, 50, 80); }, 80);
    await new Promise(resolve => setTimeout(resolve, 1200)); clearInterval(draw); recorder.stop(); stream.getTracks().forEach(track => track.stop());
    return result;
  }));
  await page.route("**/api/video-for/**", route => route.fulfill({ json: { track: { ...tracks[0], kind: "video" } } }));
  await page.route("**/api/stream/*/video?*", route => mediaResponse(route, videoBytes, "video/webm"));
  await page.getByRole("button", { name: "Return to start", exact: true }).click();
  await page.getByRole("button", { name: "Toggle music video" }).click();
  await page.locator(".bm-now-art video").waitFor();
  await page.locator(".bm-now-art video").evaluate(video => { video.loop = true; });
  await page.getByRole("button", { name: "VJ", exact: true }).click();
  const vj = page.locator(".looper-midimap-container").filter({ hasText: "VJ Module — Mapping + FX" });
  assert(await vj.isVisible(), "VJ opens for a decoded video source");
  assert.equal(await vj.getByText("Include streams from other tabs", { exact: true }).isVisible(), false, "Unsupported Chrome-tab controls are hidden");
  await vj.getByRole("button", { name: "VJ FX: OFF", exact: true }).click();
  const monitorOpened = page.waitForEvent("popup");
  await vj.getByRole("button", { name: "Open Monitor", exact: true }).click();
  const monitor = await monitorOpened;
  await monitor.waitForLoadState();
  await monitor.waitForFunction(() => { const video = document.querySelector("video"); return video?.srcObject?.getVideoTracks().length === 1 && video.readyState >= 2; });
  await monitor.close();
  await vj.getByRole("button", { name: "VJ FX: ON", exact: true }).click();
  await vj.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Toggle music video" }).click();
  await page.waitForFunction(() => window.musikeBeatmakerHost.media().tagName === "AUDIO" && window.musikeBeatmakerHost.media().readyState >= 1);
  await page.getByRole("button", { name: /^Settings/ }).click();
  assert.equal(await page.getByText("Appearance", { exact: true }).count(), 0, "Studio settings do not expose disconnected theme options");
  await page.keyboard.press("Escape");
  const model = await page.evaluate(() => chrome.runtime.sendMessage({ type: "ytbm-stems-model-status" }));
  assert.equal(model.present, false, "Optional model host responds without a model installed");

  const sessionDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "Save", exact: true }).click();
  const session = await sessionDownload;
  const exported = JSON.parse(await readFile(await session.path(), "utf8"));
  assert.equal(exported.format, "musike-beatmaker");
  assert(exported.tracks.some(t => t.id === tracks[0].id), "Export contains the real track reference");
  exported.name = "Restored session"; exported.cues["ytbm_cues_testaudio00:bank:A"] = { "1": { time: 7 } };
  if (!exported.tracks.some(t => t.id === tracks[1].id)) exported.tracks.push(tracks[1]);
  await page.locator("input[type=file]").setInputFiles({ name: "restored.beatmaker.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(exported)) });
  await page.getByRole("textbox", { name: "Session name" }).filter({ visible: true }).waitFor();
  await page.waitForFunction(() => window.musikeBeatmakerEngine.snapshot().cues["1"] === 7);
  assert((await (await fetch(`${origin}/api/library`)).json()).playlists.some(p => p.name === "Restored session"), "Imported tracks are persisted as a real playlist");
  await page.getByRole("button", { name: "LIST", exact: true }).click(); assert(await page.locator(".bm-covers").evaluate(el => el.classList.contains("bm-list")));
  await page.getByRole("button", { name: "Cover view", exact: true }).click(); assert(!await page.locator(".bm-covers").evaluate(el => el.classList.contains("bm-list")));
  await page.getByRole("button", { name: "New playlist", exact: true }).click();
  const newPlaylist = page.getByRole("dialog", { name: "New playlist", exact: true });
  await newPlaylist.getByRole("textbox").fill("Studio selections");
  await newPlaylist.getByRole("button", { name: "Create", exact: true }).click();
  await newPlaylist.waitFor({ state: "hidden" });
  await page.getByRole("combobox", { name: "Library collection" }).selectOption("all");
  await page.getByRole("button", { name: "Add Midnight Tapes to a playlist", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Studio selections/ }).click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('[aria-label="Library collection"] option')).some(o => o.textContent === "Studio selections"));
  const organized = (await (await fetch(`${origin}/api/library`)).json()).playlists.find(p => p.name === "Studio selections");
  assert(organized?.tracks.some(t => t.id === tracks[0].id), "Studio playlist action persists the selected track");
  await page.getByRole("combobox", { name: "Library collection" }).selectOption(organized.id);
  await page.waitForFunction(() => document.querySelectorAll(".bm-track").length === 1);
  assert.equal(await page.locator(".bm-track").count(), 1, "Selecting a playlist narrows the studio library");
  await page.getByRole("combobox", { name: "Library collection" }).selectOption("all");
  await page.getByRole("button", { name: "Open playlist Studio selections", exact: true }).click();
  await page.getByRole("button", { name: "Play Midnight Tapes", exact: true }).waitFor();
  await page.getByRole("combobox", { name: "Studio search type" }).selectOption("playlists");
  await page.getByRole("textbox", { name: "Search music", exact: true }).fill("playlist-failure");
  await page.getByRole("button", { name: "Search YouTube Music", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Playlist search unavailable" }).waitFor();
  await page.getByRole("button", { name: "Retry playlist search", exact: true }).click();
  await page.getByRole("textbox", { name: "Search music", exact: true }).fill("jazz samples");
  await page.getByRole("button", { name: "Search YouTube Music", exact: true }).click();
  await page.getByRole("button", { name: "Open YouTube playlist YouTube sample crate", exact: true }).click();
  const remotePlaylist = page.getByRole("dialog", { name: "YouTube sample crate", exact: true });
  await remotePlaylist.getByRole("button", { name: "Preview playlist track Midnight Tapes", exact: true }).waitFor();
  assert.equal(await remotePlaylist.getByRole("button", { name: /^Preview playlist track/ }).count(), 2, "YouTube playlists expose their tracks before import");
  await remotePlaylist.getByRole("button", { name: "Add playlist to library", exact: true }).click();
  await remotePlaylist.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelectorAll(".bm-track").length === 2);
  const importedPlaylist = (await (await fetch(`${origin}/api/library`)).json()).playlists.find(p => p.name === "YouTube sample crate");
  assert.equal(importedPlaylist?.tracks.length, 2, "Import saves the entire playlist in the shared library");
  await page.getByRole("button", { name: `Remove ${tracks[1].title} from YouTube sample crate`, exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".bm-track").length === 1);
  let updatedLibrary = (await (await fetch(`${origin}/api/library`)).json());
  assert.equal(updatedLibrary.playlists.find(p => p.id === importedPlaylist.id).tracks.length, 1, "Studio removes a track from its playlist");
  assert(updatedLibrary.playlists.find(p => p.name === "Restored session").tracks.some(t => t.id === tracks[1].id), "Removing playlist membership preserves other collections");
  await page.getByRole("button", { name: "Delete playlist YouTube sample crate", exact: true }).click();
  await page.getByRole("button", { name: "Open playlist YouTube sample crate", exact: true }).waitFor({ state: "hidden" });
  assert(!(await (await fetch(`${origin}/api/library`)).json()).playlists.some(p => p.id === importedPlaylist.id), "Playlist deletion persists");
  await page.getByRole("button", { name: `Remove ${tracks[1].title} from library`, exact: true }).click();
  await page.getByRole("button", { name: `Remove ${tracks[1].title} from library`, exact: true }).waitFor({ state: "hidden" });
  updatedLibrary = await (await fetch(`${origin}/api/library`)).json();
  assert(![...updatedLibrary.favorites, ...updatedLibrary.history, ...updatedLibrary.playlists.flatMap(p => p.tracks)].some(t => t.id === tracks[1].id), "Removing from all tracks removes all saved references");
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await page.getByRole("heading", { name: "Find a sound. Make it yours." }).waitFor();
  await page.getByRole("region", { name: "Your library", exact: true }).waitFor();
  assert(await page.locator(".ds-library-track").count() > 0, "Discover includes recent library tracks");
  await page.getByRole("textbox", { name: "Discover samples search" }).fill("Studio selections");
  await page.locator(".ds-playlist-matches").getByRole("button", { name: /Studio selections/ }).waitFor();
  await page.getByRole("button", { name: "START DIGGING" }).click();
  const matchingYouTube = page.getByRole("region", { name: "Matching YouTube playlists", exact: true });
  await matchingYouTube.getByRole("button", { name: "Open YouTube playlist YouTube sample crate", exact: true }).waitFor();
  assert(await page.evaluate(() => !!(document.querySelector(".ds-results").compareDocumentPosition(document.querySelector(".ds-library")) & Node.DOCUMENT_POSITION_FOLLOWING)), "Submitted Discover results precede recently used tracks");
  assert(await matchingYouTube.locator(".yt-playlist-grid").evaluate(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX === "auto"), "Matching YouTube playlists form a horizontally scrollable row");
  await matchingYouTube.getByRole("button", { name: "Open YouTube playlist YouTube sample crate", exact: true }).click();
  await page.getByRole("dialog", { name: "YouTube sample crate", exact: true }).getByRole("button", { name: "Add playlist to library", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "Discover search type" }).selectOption("playlists");
  await page.getByRole("button", { name: "START DIGGING" }).click();
  await page.getByRole("button", { name: "Open YouTube playlist YouTube sample crate", exact: true }).waitFor();
  await page.getByRole("button", { name: "STUDIO", exact: false }).first().click();
  await page.locator(".bm-footer").getByText("Ready", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.musikeBeatmakerEngine.snapshot().cues["1"]), 7, "Navigation preserves cue banks");
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await page.getByRole("heading", { name: "Find a sound. Make it yours." }).waitFor();
  await page.getByRole("button", { name: "MUSIC LIBRARY", exact: true }).click();
  await page.locator(".music-app").waitFor();
  assert.equal(await page.locator(".music-app").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(0, 0, 0)", "The music library uses the studio's pitch-black shell");
  await page.getByRole("button", { name: /^Settings/ }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.waitFor();
  assert.equal(await settings.evaluate(el => getComputedStyle(el).backgroundColor), "rgb(5, 5, 5)", "Settings uses the pitch-black shell");
  const languages = settings.getByRole("radiogroup", { name: "Language", exact: true });
  assert.equal(await languages.getByRole("radio").count(), 3, "Settings offers English, French and Spanish");
  await languages.getByRole("radio", { name: "Français", exact: true }).click();
  await page.getByRole("dialog", { name: "Réglages", exact: true }).waitFor();
  await page.getByRole("dialog", { name: "Réglages", exact: true }).getByRole("radio", { name: "English", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page.locator("#search-input").fill("Studio selections");
  await page.getByRole("tab", { name: "Playlists", exact: true }).click();
  await page.getByRole("button", { name: "Open YouTube playlist YouTube sample crate", exact: true }).waitFor();
  const playlistLink = page.getByRole("region", { name: "Playlist", exact: true }).getByRole("link", { name: /Studio selections/ });
  await playlistLink.waitFor();
  await playlistLink.click();
  assert(page.url().includes(`/playlist/${organized.id}`), "Playlist search opens the saved collection");
  await page.getByRole("button", { name: /Beatmaker workspace/ }).first().click();
  await page.locator(".bm-footer").getByText("Ready", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.musikeBeatmakerEngine.snapshot().cues["1"]), 7, "Beatmaker workspace returns to the studio from the library");
  await page.getByLabel("MIDI controller preset", { exact: true }).selectOption("legacy12");
  await page.goto(`${origin}/?workspace=beatmaker`);
  await page.getByRole("heading", { name: "Find a sound. Make it yours." }).waitFor();
  await page.getByRole("button", { name: "STUDIO", exact: false }).first().click();
  await page.locator(".bm-footer").getByText("Ready", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Play Midnight Tapes", exact: true }).click();
  assert.equal(await page.getByLabel("MIDI controller preset", { exact: true }).inputValue(), "legacy12", "Desktop restores selected preset after reopening");
  assert.equal(await page.locator(".bm-pad-hit").count(), 12);
  await page.getByLabel("MIDI controller preset", { exact: true }).selectOption("sp404mkii-a");
  await page.waitForFunction(() => window.musikeBeatmakerEngine.snapshot().cues["1"] === 7);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Studio does not overflow a narrow viewport");
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Discovery does not overflow a narrow viewport");
  await page.getByRole("textbox", { name: "Discover samples search" }).fill("jazz samples");
  await page.getByRole("button", { name: "START DIGGING" }).click();
  await page.getByRole("region", { name: "Matching YouTube playlists", exact: true }).getByRole("button", { name: "Open YouTube playlist YouTube sample crate", exact: true }).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Horizontal playlist results stay inside the narrow Discover viewport");
  assert.deepEqual(failedAssets, [], "Every requested engine asset exists");
  assert.deepEqual(errors, [], "No browser JavaScript errors");
  console.log("PASS: discovery, 30 real samples, previews/downloads, favorites, cues, bank isolation, region loops, pitch, volume, MIDI map wiring, original panels, compact-bar recovery, audio/video switching, VJ monitor, settings, session persistence and responsive layout.");
} finally {
  await browser?.close();
  server.kill();
  await rm(temporary, { recursive: true, force: true });
}
