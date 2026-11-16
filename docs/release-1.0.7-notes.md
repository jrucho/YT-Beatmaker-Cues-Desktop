# Beatmaker Cues 1.0.7 — Apps and plug-ins

[Download the 1.0.7 apps, plug-ins and corresponding source](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/tag/v1.0.7).

## Linux native edition added to this release

**Linux x64 VST3 and cue standalone are now included**, with product version
**1.0.7** retained. The existing Mac, Windows, Android and unsigned-iOS binaries
and their exact source downloads remain unchanged.

- [Debian/Ubuntu installer — VST3 + standalone](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/Beatmaker-Cues-Plug-ins-1.0.7-Linux-x64.deb)
- [VST3 + standalone ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/Beatmaker-Cues-Plug-ins-1.0.7-Linux-x64.zip)
- [Standalone-only ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/Beatmaker-Cues-Plugin-Standalone-1.0.7-Linux-x64.zip)
- [Exact Linux corresponding source, including pinned dependencies](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/Beatmaker-Cues-Plugin-Source-1.0.7-Linux-x64.zip)

Requires **Ubuntu 24.04-compatible x86-64 and X11/XWayland**. This is the
responsive native edition, **not a new full desktop AppImage or ARM64 build**.
Linux-specific JUCE fixes repair the WebKit child launcher, Unicode transport and
runtime-library loading. All seven native suites, 123 browser/native FX cases,
the real offline WebView/audio/500-track Unicode test, a separate VST3 host and
clean-Ubuntu installed-package startup pass in
[Linux CI 43887845345](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/actions/runs/43887845345).
Physical audio-interface/latency and third-party Linux DAW acceptance remain manual.

## Refreshed 1.0.7 crossfade build

The 1.0.7 downloads have been refreshed in place; the product version remains
**1.0.7**. This refresh adds overlapping song transitions, binds waveforms to the
song they belong to, and removes settings-fader jitter.

Songs now overlap during a transition instead of fading to silence and back in.
The outgoing and incoming songs keep independent speed/pitch/tuning and decoder
state, use equal-power mixing, and preload the next song. The crossfade defaults
to **3 seconds** and is adjustable from **0.05 to 10 seconds** in Settings; the
legacy 350 ms preference migrates to the new default. Manual and natural
transitions both overlap, while cue jumps remain immediate. The waveform view is
bound to its track, so a stale outgoing waveform cannot replace the incoming
song's display.

The Speed and crossfade-duration faders now reset on double-touch or
double-click (0% and 3 seconds), and the settings readout reserves a fixed-width
column so the fader does not move while its numbers change.

The earlier keyboard-looper press/release correction remains included in these
same packages. Number keys keep their pad/bank ownership through key-up, losing
focus releases transient holds, and intentional long holds still clear.

**Re-download the matching package**, quit the app/DAW, replace the old native
app/plug-in and rescan/reopen. The full desktop studio retains its version-only
maintenance behavior below.

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
- **Song transitions:** overlapping equal-power crossfade with independent
  outgoing/incoming voices, On by default, with saved Off/Instant and a
  0.05–10 second duration setting. Cue jumps remain immediate.
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
- **Linux:** install both native products with
  `sudo apt install ./Beatmaker-Cues-Plug-ins-1.0.7-Linux-x64.deb`.
  The standalone appears in the application menu; the VST3 is in
  `/usr/lib/vst3/Beatmaker Cues.vst3`. Rescan the DAW. ZIPs do not install runtime
  dependencies; the included `python3 install.py` copies the VST3 to `~/.vst3`.
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
records identify the exact corrected source commit, CI run and completed checks
for each asset. The seven original **Mac, Windows, Android, iOS and source** jobs
remain the verified baseline for the preserved assets; the additive Linux build
has its own successful CI run and exact corresponding source. Future coordinated
builds additionally require the Linux native job. Native regressions cover manual, natural, paged and cancelled
crossfades at 44.1/48/96 kHz, independent stretched/varispeed voices, failed
destination preservation, track-bound waveform polling and stale-response
rejection. Browser suites cover desktop and Android, including real double-touch
fader reset and unchanged slider bounds across 0.05–10 seconds. The real API-35
Android device suite covers imports, gallery cancellation, recording and
sample-only performance. Mac AU validation, actual native keyboard-looper
recordings, and Mac/Windows VST3/WebView host checks accompany the platform
builds.

At the user's explicit request, the verified Linux native edition is added to the
existing public release. Its build commit is
`2946741190d42a09f6c59d0a2658dfdbd89c85eb`, independently recorded in the Linux build
record and source archive. Other platform packages and source downloads are
byte-preserved. [Linux verification details](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/blob/release/1.0.7/docs/linux-native-validation-1.0.7.md)
describe automated coverage and hardware limits. Full desktop Linux installers
retain their earlier release version.

The original v1.0.7 tag is retained at
`13bfdcd20ce28effd03a1b300666db98d9527627`; the refreshed assets/build records identify
their newer corrected source independently. **Use the attached source archives**
for the current native build. GitHub's automatic source archives for the original
tag preserve the initial baseline and do not contain these crossfade, waveform,
fader or Linux fixes. `Release-Build-1.0.7.json` records the original tag,
publication commit and the source commit for each individual asset.

Use **Beatmaker-Cues-Source-1.0.7.zip** or **Beatmaker-Cues-Plugin-Source-1.0.7.zip**
for the preserved Mac/Windows/Android/iOS native builds. For Linux, use
**Beatmaker-Cues-Plugin-Source-1.0.7-Linux-x64.zip** and its separate source build
record. The Linux source archive unpacks to `Beatmaker-Cues-Plugin-Source-1.0.7/`.
Use the separate **Desktop-Source** ZIP for the intentionally frozen full desktop
studio. **SHA256SUMS-1.0.7.txt** lists every published asset checksum.
