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
  await page.getByText("No matches this time.", { exact: true }).waitFor();
  await discoverySearch.fill("failure"); await page.getByRole("button", { name: "START DIGGING" }).click();
  await page.getByRole("button", { name: "Retry search" }).waitFor();
  await page.getByRole("button", { name: "Retry search" }).click();
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
  await page.getByRole("button", { name: "Save Midnight Tapes", exact: true }).click();
  await page.getByRole("button", { name: "Unsave Midnight Tapes", exact: true }).waitFor();
  assert((await (await fetch(`${origin}/api/library`)).json()).favorites.some(t => t.id === tracks[0].id), "Favorite button persists to the real library API");
  await page.getByRole("button", { name: "Load Midnight Tapes into studio", exact: true }).click();
  await page.getByText("AUDIO ENGINE ACTIVE", { exact: false }).waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Set cue 1", exact: true }).waitFor();
  await page.getByRole("button", { name: "Set cue 1", exact: true }).click();
  const firstCue = await page.evaluate(() => window.musikeBeatmakerEngine.snapshot().cues["1"]);
  assert(firstCue >= 0, "Pad captures the shared player's position");
  await page.getByRole("button", { name: "Set cue 11", exact: true }).click();
  await page.getByRole("button", { name: "B", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.musikeBeatmakerEngine.snapshot().cues), {}, "Banks are independent");
  await page.getByRole("button", { name: "Set cue 2", exact: true }).click();
  await page.getByRole("button", { name: "A", exact: true }).click();
  assert.equal(await page.evaluate(() => window.musikeBeatmakerEngine.snapshot().cues["1"]), firstCue);
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
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
  await page.locator("input[type=file]").setInputFiles({ name: "restored.beatmaker.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(exported)) });
  await page.getByRole("textbox", { name: "Session name" }).filter({ visible: true }).waitFor();
  await page.waitForFunction(() => window.musikeBeatmakerEngine.snapshot().cues["1"] === 7);
  assert((await (await fetch(`${origin}/api/library`)).json()).playlists.some(p => p.name === "Restored session"), "Imported tracks are persisted as a real playlist");
  await page.getByRole("button", { name: "LIST", exact: true }).click(); assert(await page.locator(".bm-covers").evaluate(el => el.classList.contains("bm-list")));
  await page.getByRole("button", { name: "Cover view", exact: true }).click(); assert(!await page.locator(".bm-covers").evaluate(el => el.classList.contains("bm-list")));
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await page.getByRole("heading", { name: "Find a sound. Make it yours." }).waitFor();
  await page.getByRole("button", { name: "STUDIO", exact: false }).first().click();
  await page.getByText("AUDIO ENGINE ACTIVE", { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.musikeBeatmakerEngine.snapshot().cues["1"]), 7, "Navigation preserves cue banks");
  await page.reload();
  await page.getByRole("heading", { name: "Find a sound. Make it yours." }).waitFor();
  await page.getByRole("button", { name: "STUDIO", exact: false }).first().click();
  await page.getByText("AUDIO ENGINE ACTIVE", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Play Midnight Tapes", exact: true }).click();
  await page.waitForFunction(() => window.musikeBeatmakerEngine.snapshot().cues["1"] === 7);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Studio does not overflow a narrow viewport");
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Discovery does not overflow a narrow viewport");
  assert.deepEqual(failedAssets, [], "Every requested engine asset exists");
  assert.deepEqual(errors, [], "No browser JavaScript errors");
  console.log("PASS: discovery, 30 real samples, previews/downloads, favorites, cues, bank isolation, region loops, pitch, volume, MIDI map wiring, original panels, compact-bar recovery, audio/video switching, VJ monitor, settings, session persistence and responsive layout.");
} finally {
  await browser?.close();
  server.kill();
  await rm(temporary, { recursive: true, force: true });
}
