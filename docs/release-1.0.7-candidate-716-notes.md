# Beatmaker Cues 1.0.7 — development candidate 716

This prerelease brings the iPhone-first performance and recording features to
the native Android app and responsive native plug-in/standalone edition.

## Downloads

| Download | Contents and installation |
| --- | --- |
| **Android arm64 development APK** | Includes recording, import, gallery and the corrected audio menu. Install over development candidate 715; it uses the same development app ID and certificate. It is a separate app from the normal release-signed Android installation. |
| **macOS universal plug-ins ZIP** | VST3, AU and the plug-in standalone app for Apple Silicon and Intel. Extract and run the included `install.py` to install plug-ins, then rescan your DAW. |
| **macOS universal standalone ZIP** | The native plug-in standalone app without the AU/VST3 bundles. |
| **iOS unsigned IPA** | iPhone/iPad app with embedded AUv3, internal build **1.0.716**. Requires your own compatible signing method; personal device provisioning is excluded. |
| **Candidate source ZIP** | The corresponding working-source snapshot for these binaries. Includes the native engine, shared UI and build/patch scripts; dependency revisions are pinned in `plugin/CMakeLists.txt`. |

## What's new

- **Android audio-menu correction:** fixes candidate 715 opening Import audio with
  only a title. The panel now uses the measured native viewport, and all source
  buttons are verified visible and touchable through real Android input.
- **Import and recording:** Files, phone-gallery video audio, microphone/USB input
  or Beatmaker playback. New audio enters **Imports** and loads in Cues automatically.
  A **New empty track** action supports recording/sample performance without a song.
- **Simpler import menu:** the app-library songs/videos browser and Chop current
  song action are removed from Import audio. Contextual sample-pad chopping remains.
- **Monitoring:** device loss mutes input monitoring, retaining the previous On
  request for the same accepted route to return. Manual Off cancels restoration.
- **Hosted plug-in input:** optional **Recorder input** bus, disabled by default
  (VST3 sidechain). Route audio in the DAW, then select **DAW audio input** in the
  recorder. Input monitoring defaults Off and device routing remains DAW-owned.
- **Song fades:** sequential fade-out/fade-in is On by default at 350 ms.
  **Settings → Song transitions** offers Off/Instant and duration adjustment.
  Cue jumps remain immediate.
- **Song options:** rename imported/recorded songs, export/share their original
  audio, or permanently delete managed audio from the library.
- **Pad editing:** saved 16/12-pad numbering, velocity On/Off, paired A/F–E/J banks,
  shared undo/redo, retained-source waveform editing and held-pad audition.
  Hold one normal cue/sample pad for more than three seconds to move/swap contents
  between fixed numbered pads. Pad copying is not implemented.
- **Internal event loopers:** per-song/bank/pad record/play/overdub, layer undo/redo,
  native hold/release gestures, and distinct saved looper colour/pulse feedback.
- **Compressor and mixer:** native compression and separate song/cue/sample levels.
- **Smooth playback display:** frame-rate waveform playhead and transport fill,
  without redrawing the static waveform or making 60-Hz native bridge calls.
- **Cues refinements:** icon-only Clear/Overwrite, aligned recorder toolbar,
  disabled text selection/long-press callouts, and preserved Android erase-X styling.

## Verification and scope

Passed locally: TypeScript; shared native browser checks; all six native CTests;
real Android WebView/JNI/device-callback import, gallery, recording and looper
checks; actual VST3 host input/monitoring PCM, state and editor checks; Cocoa/
WKWebView keyboard/native-input integration; standalone device-callback recording;
iOS UIKit/recording simulator fixtures; signed arm64 iOS/AUv3 compilation;
universal Mac builds and package signature checks.

Physical USB/SP-404 route acceptance, acoustic latency and musical DAW listening
remain device/host acceptance checks. Windows and Linux candidate binaries are
not included. This is the responsive native edition; the separate full desktop
studio is not updated by this candidate.

The Android APK uses `app.owaega.beatmakercuesstandalone.development` and does not
replace the normal release app or share its saved library. A normal in-place
release update requires the persistent release signing key.

## Source provenance and integrity

The binaries were built from an uncommitted development tree based on
`a7e5a2034cbf3a36a9c01e67b389b41e4d54537d`. Use the **attached candidate source ZIP**
for the actual development source. GitHub's automatically generated source archives
for the release tag represent the committed baseline, not these working-tree changes.

`Candidate-Build-1.0.7-716.json` identifies the packages and corresponding source;
`SHA256SUMS-Candidate-1.0.7-716.txt` lists SHA-256 digests for the uploaded files.
