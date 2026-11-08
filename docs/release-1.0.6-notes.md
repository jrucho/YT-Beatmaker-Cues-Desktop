# Beatmaker Cues 1.0.6 — native input release

## What's new

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
pinned dependency/source archives. Full Electron desktop studio and Android
installers remain available in v1.0.5.

## Verification and installation

See [native input verification](native-input-1.0.6.md) for the checks and commands.
The real Cocoa/WKWebView fixture verifies rendering during a 450 ms JavaScript
stall, one-time UI claims and sibling-browser isolation. The iOS Simulator fixture
exercises the actual UIKit observer, WKWebView and renderer with injected touches;
it is not a physical touch or acoustic-latency test.

The local registered-device profiles expired November 7, 2026. Xcode currently
cannot renew the existing app/extension bundle IDs for the original team, so
physical iPhone/iPad acceptance of this version is pending. The public unsigned
IPA and portable Xcode project use the installer's own valid signing account.
Personal provisioning is excluded from public exports.

Existing bundle IDs and native plug-in codes retain saved-data/DAW compatibility.
Quit/rescan the DAW before replacing plug-ins. Mac packages are ad-hoc signed;
Windows requires WebView2 Runtime and uses FFmpeg for fallback decoding. DAW and
device output buffers are separate from native input forwarding; no new physical
iOS or desktop end-to-end latency figure is claimed.
