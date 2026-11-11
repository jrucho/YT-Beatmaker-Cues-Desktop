# Beatmaker Cues 1.0.7 — Apps and plug-ins

[Download the 1.0.7 apps, plug-ins and corresponding source](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/tag/v1.0.7).

## Native Android and plug-in edition

- **Recording and imports:** Files, phone-gallery video audio, microphone/USB input
  and Beatmaker playback recording. Imports automatically enter **Imports** and load
  in Cues. **New empty track** supports performing and recording without a song.
- **Corrected Android import menu:** all four source buttons remain visible and
  touchable. Supported M4A/AAC/FLAC/OGG/MP4 files are selectable in Files.
- **Hosted input and monitoring:** optional **Recorder input** bus, initially
  disabled (VST3 sidechain). The DAW owns hardware routing. Input monitoring starts
  Off; lost routes mute it, and the requested state returns with the same accepted
  route. Manual Off cancels restoration.
- **Song transitions:** sequential 350 ms fade-out/fade-in, On by default, with
  saved Off/Instant and duration settings. Cue jumps remain immediate.
- **Editing and workflow:** fixed-position cue/sample swaps, shared undo/redo,
  precise retained-source waveform/start editing, held-pad audition, durable song
  renaming, original-audio export/share and managed-audio deletion.
- **Performance settings:** per-song speed/mode/tuning, saved 16/12-pad numbering,
  velocity On/Off, paired A/F–E/J banks, compressor and song/sample mixer.
  Background session saves retain newer control edits instead of reapplying an
  older snapshot's preferences.
- **Internal event loopers:** record/play/overdub, layer undo/redo, native hold and
  release gestures, and saved active-looper colour/pulse feedback.
- **Smooth playback display:** frame-rate playhead and transport animation without
  full-waveform redraws or 60-Hz native bridge calls.

Hold one ordinary cue/sample pad for more than three seconds, then drag to move
its contents. An occupied destination swaps contents; physical pad numbers stay
fixed. The import menu is **Files · Phone gallery · Record audio · New empty track**;
contextual sample chopping remains available.

## Full desktop studio: version alignment only

The Mac Apple Silicon/Intel DMGs and Windows x64 installer rebuild the exact
published desktop **1.0.6** source baseline
`a7e5a2034cbf3a36a9c01e67b389b41e4d54537d`. Only the package/display version fields
change to **1.0.7**. Layout, playback, stems, VJ, FX, sequencer, sidechain and saved
data behavior are retained. The new native performance features above belong to
Android and the responsive plug-in/standalone edition.

`Main-Build-macOS-1.0.7.json` and `Main-Build-Windows-1.0.7.json` identify both the
release commit and this frozen desktop baseline. **Beatmaker-Cues-Desktop-Source-1.0.7.zip**
contains the exact desktop maintenance source, including its version-only metadata
changes. Build preparation verifies all baseline source files byte for byte.

## Installation

- **Android:** use `Beatmaker-Cues-1.0.7-Android-arm64.apk`. It retains the normal
  application ID and original persistent release certificate, supporting an
  in-place upgrade from the normal 1.0.6 installation. The candidate's separate
  development app and its library remain separate; use library export/import when
  transferring test data into the normal app.
- **Mac plug-ins:** use the universal AU/VST3 ZIP and its included installer, then
  rescan the DAW. A standalone-only ZIP is also provided. Mac packages are ad-hoc
  signed, as in 1.0.6.
- **Windows:** the native VST3/standalone ZIPs and the separate full desktop studio
  installer are distinct products. Native packages require WebView2 Runtime.
- **iOS:** the public IPA is unsigned and includes AUv3. Sign it with your own
  compatible account/method, or build the portable Xcode export. Personal device
  provisioning is excluded.

Existing application IDs and native plug-in codes retain saved-data and DAW
project compatibility. Quit the app/DAW before replacing its binaries.

## Verification and source

The user confirmed that **Android and VST work well after manual testing** of the
development candidate. That acceptance is recorded in
`docs/manual-acceptance-1.0.7.json`. It does not imply an unreported AU/AUv3 host,
hardware-route or acoustic-latency measurement.

Stable packages are rebuilt from the committed release branch, with native engine,
library, UI, VST3 host, platform packaging and desktop regression checks. The build
records identify the exact source and completed checks for each asset. Windows and
Linux native runtime verification is performed by their corresponding CI runners;
Linux full desktop installers retain their earlier release version.

Use **Beatmaker-Cues-Source-1.0.7.zip** or the plug-in corresponding-source archive
for the current native application source. Use the separate **Desktop-Source** ZIP
for the intentionally frozen full desktop studio. **SHA256SUMS-1.0.7.txt** lists the
published asset checksums.
