# Beatmaker Cues Plug-in — 1.0.4

## Separate desktop-layout beta

The normal product keeps the mobile-style editor. A separate **Beatmaker Cues
Desktop Beta** uses the desktop studio layout with native cue/loop/speed/pitch
playback into the host bus. It has its own plug-in code `BmDB`, bundle ID
`app.owaega.beatmakercues.desktopbeta` and `Beatmaker Cues/DesktopBetaLibrary`
storage, so it can coexist with the normal product without replacing its data.

Build its interface with `python3 plugin/Scripts/build_mobile_ui.py .
--desktop-beta`, then configure a fresh CMake directory with
`-DBEATMAKER_DESKTOP_BETA=ON`. Its archives are labelled `Desktop-Beta`.

This is a **desktop-interface/core-controls beta**, not full desktop DSP parity:
stems, browser FX, sequencer, sidechain and VJ are not host-routed. Unsupported
actions report this limitation; native controls are available from the labelled
panel. Audio must remain on the DAW bus. Mac tests verify actual desktop pad
clicks triggering/marking native cues, live catalog/audio and state restoration.
Windows/Linux and real-host acceptance are still required.

Native instrument and standalone targets integrated into the main Beatmaker Cues
repository. The editor embeds the shared mobile React interface; JUCE renders
audio into the host bus. Search and playback use native networking and do not
require the Electron desktop app or its server.

## Targets and installation

| Platform | Native targets | Requirements |
| --- | --- | --- |
| macOS 12+ | AU, VST3, standalone | Apple Silicon or Intel build; CI targets universal |
| Windows | VST3, standalone | x64; WebView2 Runtime; FFmpeg on PATH for formats without native decoding |
| Linux | VST3, standalone | x64; WebKitGTK 4.1, GTK3, ALSA, CURL, FFmpeg |
| iOS/iPadOS 15+ | AUv3 instrument and standalone container | Own Apple signing account for the unsigned IPA/Xcode export |

Unpack a native plug-in ZIP and run `python3 install.py` (Windows: `python
install.py`). This installs AU/VST3 in your user's plug-in directory. Restart or
rescan the DAW, create a software-instrument track, and select **Owaega → Beatmaker
Cues Plug-in**. The `Standalone` directory contains the separate plug-in app.
Windows hosts may require adding `%LOCALAPPDATA%/Programs/Common/VST3` to their
scan paths. Linux also has a `.deb` package with runtime dependencies.

Mac packages are ad-hoc signed, without Apple notarization. Windows/Linux packages
are unsigned. The iOS container embeds the AUv3 extension; open the container once,
then add the instrument in a compatible AUv3 host. Portable Xcode exports include
dependency sources and generated inputs, so Node and CMake are unnecessary for
building that export. Choose your own development team for both Apple targets.

The legacy bundle ID `app.owaega.beatmakercuesprototype`, manufacturer `Owga`,
plug-in code `BmCP` and internal CMake project name remain unchanged for existing
data and DAW-state compatibility. If replacing a local prototype installation,
keep only one installed binary with these IDs in each plug-in format's scan path.

## Library, sessions and local media

- Library edits save automatically to disk using an interprocess lock, atomic
  replacement, valid backups and revisioned, keyed three-way merging.
- Separate plug-in instances using the same data directory share the durable
  library. A fresh processor can reopen it without DAW state.
- Transport, cue maps and other session settings have separate
  `Sessions/<sessionId>.json` snapshots. DAW state retains the session ID and
  native playback state; the standalone uses a stable `standalone` session.
- Legacy library data from DAW state is migrated and archived under
  `LegacyImports`. Missing imported files remain registered and report a missing
  file rather than silently deleting the saved reference.
- The library lives under `Beatmaker Cues/PluginLibrary` in JUCE's platform
  application-data directory (`LibraryStore::defaultDirectory`); imported media
  copies use its `Media` folder. Remote downloads retain the legacy
  `BeatmakerCuesPrototype/Media` cache. `BEATMAKER_PLUGIN_DATA_DIR` overrides
  library/session/import storage for isolated tests.
- **No App Groups or automatic main-app ↔ AUv3 library sharing are configured.**
  Main desktop/mobile apps and the plug-in retain their own storage. On iOS,
  sandbox boundaries also separate the container and extension's stores.

Keep downloaded/imported media available: DAW state references local files,
rather than embedding complete audio in the project.

## Playback and controls

Search, catalog browsing, favorites, playlists, local imports and Cues use the
shared mobile interface. Search is explicitly submitted; typing does not start
background catalog searches. Native workers resolve, download, decode and prepare
the next song. The native playlist can advance with the editor closed.

Mode A/B have sixteen pads; Legacy has twelve visible pads and preserves hidden
cues. Sequential Mark fills empty pads through banks A–J. MIDI marks empty pads,
triggers saved cues and releases highlighting on Note Off without stopping
one-shot playback. Native pad states are batched separately from slower metadata
updates. Mode A uses channels 1–10; Mode B uses channels 1/2 and bank note ranges.

Cues use one native command and a 3 ms raised-cosine incoming transition joined
to the last rendered sample, including rapid retriggers and pitch processing.
Speed with pitch preservation, independent tuning and coupled varispeed use
Signalsmith Stretch/native resampling. Unity speed without tuning bypasses stretch.
The processor reports zero added look-ahead; host buffers and hardware still
determine physical latency. Desktop Web Audio, main iOS AVAudioEngine and main
Android Media3 remain platform-specific audio paths.

Decoded audio must fit the 192 MB stereo limit; remote encoded transfers are
limited to 64 MB. YouTube availability and resolution can change independently
of the application. Desktop-only Advanced/stems/VJ tools are not embedded here.

## Build from this repository

Run from the repository root after `pnpm install --frozen-lockfile`:

```sh
python3 plugin/Scripts/build_mobile_ui.py .
cmake -S plugin -B plugin/build-mac -DCMAKE_BUILD_TYPE=Release \
  '-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64' -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0
cmake --build plugin/build-mac --config Release --parallel 3
ctest --test-dir plugin/build-mac -C Release --output-on-failure
python3 plugin/Scripts/package_release.py --build-dir plugin/build-mac \
  --platform macOS --arch universal
```

Use a platform-native C++17 compiler and CMake 3.24+. Windows needs the WebView2
SDK configured through `JUCE_WEBVIEW2_PACKAGE_LOCATION`; Linux needs the native
development dependencies listed in `.github/workflows/plugins.yml`.

For iOS, configure with `-G Xcode -DCMAKE_SYSTEM_NAME=iOS
-DCMAKE_OSX_SYSROOT=iphoneos -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0
-DCMAKE_OSX_ARCHITECTURES=arm64`, then archive the `BeatmakerCues_Standalone`
scheme. `Scripts/package_ios.py` verifies the real container, embedded AUv3 and
arm64 binaries. `Scripts/export_xcode.py` creates a portable source project.
`Scripts/patch_juce_ios.py` guards app-only APIs while preserving extension-safe
build settings. Select a full Xcode through `DEVELOPER_DIR` if needed.

## Verification and release status

Local 1.0.4 checks have passed for the Mac AU/VST3/standalone compilation,
VST3 host probe, real AAC/M4A decoding, all 320 Mode A/B mappings, sample-offset
MIDI, one-shot releases, cue continuity, pitch/speed frequency, checked audio
callbacks without C++ heap allocations, editor-closed queue advancement, and
durable/concurrent library recovery. The actual WebView integration passes live
catalog/search/playback and library/cue restoration checks. The iOS container
and embedded AUv3 archive compile unsigned; the portable Xcode export has also
built independently.

Windows/Linux native CI and physical iPad/AUv3-host checks are still pending for
1.0.4. Actual Logic/Ableton listening, device CPU/underruns, multi-instance host
behavior and background behavior require host/hardware verification. Local
compilation and automated checks alone do not establish production readiness.
Build JSON/checksum files identify platform, architecture, source and checks.

## Dependencies and licensing

JUCE 8.0.12, Signalsmith Stretch and Signalsmith Linear are pinned in
`CMakeLists.txt`. JUCE is AGPLv3/commercial; the main application's MIT license
does not grant a commercial JUCE license. Native packages include the dependency
license texts; Xcode exports include dependency sources. Distribution must meet
the chosen dependency licenses, including applicable corresponding-source terms.
