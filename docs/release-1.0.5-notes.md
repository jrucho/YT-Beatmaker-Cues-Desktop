# Beatmaker Cues 1.0.5

Current source is on `main` and `release/1.0.5`; tag `v1.0.5` preserves the initial
release baseline. Per-asset build records identify the Android refresh separately.
Download the apps, plug-ins and exports from the
[v1.0.5 release](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/tag/v1.0.5).

## What's new

- **Android selected-bank follow-up:** prepares the bank being performed before spare banks, with smaller pages and chunked decoder refills at the same 16 MiB PCM budget. Fixes later-bank starvation with all 160 cues marked. After preparation, all 48 checked presses across normal, stretched/tuned and slow/tuned playback had zero cache misses. Timing now includes any cache wait; repeated inset CSS writes and 60 Hz diagnostic round trips are reduced. Preparation and physical output latency are documented separately in the [performance notes](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/blob/main/docs/android-latency-1.0.5.md).
- **Android input-latency refresh:** saved cue/sample presses enter the native audio queue directly from Android touch-down, with one-hit UI reconciliation. Stretch, speed and pitch processing are retained. A stable two-burst default and underrun fallback prioritize clean playback. Emulator touch-event-to-render median improved from 10.14 to 7.12 ms; these figures exclude touch hardware and speaker/output latency. See [measurements and reproduction](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/blob/main/docs/android-latency-1.0.5.md).
- **Desktop Space-bar transport:** Space toggles play/pause across Discover, Studio and music/cue views, including after using pads or faders. Holding the key does not repeatedly toggle, and text fields retain normal spaces. Hosted plug-ins leave Space to the DAW.
- **Minimal pads:** native cue/sample pads have no external border/ring. Keyboard focus is drawn inside the pad.
- **Default 16-pad plug-in preset:** notes **36–51** in ascending pad order, on any MIDI channel, using the selected bank—Legacy 12 behavior with four more pads. Existing saved sessions retain their selected preset; select **16 pads** to use it in an existing project.
- **Accent colours:** the speed-fader line/thumb, brand/intro marks and waveform follow the app's selected accent.
- **Smaller iPad and iOS landscape layouts:** a readable dock on larger windows and a scrollable playlist overlay on smaller/shorter windows. Close controls remain available, collection headers are compact, and long playlist names wrap within the screen.
- **Consistent artwork:** loaded, missing and failed images occupy equal-size frames. Long recent titles are limited to two lines.
- **Recently Played list view:** Home and desktop Discover offer a persistent list/grid selector.

The native desktop/mobile apps retain sample pads, independent one-shot playback,
cue fallback, A–J banks, waveform editing, native playlist advancement and rate
smoothing. Hosted editors retain number-pad shortcuts while leaving letter/player
shortcuts to the DAW. Mac host routing sends one key-down/key-up pair, suppresses
repeat and releases outstanding keys on focus loss/editor close.

## Downloads

- Native Mac standalone and universal AU/VST3; Windows x64 native standalone and VST3.
- Full desktop studio: Apple Silicon/Intel Mac DMGs and Windows x64 installer,
  retaining the original stems, VJ, FX, sequencer and sidechain implementation.
- Signed native Android arm64 APK.
- Unsigned native iOS IPA with embedded AUv3, compatible with iOS/iPadOS 15+.
- Portable iOS and Mac Xcode projects, complete source ZIP/TAR.GZ, and native
  corresponding source with pinned JUCE/Signalsmith dependencies and licenses.
- Per-platform build records, `Release-Build-1.0.5.json` and `SHA256SUMS-1.0.5.txt`.

## Installation and compatibility

Quit/rescan the DAW when replacing plug-ins. Existing product IDs and stored data
are retained. Mac builds are ad-hoc signed, not notarized. Windows native builds
require WebView2 Runtime; FFmpeg supports fallback audio decoding. The public iOS
IPA is unsigned and portable projects use your Apple signing settings. Personal
registered-device signing stays local. Android retains its persistent native-app
release key; see [older Android migration](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/blob/main/docs/android-1.0.4-migration.md).

## Verification

TypeScript and controller-mapping checks, native engine/persistence suites, real
offline WebView playback, Cocoa host routing and VST3 host checks cover the native
builds. UI checks exercise 12 phone/tablet/plug-in shapes, accent-coloured fader
pixels, 500-song queue end reachability, long playlist headings, stable artwork
frames and persisted recent-list preferences. The full desktop studio has its own
browser regression checks and package/signature verification.

The Android refresh additionally checks raw touch/JNI single-hit behavior, source
and generation guards, layout changes, holds/Overwrite, sample import/playback/
editing/removal, a stalled renderer and uncached screen-off next-track playback.
Android/source assets identify the refresh commit; other platform binaries and
portable projects retain their initial v1.0.5 bytes and original build records.

Physical iOS screen-off/next-track acceptance and individual DAW/controller
acceptance remain device-specific. Linux v1.0.3 installers remain available in the
older release. The historical desktop-layout native beta remains a source target.
