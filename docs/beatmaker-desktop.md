# YT Beatmaker Cues Desktop 1.0

The desktop app opens **Discover Samples**, then leads into a Beatmaker workspace styled after the supplied SP Architect reference: black surfaces, fine borders, white active controls, a cover library and a four-column cue-pad grid.

## Using it

1. On Discover Samples, choose a crate or search YouTube Music. Preview a track, save it, or load it directly into the studio. The three included drum banks offer thirty real WAV files with preview and download controls. **Studio** opens the workspace without selecting a new track.
2. Click an empty pad to mark the current position. Click an assigned pad to jump to that cue. **Shift-click** replaces a cue; its **×** clears it.
3. **1–9 / 0** trigger the first ten pads. Pads 11–12 are available on screen. **A–J** select independent cue banks for the current track. New banks start empty; the shuffle button generates random cues.
4. **Cues / Loop** opens the original compact controls, including region loops, Pitch / Speed / Speed HD, and optional stems. **I / O** set the loop boundaries.
5. **Sequencer**, **FX Pad**, **Sidechain**, **VJ** and **Advanced** open the original extension tools. Advanced includes MIDI mappings, sample packs, audio routing and loopers. The Audio / Video button switches Musike's playback mode; VJ needs a video source.
6. Cues and bank selection save locally. **Save** exports a `.beatmaker.json` containing known library tracks and cue banks; **Load** restores those cues and creates a playlist for valid imported tracks. This session format does not include recorded audio, the AI model, or every extension preference.

### Studio toolbars and panels

- **CUES / LOOP** opens the original compact performance bar (the "minimal bar"). Click it again to hide the bar. If the bar disappears after using **Advanced**, **CUES / LOOP** rebuilds it.
- **ADVANCED** opens the original settings drawer: MIDI mappings, stems, sample packs, audio routing, loopers, effects and engine options. **Close** returns to the pads.
- **MAP** jumps straight to MIDI mappings. **SEQUENCER**, **FX PAD**, **SIDECHAIN** and **VJ** open their own panels; opening another tool replaces the panel in view. VJ needs a loaded video source.
- **Guide** reopens the in-app workflow, and **Save / Load** handle `.beatmaker.json` sessions.
- The studio **Settings** gear controls catalog language, yt-dlp and library backup. Appearance (theme, accent and layout) is changed from the Music Library so the studio's black shell stays consistent.
- Keyboard: **Space** play/pause · **1–9 / 0** trigger cues · **I / O** set loop points · **A–J** switch cue banks.

The full Musike discovery interface is available through **Open full music library**. **Beatmaker workspace** returns to the studio.

## Integration

- The source in `YTbeatmakercues/` is the supplied extension, version 2.4.5. It is used directly rather than reimplementing its DSP.
- `web/vite.config.ts` packages its scripts, worklets, samples, optional ONNX runtime and notices under `web/dist/beatmaker/`. Build-time adapters connect media lookup, cue storage and timelines to Musike. The original extension files are not rewritten.
- `web/src/beatmaker/runtime.ts` provides local storage and messaging equivalents for the extension APIs. The music player and the engine use the **same media element**. The stems host runs locally and obtains full-song audio from Musike's stream proxy.
- `web/src/beatmaker/engine-api.js` exposes the engine's own cue, pitch, effects and sequencer functions to the React workspace.
- Signalsmith Stretch is pinned as a workspace dependency. No dependency on an ignored `YTbeatmakercues/node_modules` folder is needed to build.
- Electron permits the compositor's named, blank VJ output window. Normal external links still open in the system browser.

The desktop app has one player, so Chrome's cross-tab video feeds are not represented as multiple app decks. Stems retain the original optional model download and CPU/GPU requirements. Hardware MIDI, microphone/output routing, projector output and full AI inference need testing with the intended devices and model installed.

## Build

Use Node.js 22.19+ (Node 24 works) and pnpm 10:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm installer:mac
```

Installers are collected in `release/` for Apple Silicon and Intel. The Apple Silicon app bundle is `desktop/out/mac-arm64/YT Beatmaker Cues Desktop.app`.

For a browser preview, run `pnpm build && pnpm start` and open `http://localhost:4180/?workspace=beatmaker`. `pnpm dev` also serves the packaged engine assets through Vite.

Local builds are ad-hoc signed, not Apple-notarized. First launch downloads Musike's playback tools. Personal data stays under `~/Library/Application Support/YT Beatmaker Cues Desktop`.

## Verification performed

Browser integration checks used a deterministic WAV stream with HTTP Range support to verify shared playback, cue capture and keyboard seeking, bank isolation/restoration, pitch control, persistence after reload, session export/import, opening the original controls, shortcut handoff to the music browser, and a narrow viewport without horizontal overflow. The optional stems host's model-status request was checked without installing a model.

The packaged Apple Silicon `.app` was also launched with an isolated profile: first-run setup reached the studio and the original Advanced panel opened. Both app signatures and DMG checksums were verified.

Run `pnpm build`, `pnpm exec playwright install chromium`, then `pnpm test:app` for the expanded control checks. See [control-audit.md](control-audit.md) for details.
