# Beatmaker Cues 1.0.6

[Download 1.0.6 apps, plug-ins and source](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/tag/v1.0.6).
The tag preserves the initial native build baseline
`d51cc4ee6093ae6489faab0d1b4bc30a53803faf`. Per-asset build records identify the
additional Android/full-desktop builds and corresponding-source refresh.

## What's new

- **Android 1.0.6 maintenance build:** retains native touch forwarding, adaptive
  accepted-stream buffering and selected-bank cue caching from the 1.0.5 refresh,
  with the current shared cue UI and release version. Existing app ID and release
  signing certificate support an in-place update with saved data preserved.
- **Full desktop studio 1.0.6:** newly built Mac Apple Silicon/Intel DMGs and
  Windows x64 installer align the product version. Studio features and audio
  behavior match 1.0.5, including the original stems, VJ, FX, sequencer and
  sidechain implementation. This is a maintenance/version-alignment build.
- **iOS/AUv3:** a simultaneous UIKit observer sends saved cue/sample touch-down
  into the native audio queue without cancelling or delaying normal WebKit input.
- **Mac AU/VST3/standalone:** Cocoa mouse-down takes the same early native route.
- **Windows VST3/standalone:** scoped WebView2 mouse/pointer observation forwards
  native input while preserving ordinary browser events.
- **One physical event, one audio hit:** event-time receipts reconcile the UI;
  delayed events do not retrigger a cue/sample. Pre-jump position is retained for
  long-press marking. Stale audio generations, native track revisions, resized
  layouts and removed sample assignments are guarded.
- **Per-editor isolation:** each observer resolves its own embedded browser,
  including multiple plug-in editors sharing one native host window.
- **Selected-bank preparation:** the attack cache and chunked decoder refill
  introduced in the Android refresh now ship in the Apple/desktop native builds.
  The stereo PCM budget remains 16 MiB; decoding, stretch, speed, tuning and cue
  transitions retain their existing quality.

Samples still play without a loaded song, and take priority over cue marking.
Empty pads, Overwrite, sample editing, dialogs, deletion and zoom/layout changes
retain their normal behavior. Hosted keyboard isolation, number-pad shortcuts,
saved sessions and sample-offset external MIDI remain supported.

## Release scope

Native Mac universal AU/VST3/standalone, Windows x64 VST3/standalone, unsigned iOS
container with embedded AUv3, portable Apple Xcode projects, complete source and
pinned dependency/source archives, signed native Android arm64 APK, and full
Electron desktop studio installers for Mac Apple Silicon/Intel and Windows x64.
The earlier [v1.0.5 release](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/tag/v1.0.5)
remains available.

## Verification and installation

See [native input verification](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/blob/main/docs/native-input-1.0.6.md) for the checks and commands.
The real Cocoa/WKWebView fixture verifies rendering during a 450 ms JavaScript
stall, one-time UI claims and sibling-browser isolation. The iOS Simulator fixture
exercises the actual UIKit observer, WKWebView and renderer with injected touches;
it is not a physical touch or acoustic-latency test.

[Windows native CI](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/actions/runs/42490254439)
also passes real SendInput/WebView2 single-hit behavior through a 450 ms renderer
stall, the six native suites, VST3 MIDI/audio/state/editor and installer checks.
Both portable Apple projects compile independently after extraction. Published
asset digests match the versioned checksum manifest.

The public unsigned IPA and portable Xcode project use the installer's own valid
signing account. A separate local 1.0.6 build was installed and launched on the
registered iPhone after fresh seven-day provisioning, with saved playlists,
cues and samples migrated and verified. This is installation/data verification;
physical input-to-speaker and iPad acceptance remain separate checks. Personal
provisioning is excluded from public exports.

Existing bundle IDs and native plug-in codes retain saved-data/DAW compatibility.
Quit/rescan the DAW before replacing plug-ins. Mac packages are ad-hoc signed;
Windows requires WebView2 Runtime and uses FFmpeg for fallback decoding. DAW and
device output buffers are separate from native input forwarding; no new physical
iOS or desktop end-to-end latency figure is claimed.
