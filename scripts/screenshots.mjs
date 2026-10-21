// Captures the README screenshots from the built app and a real, isolated server.
// Catalog search and remote media are deterministic fixtures; the app itself is untouched.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const shots = path.join(root, "docs/screenshots");
const temporary = await mkdtemp(path.join(tmpdir(), "yt-beatmaker-shots-"));
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

const tracks = Array.from({ length: 12 }, (_, i) => ({
  id: `testaudio${String(i).padStart(2, "0")}`,
  title: ["Midnight Tapes", "Dome EP", "Calor", "Liminal", "Pyramid", "After Hours"][i % 6] + (i > 5 ? " II" : ""),
  artist: ["Studio Sessions", "The Night Shift", "Lime"][i % 3],
  duration: 30,
  art: `https://fixture.invalid/cover-${i}.svg`,
  thumb: `https://fixture.invalid/cover-${i}.svg`,
  kind: "song",
}));

const coverColors = [
  ["#c3ec52", "#1f2a18", "#0a0b09"],
  ["#7b8d5a", "#2f3a27", "#11120f"],
  ["#d9c7a2", "#514633", "#171511"],
  ["#8fb4a0", "#24362f", "#0c110f"],
  ["#b8a1d9", "#332a44", "#100d16"],
  ["#d9a17b", "#4a2f24", "#150f0c"],
  ["#6fa8d9", "#23364a", "#0b1015"],
  ["#d97b9c", "#4a2333", "#150b0f"],
  ["#c3ec52", "#3a4423", "#0d0f08"],
  ["#a2c7d9", "#2c3f4a", "#0b1114"],
  ["#d9b87b", "#4a3c24", "#15110b"],
  ["#9bd97b", "#2f4a24", "#0c150b"],
];
const cover = (i) => {
  const [a, b, c] = coverColors[i % coverColors.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient>
      <radialGradient id="r" cx=".3" cy=".25" r=".8"><stop stop-color="${a}" stop-opacity=".9"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="600" height="600" fill="url(#g)"/>
    <circle cx="${130 + (i * 47) % 340}" cy="${150 + (i * 73) % 300}" r="${120 + (i * 19) % 120}" fill="url(#r)"/>
    <circle cx="${430 - (i * 31) % 260}" cy="${430 - (i * 53) % 240}" r="${70 + (i * 13) % 90}" fill="none" stroke="${a}" stroke-opacity=".45" stroke-width="2"/>
    <rect x="0" y="450" width="600" height="150" fill="#050505" fill-opacity=".35"/>
    <text x="48" y="520" fill="#f4f4f4" fill-opacity=".82" font-family="Helvetica, Arial, sans-serif" font-size="26" letter-spacing="6">SIDE ${String(i + 1).padStart(2, "0")}</text>
  </svg>`;
};

function mediaResponse(route, bytes, contentType) {
  const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  return route.fulfill({ status: range ? 206 : 200, contentType,
    headers: { "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${bytes.length}` } : {}) },
    body: bytes.subarray(start, end + 1) });
}

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

let browser;
try {
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) { healthy = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!healthy) throw new Error(`Screenshot server did not start: ${serverOutput}`);

  const post = (url, body) => fetch(`${origin}${url}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  await post("/api/favorites", { tracks: tracks.slice(0, 6) });
  await post("/api/playlists", { name: "Late night session", tracks: tracks.slice(0, 5) });
  await post("/api/playlists", { name: "Dusty breaks", tracks: tracks.slice(5, 10) });
  for (const track of tracks.slice(0, 4)) await post("/api/history", track);

  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    headless: true, args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.route("https://fixture.invalid/**", route => {
    const match = route.request().url().match(/cover-(\d+)\.svg/);
    return route.fulfill({ contentType: "image/svg+xml", body: cover(match ? Number(match[1]) : 0) });
  });
  await page.route("**/api/search?*", route => route.fulfill({ json: { tracks } }));
  await page.route("**/api/search/playlists?*", route => route.fulfill({ json: { playlists: ["Jazz samples", "Dusty jazz cuts", "Soul and jazz", "Rare jazz recordings", "Jazz breaks", "Piano samples"].map((title, n) => ({ id: `PLdemo00000${n}`, title, author: "Sample collection", thumb: tracks[n].thumb })) } }));
  await page.route("**/api/prepare/*", route => route.fulfill({ json: {} }));
  const wav = wave();
  await page.route("**/api/stream/*/audio", route => mediaResponse(route, wav, "audio/wav"));

  await mkdir(shots, { recursive: true });
  await page.goto(`${origin}/?workspace=beatmaker`);
  await page.getByRole("heading", { name: "Find a sound. Make it yours." }).waitFor();
  await page.locator(".ds-track-grid").getByRole("button", { name: "Preview Midnight Tapes", exact: true }).click();
  await page.locator("footer.ds-player").waitFor();
  await page.waitForTimeout(1400);
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".ds-scroll").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.join(shots, "discover-samples.png") });
  console.log("Captured discover-samples.png");

  await page.getByRole("textbox", { name: "Discover samples search" }).fill("jazz samples");
  await page.getByRole("button", { name: "START DIGGING" }).click();
  await page.getByRole("region", { name: "Matching YouTube playlists", exact: true }).getByRole("button", { name: "Open YouTube playlist Jazz samples", exact: true }).waitFor();
  await page.locator(".ds-scroll").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.join(shots, "discover-search.png") });
  console.log("Captured discover-search.png");

  await page.locator(".ds-track-grid").getByRole("button", { name: "Load Midnight Tapes into studio", exact: true }).click();
  await page.locator(".bm-footer").getByText("Ready", { exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Randomize cues", exact: true }).waitFor();
  await page.getByRole("button", { name: "Randomize cues", exact: true }).click();
  await page.locator("#bm-timeline .cue-marker").first().waitFor();
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(shots, "studio.png") });
  console.log("Captured studio.png");

  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await page.getByRole("heading", { name: "Find a sound. Make it yours." }).waitFor();
  await page.getByRole("button", { name: "MUSIC LIBRARY", exact: true }).click();
  await page.locator(".music-app").waitFor();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(shots, "library.png") });
  console.log("Captured library.png");

  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.getByRole("button", { name: /^Settings/ }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.waitFor();
  // The real dialog scrolls; let it grow so the screenshot shows the whole panel.
  await page.addStyleTag({ content: '[role="dialog"] .scroll-area { max-height: none !important; overflow: visible !important; }' });
  await page.waitForTimeout(400);
  await settings.screenshot({ path: path.join(shots, "settings.png") });
  console.log("Captured settings.png");
} finally {
  await browser?.close();
  server.kill();
  await rm(temporary, { recursive: true, force: true });
}
