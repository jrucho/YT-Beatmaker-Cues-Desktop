# YT Beatmaker Cues Desktop

**Your music. Your instrument.**

A standalone desktop music and beatmaking app combining [Musike](https://github.com/Ernani1234/musike)'s music player with the original **YT Beatmaker Cues 2.4.5** engine. A dark workspace puts your library, cue banks and performance tools in one window.

**[Download v1.0.4 — apps, plug-ins and source](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/tag/v1.0.4)** · [All exports](docs/downloads-1.0.4.md) · [Usage guide](docs/beatmaker-desktop.md) · [Release notes](CHANGELOG.md)

**1.0.4** adds native sample pads, the new **Mac and Windows native standalone**, AU/VST3/AUv3, faster Android loading and a shared responsive cue workspace. Hosted plug-ins leave keyboard MIDI/transport shortcuts to the DAW. [1.0.3 remains available](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/tag/v1.0.3).

The **full desktop studio** retains the original stems, VJ, FX, sequencer and sidechain. The **native cue standalone** uses the same cue/sample-pad interface as the plug-ins and mobile apps. Desktop editions share a merge-safe library while keeping separate session state; iOS storage is private unless an entitled App Group is configured. [Native build and usage guide](plugin/README.md).

| New native edition | v1.0.4 download |
| --- | --- |
| Mac cue standalone — Apple Silicon + Intel | [Standalone app ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.4/Beatmaker-Cues-Plugin-Standalone-1.0.4-macOS-universal.zip) |
| Windows cue standalone — x64 | [Standalone EXE ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.4/Beatmaker-Cues-Plugin-Standalone-1.0.4-Windows-x64.zip) |
| Mac AU + VST3 | [Universal plug-in ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.4/Beatmaker-Cues-Plug-ins-1.0.4-macOS-universal.zip) |
| Windows VST3 | [x64 plug-in ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.4/Beatmaker-Cues-Plug-ins-1.0.4-Windows-x64.zip) |

For sample pads, open **Cues**, enable the **music-note button beside MIDI**, select a pad and choose **Load sample…**. Turn editing off to perform. A loaded sample plays an independent one-shot and never marks/jumps a cue; removing it restores normal cue behavior.

<p align="center">
  <a href="docs/screenshots/discover-samples.png"><img src="docs/screenshots/discover-samples.png" alt="Discover Samples opening page with live search and the global player bar" width="100%"></a>
</p>

| Studio and cue timeline | Music library |
| :---: | :---: |
| <a href="docs/screenshots/studio.png"><img src="docs/screenshots/studio.png" alt="Beatmaker studio with waveform cues and twelve cue pads"></a> | <a href="docs/screenshots/library.png"><img src="docs/screenshots/library.png" alt="Pitch-black music library with playlists, favorites and now playing panel"></a> |

[Discover search with matching YouTube playlists](docs/screenshots/discover-search.png)

<p align="center">
  <a href="docs/screenshots/settings.png"><img src="docs/screenshots/settings.png" alt="Settings with appearance, English, French and Spanish language options" width="420"></a>
</p>

## Install on macOS

Requires macOS 12 or newer.

| Mac | Download |
| --- | --- |
| Apple Silicon — M1 and newer | [macOS ARM64 DMG](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.4/YT-Beatmaker-Cues-Desktop-1.0.4-macOS-arm64.dmg) |
| Intel | [macOS x64 DMG](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.4/YT-Beatmaker-Cues-Desktop-1.0.4-macOS-x64.dmg) |

Open the DMG and drag **YT Beatmaker Cues Desktop** to **Applications**. The first launch downloads yt-dlp, Deno and FFmpeg for playback.

The app is ad-hoc signed and is **not Apple-notarized**. If macOS blocks it, attempt to open it once, then use **System Settings → Privacy & Security → Open Anyway**. If macOS reports that the app is damaged, remove its download quarantine flag:

```sh
xattr -dr com.apple.quarantine "/Applications/YT Beatmaker Cues Desktop.app"
```

Personal data lives in `~/Library/Application Support/YT Beatmaker Cues Desktop`, separate from an existing Musike installation.

### Share the Mac app without the Privacy & Security prompt

Build a clean copy for another Mac with:

```sh
pnpm share:mac          # this Mac's architecture
pnpm share:mac x64      # Intel Mac
pnpm share:mac arm64    # Apple Silicon
```

This creates `release/share/YT-Beatmaker-Cues-Desktop-<version>-macOS-<arch>/` plus a matching `.zip`, with no download quarantine flag.

- **USB drive:** copy that folder or just `YT Beatmaker Cues Desktop.app` to the USB drive, then drag it into Applications on the other Mac. It opens directly.
- **AirDrop:** send the folder or zip, unpack it, then run `Install.command`. It installs the app and clears the quarantine flag locally.

AirDrop adds a quarantine flag to everything it sends, so an app sent that way still needs `Install.command` (or `xattr -dr com.apple.quarantine "/Applications/YT Beatmaker Cues Desktop.app"`) before macOS will open it. To remove that step entirely, the app would need to be signed with an Apple Developer ID and notarized.

## Install on Windows

Download the [full desktop studio Windows x64 installer](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.4/YT-Beatmaker-Cues-Desktop-1.0.4-Windows.exe) for Windows 10 or 11. Run it and choose an installation folder. User data is preserved when upgrading. The new native cue standalone and VST3 are separate downloads in the table above.

## Install on Linux

The latest verified Linux installers remain v1.0.3; the v1.0.4 release inventory covers Mac, Windows, Android and iOS.

| Processor | Portable AppImage | Debian / Ubuntu |
| --- | --- | --- |
| x64 | [AppImage](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.3/YT-Beatmaker-Cues-Desktop-1.0.3-Linux-x64.AppImage) | [.deb](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.3/YT-Beatmaker-Cues-Desktop-1.0.3-Linux-x64.deb) |
| ARM64 | [AppImage](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.3/YT-Beatmaker-Cues-Desktop-1.0.3-Linux-arm64.AppImage) | [.deb](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.3/YT-Beatmaker-Cues-Desktop-1.0.3-Linux-arm64.deb) |

For AppImage, enable **Allow executing as a program** in the file's properties, then open it. For Debian/Ubuntu, install the downloaded package with `sudo apt install ./YT-Beatmaker-Cues-Desktop-1.0.3-Linux-x64.deb` (use the ARM64 filename on ARM machines).

## Android and iOS — Beatmaker Cues

- [Native Android APK](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.4/Beatmaker-Cues-1.0.4-Android-arm64.apk) — Android 7/API 24+, arm64, persistent release-key signature. See [migration from the older app](docs/android-1.0.4-migration.md).
- [Native iOS IPA with AUv3](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.4/Beatmaker-Cues-1.0.4-iOS-unsigned.ipa) — unsigned; sign it with your Apple account before installing.
- [Portable native iOS Xcode project](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.4/Beatmaker-Cues-Plugin-Xcode-1.0.4.zip) — Xcode, iPhone/iPad on iOS 15+; includes dependency sources and the embedded AUv3 target.
- [Portable native Mac Xcode project](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.4/Beatmaker-Cues-Plugin-Xcode-1.0.4-macOS.zip) — standalone, AU and VST3 targets.

Both mobile apps share sixteen cue pads, ten saved banks, sequential **Mark across banks**, IN/OUT loops, **1% speed faders**, independent semitone tuning and native MIDI inputs. The native players own the playlist and prepare the next track so screen-off track changes do not depend on WebView JavaScript. Desktop also has sixteen pads, cross-bank Mark and the same MIDI presets.

Current native source projects live under [`plugin/`](plugin/), including [`plugin/Android/`](plugin/Android/). The older Capacitor/Swift implementation remains under `mobile/` for migration and development. In the native Xcode export select `BeatmakerCues_Standalone` and your own signing team for the container and AUv3. Physical iOS Lock Screen/next-track acceptance is still pending; Android emulator screen-off/uncached-next-track checks passed.

## What's inside

- **Discover Samples:** the opening page, with searchable music crates, live previews, favorites and one-click loading into the studio.
- **Your library in Discover:** recently played tracks and saved playlists, with playlist-name matches included in search.
- **Studio playlists:** create a playlist, add tracks with the playlist button on each card, and choose a collection to keep the studio library focused.
- **YouTube playlists:** song searches in Discover include a horizontal playlist row. Open a playlist to preview its songs, then choose **Add playlist to library**. A dedicated YouTube playlists search is also available in the studio and music browser; playlist links work too. Imports include up to 500 playable public tracks and show when that limit is reached.
- **Studio library management:** saved playlists are visible above the track list. Select one to browse its songs. Trash controls remove a track from that collection, or delete the playlist; in **All tracks**, removing a song also removes it from favorites, history and every saved playlist.
- **Included drum banks:** 30 real kick, snare and hi-hat WAV files with working preview and download actions, available without an internet connection in the desktop app.
- **Music discovery:** search YouTube Music, paste a YouTube link, browse the full Musike catalog, and keep favorites and playlists.
- **Cue workspace:** 16 pads, A–J banks per track, sequential Mark, keyboard/MIDI triggering, Shift-click cue replacement, and local autosave.
- **Performance:** original Pitch / Speed / Speed HD, region loops, sequencer, FX Pad, sidechain, audio/video loopers and MIDI controls.
- **Video:** audio/video switching, VJ tools and a separate projection window for the current player.
- **Optional AI stems:** the original locally running stems engine with a separately downloaded, verified model.
- **Sessions:** export and import `.beatmaker.json` files containing track references and cue banks.
- **Reference-inspired interface:** near-black surfaces, fine borders, white active controls, a cover library and a four-column pad grid.

## Quick start

1. Start on **Discover Samples**. Choose a music category or search, preview a track and click **Load in Studio**. The included kick, snare and hi-hat collections also have playable, downloadable WAV hits.
2. In the studio, click an empty pad to mark the current time. Click an assigned pad to trigger it; **Shift-click** to replace it.
3. Use **1–9 / 0** for the first ten cues and the **A–J** bank buttons for more cue sets.
4. **Cues / Loop** toggles the compact performance bar; click it again to hide it, or to rebuild it after **Advanced** removes it. Open **Sequencer**, **FX Pad**, **Sidechain**, **VJ** or **Advanced** for the original Beatmaker tools. See [studio toolbars and panels](docs/beatmaker-desktop.md#studio-toolbars-and-panels) for what each one does.
5. Use **Save / Load** to move a cue session between installations.

See the [detailed guide](docs/beatmaker-desktop.md) for architecture, shortcuts and session-format details.

### Control verification

Controls are connected to real playback, files, library APIs or the original engine. **MAP** opens MIDI mappings. Controls that require a loaded track or a video source are disabled until one is ready. Unsupported Chrome-tab options and studio-inapplicable appearance settings are not offered. See the [control audit](docs/control-audit.md) for verified actions and hardware-dependent checks.

## Version 1.0 scope

Installers are provided for macOS Apple Silicon/Intel, Windows x64 and Linux x64/ARM64, plus Android/iOS test builds and an Xcode project.

- One music player is integrated. Chrome's multi-tab VJ feeds are not multiple desktop decks.
- Session exports contain track metadata and cue banks, not recorded audio, the AI model or every engine preference.
- Hardware MIDI, external audio routing, projector output and full AI inference need testing with the intended devices and model installed.
- Core playback and cue checks use a deterministic HTTP Range audio fixture; the packaged Apple Silicon app has also been launch-tested. Intel packages have been built and signature-checked, but not run on Intel hardware.

## Build from source

Complete [v1.0.4 source ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.4/Beatmaker-Cues-Source-1.0.4.zip), [source TAR.GZ](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.4/Beatmaker-Cues-Source-1.0.4.tar.gz), and [native corresponding source with pinned dependencies](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.4/Beatmaker-Cues-Plugin-Source-1.0.4.zip) are attached to the release. `main` and `release/1.0.4` contain the plug-in keyboard refresh; tag `v1.0.4` preserves the initial release. Per-asset build records identify their source. [Detailed build instructions](docs/build-from-source.md).

Requires **Node.js 22.19+** (Node 24 recommended) and **pnpm 10**. Build each installer on its target operating system; GitHub Actions builds all three platforms.

```sh
git clone https://github.com/jrucho/YT-Beatmaker-Cues-Desktop.git
cd YT-Beatmaker-Cues-Desktop
pnpm install --frozen-lockfile
pnpm typecheck
pnpm installer:mac
```

Use `pnpm installer:win` on Windows or `pnpm installer:linux` on Linux. Installers are collected in `release/`. To run the desktop app during development, use `pnpm desktop`. For a browser preview: `pnpm build && pnpm start`, then open `http://localhost:4180/?workspace=beatmaker`.

Run the automated application checks after building:

```sh
pnpm exec playwright install chromium
pnpm test:app
```

The checks use an isolated local library and deterministic audio/video fixtures. Your personal library is not used.

## Project structure

| Folder | Contents |
| --- | --- |
| `web/src/beatmaker/` | Workspace UI and app integration adapter |
| `YTbeatmakercues/` | Supplied original extension, version 2.4.5 |
| `desktop/` | Electron shell, packaging and installer collection |
| `server/` | Musike catalog, stream proxy and local library |
| `web/` | React player and full music browser |
| `mobile/` | Android and iOS projects, native audio/MIDI and packaging scripts |

Internal `@musike/*` workspace names are retained for compatibility. The desktop application and this project are versioned independently of the extension engine.

## Credits and license

Maintained by [jrucho](https://github.com/jrucho).

- Built on [Musike by Ernani Neto](https://github.com/Ernani1234/musike), MIT. The original [license](LICENSE) and [upstream documentation](docs/upstream-musike.md) are preserved.
- Includes the supplied YT Beatmaker Cues 2.4.5 source and sample/worklet assets.
- Uses Signalsmith Stretch and ONNX Runtime Web; see [third-party notices](YTbeatmakercues/THIRD_PARTY_NOTICES.md). The optional HT-Demucs model is downloaded separately.

For personal and educational use. Playback depends on YouTube availability and may be affected by upstream changes. Respect YouTube's terms and artists' rights; see the [upstream legal notice](docs/upstream-musike.md#legal-notice).
