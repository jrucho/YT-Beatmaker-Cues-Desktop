import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (...p: string[]) => path.join(here, "src", ...p);
const server = (...p: string[]) => path.join(here, "..", "server", "src", ...p);
const same = (a: string, b: string) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

// Ship the user's actual DSP, sample packs, MIDI and stems engines with the app.
function beatmakerAssets(): Plugin {
  const source = path.resolve(here, "../YTbeatmakercues");
  const output = path.join(here, "dist/beatmaker");
  function generate() {
      mkdirSync(output, { recursive: true });
      for (const entry of ["sounds", "worklets", "addons", "style.css", "vj-live.js", "ui-tooltips.js", "player-cues-button.js", "video-region-loop.js", "THIRD_PARTY_NOTICES.md"]) {
        cpSync(path.join(source, entry), path.join(output, entry), { recursive: true });
      }
      cpSync(path.join(here, "node_modules/signalsmith-stretch"), path.join(output, "node_modules/signalsmith-stretch"), { recursive: true, dereference: true });
      let content = readFileSync(path.join(source, "content.js"), "utf8");
      content = content.replace("  jumpToCue(cueTime);", "  if (jumpToCue(cueTime) && window.musikeBeatmakerHost) window.dispatchEvent(new CustomEvent('beatmaker-pad', { detail: { bank: window.musikeBeatmakerHost.bankName(), pad: cueKey === '0' ? 10 : Number(cueKey), phase: 'triggered' } }));");
      content = content.replace("function handleMIDIMessage(e) {", "function handleMIDIMessage(e) { if (window.musikeBeatmakerHost?.midi?.(e.data)) return;");
      content = content.replaceAll("function getVideoElement() {", "function getVideoElement() { if (window.musikeBeatmakerHost) return window.musikeBeatmakerHost.media();");
      content = content.replace("function getCurrentVideoID() {", "function getCurrentVideoID() { if (window.musikeBeatmakerHost) return window.musikeBeatmakerHost.cueId();");
      content = content.replace("function getStemVideoId() {", "function getStemVideoId() { if (window.musikeBeatmakerHost) return window.musikeBeatmakerHost.trackId();");
      content = content.replace("function getProgressBarElement() {", "function getProgressBarElement() { if (window.musikeBeatmakerHost) return document.getElementById('bm-timeline');");
      content = content.replace("function addTrackedListener(target, type, listener, options) {", "function addTrackedListener(target, type, listener, options) { if (type === 'keydown' || type === 'keyup') { const original = listener; listener = function(event) { if (window.musikeBeatmakerHost && (!window.musikeBeatmakerHost.active || event.target.closest?.('[role=dialog]'))) return; return original.call(this, event); }; }");
      content = content.replace(/document\.addEventListener\((["'])key(?:down|up)\1,\s*(?:\(e\)|e)\s*=>\s*\{/g, "$& if (window.musikeBeatmakerHost && (!window.musikeBeatmakerHost.active || e.target.closest?.('[role=dialog]'))) return;");
      // Chrome-tab actions have no target in a single-player desktop app.
      content = content.replace("vjContentWrap.appendChild(cueAllTabsRow);", "vjContentWrap.appendChild(cueAllTabsRow); if (window.musikeBeatmakerHost) { for (const row of [crossTabRow, tabAudioRow, cueAllTabsRow, streamRow]) row.style.display = 'none'; crossTabChk.disabled = tabAudioChk.disabled = cueAllTabsChk.disabled = true; vjControls.crossTabStreamsEnabled = false; singleTabPlaybackMode = cueAllTabsMode = false; vjControls.streamCount = 1; streamCountSel.value = '1'; vjLiveStatusElement.textContent = 'Source: the current desktop video player'; fxRackBtn.disabled = true; fxRackBtn.title = 'The desktop app has one video source'; }");
      // App sessions own cue persistence; never put one track's cues in the router URL.
      content = content.replace('function saveCuePointsToURL() {\n  let u', 'function saveCuePointsToURL() {\n  if (window.musikeBeatmakerHost) { localStorage.setItem("ytbm_cues_" + getCurrentVideoID(), JSON.stringify(cuePoints)); return; }\n  let u');
      // Cue pins must stand out against the studio's black timeline.
      content = content.replace('marker.style.backgroundColor = "black";', 'marker.style.backgroundColor = "#f5f5f5";');
      content = content.replace('topcap.style.backgroundColor = "red";', 'topcap.style.backgroundColor = "#f5f5f5";');
      content = content.replace("function loadCuePointsFromURLParam() {", "function loadCuePointsFromURLParam() { if (window.musikeBeatmakerHost) return false;");
      content = content.replace('function copyCueLink() {\n  let url = new URL(window.location.href);', 'function copyCueLink() {\n  let url = new URL(window.musikeBeatmakerHost ? "https://www.youtube.com/watch?v=" + window.musikeBeatmakerHost.trackId().replace(/^youtube:/, "") : window.location.href);');
      content = content.replace('if (Object.keys(cuePoints).length === 0) {\n    randomizeCuesInOneClick();', 'if (Object.keys(cuePoints).length === 0) {\n    if (window.musikeBeatmakerHost) { updateCueMarkers(); refreshCuesButton(); } else randomizeCuesInOneClick();');
      content = content.replace('if (audioContext.state === "suspended") {\n    await audioContext.resume()', 'if (audioContext.state === "suspended" && navigator.userActivation.hasBeenActive) {\n    await audioContext.resume()');
      const api = readFileSync(src("beatmaker", "engine-api.js"), "utf8");
      content = content.replace("initialize();\n})();", `${api}\ninitialize().then(() => { window.dispatchEvent(new Event('beatmaker-ready')); });\n})();`);
      writeFileSync(path.join(output, "content.js"), content);
      let tracks = readFileSync(path.join(output, "addons/stems/track-store.js"), "utf8");
      tracks = tracks.replace("const url = new URL(value);", "const url = new URL(value); if (url.origin === location.origin && /^\\/api\\/stream\\/[A-Za-z0-9_-]{11}\\/audio$/.test(url.pathname)) return url;");
      writeFileSync(path.join(output, "addons/stems/track-store.js"), tracks);
      const inference = path.join(output, "addons/stems/inference-host.js");
      writeFileSync(inference, readFileSync(inference, "utf8").replace("new Worker('stems-inference-worker.js')", "new Worker('/beatmaker/addons/stems/stems-inference-worker.js')"));
  }
  return {
    name: "musike-beatmaker",
    closeBundle: generate,
    configureServer(server) {
      generate();
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith("/beatmaker/")) {
          const url = new URL(req.url, "http://localhost");
          const file = path.resolve(output, decodeURIComponent(url.pathname.slice("/beatmaker/".length)));
          if (file.startsWith(output + path.sep)) req.url = `/@fs${file}${url.search}`;
        }
        next();
      });
    },
  };
}

/**
 * The Android build (`vite build --mode native`): the same app, with the backend swapped. lib/api.ts (HTTP to the
 * Musike server) becomes native/api.ts (the server's own code, running in the app), and the two server modules that
 * only make sense on a computer (paths/environment, yt-dlp) are replaced by small stand-ins.
 */
function nativeBackend(): Plugin {
  const swaps: [from: string, to: string][] = [
    [src("lib", "api.ts"), src("native", "api.ts")],
    [server("config.ts"), src("native", "shims", "config.ts")],
    [server("ytdlp.ts"), src("native", "shims", "ytdlp.ts")],
  ];
  return {
    name: "musike-native-backend",
    enforce: "pre",
    async resolveId(source, importer, options) {
      // No service worker inside the app: it would only risk serving an old version after an update.
      if (source === "virtual:pwa-register") return "\0musike-no-pwa";
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const id = resolved.id.split("?")[0]!;
      for (const [from, to] of swaps) {
        // The replacement may import the original (native/api.ts re-exports lib/apiTypes, not lib/api).
        if (same(id, from) && !(importer && same(importer, to))) return to;
      }
      return null;
    },
    load(id) {
      if (id === "\0musike-no-pwa") return "export const registerSW = () => () => {};";
      return null;
    },
  };
}

export default defineConfig(({ mode }) => {
  const native = mode === "native";
  return {
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: native ? { outDir: "dist-native", emptyOutDir: true } : undefined,
    plugins: [
      react(),
      tailwindcss(),
      ...(!native ? [beatmakerAssets()] : []),
      native
        ? nativeBackend()
        : VitePWA({
            registerType: "autoUpdate",
            includeAssets: ["favicon.svg", "apple-touch-icon.png"],
            manifest: {
              name: "YT Beatmaker Cues Desktop",
              short_name: "YT Beatmaker Cues",
              description: "Your music. Your instrument.",
              lang: "en",
              theme_color: "#0B0C0F",
              background_color: "#0B0C0F",
              display: "standalone",
              start_url: "/",
              icons: [
                { src: "icon-192.png", sizes: "192x192", type: "image/png" },
                { src: "icon-512.png", sizes: "512x512", type: "image/png" },
                { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
              ],
            },
            workbox: {
              globIgnores: ["beatmaker/**"],
              navigateFallbackDenylist: [/^\/api\//],
              runtimeCaching: [
                {
                  // Artwork only. Streams and API responses are never cached by the service worker.
                  urlPattern: ({ url }) => /(^|\.)ytimg\.com$|googleusercontent\.com$|ggpht\.com$/.test(url.hostname),
                  handler: "CacheFirst",
                  options: {
                    cacheName: "artwork",
                    expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 30 },
                    cacheableResponse: { statuses: [0, 200] },
                  },
                },
              ],
            },
          }),
    ],
    server: {
      proxy: native ? undefined : { "/api": "http://127.0.0.1:4180" },
    },
    preview: {
      proxy: native ? undefined : { "/api": "http://127.0.0.1:4180" },
    },
  };
});
