# Android pad-input refresh — 1.0.5

The refreshed Android APK routes a saved cue or assigned sample from the Android
WebView's **native touch-down** directly to the existing C++ audio command queue.
React still receives the event for highlighting, player state and long-press
editing. An input-time-matched receipt reconciles that event without playing a
second hit, including after a delayed renderer event.

## Audio and input behavior

- Retains MediaCodec/page-cache decoding, Signalsmith Stretch, independent tuning,
  speed/varispeed, sample mixing and the existing cue transition.
- Starts at two supported native audio bursts, using the device's native output
  sample rate when available. Repeated underruns after startup increase buffering
  toward four bursts. The tested one-burst setting produced underruns on the
  emulator and is confined to an internal comparison build.
- Saved cues and sample pads use the fast path. Empty pads and cue Overwrite keep
  precise native-position marking; holding a saved cue captures its pre-jump
  position. Sample pads remain one-shots during Overwrite/hold and without a song.
- Sample management, dialogs, playlist overlays and deletion controls exclude
  underlying pads. Regions follow viewport/layout changes. Mismatched source or
  audio-generation maps fall back to the existing UI command path.
- Multiple UI pointers have independent hold timers. A pointer click does not
  replay an action already handled on down. Sample-management dialogs open on
  release so that the same finger cannot immediately dismiss their backdrop.

## Selected-bank follow-up

The initial two-pad timing fixture did not exercise a full ten-bank cue map.
With all 160 cues marked, its A-to-J prefetch order filled the cache before bank
J: a real Android comparison had **12 of 16 J presses** request decoding on demand
at +50% preserved-pitch speed and +5 semitones. A native regression also reproduces
the starvation after prefetch has settled.

The follow-up prioritizes the selected bank and cancels obsolete prefetch hints.
It uses 256 smaller 8192-frame pages at the same **16 MiB stereo PCM budget**,
preparing bounded attacks/continuation in source order. Chunked playback-window
refills avoid seeking away from cue preparation every time playback crosses a
page. DSP, source PCM, tuning, speed and the cue transition are preserved.

After selected-bank preparation, **48 of 48 presses** across unity, +50%/+5 st and
−50%/−7 st playback had **zero cache misses and zero new underruns**. Preparation
is measured separately and took about 6–10 seconds on the emulator for this
160-mark fixture; this is not a claim of instant cold-bank preparation. Current
raw reports, including preparation time, are in the Android build record.

Timing now remains pending through a cache-wait/silence block until the requested
cue PCM reaches the renderer. Diagnostics expose native render-block size and
elapsed time. Platform counters update at 10 Hz, while source/inset changes retain
next-tick updates; pad feedback remains at 60 Hz. Unchanged insets no longer write
CSS repeatedly: an idle-playback check went from 540 root-style mutations in 2.5
seconds to zero, with 25 diagnostic updates over that interval.

## Physical Nothing Phone (1) verification

Physical speaker tests on **A063 / Nothing OS 3.2 / Android 15** confirmed that
system effects influence the audio path. With Wavelet's global Dynamics
Processing active, AAudio rejected low-latency mode and accepted a regular-mixer
stream with 960-frame periods. With Wavelet off, the same float transport accepted
low-latency mode with **192-frame periods at 48 kHz (4 ms)**. The user approved the
short comparison and subsequently deactivated Wavelet manually.

The app now observes the stream that actually started: API, accepted performance
mode, sharing, sample format, period, queue size and capacity. Its default uses
two accepted periods and grows buffering after repeated underruns. It follows
stream-revision changes and avoids opening a second exclusive stream to guess
the period. This policy uses stream capabilities across Android devices.

Published builds retain JUCE's **float-first transport, Media/Music attributes
and native DSP**. Alternate usage/format comparisons are internal-probe controls;
they did not improve this phone's route and are confined to that build.

With Wavelet off, the final 72 physical pad presses used float stereo at 48 kHz,
a 384-frame queue, and produced **zero new underruns**:

| Preserved-pitch configuration | Median input-to-render | p95 input-to-render |
| --- | ---: | ---: |
| Unity / 0 st | 2.95 ms | 5.38 ms |
| +50% speed / +5 st | 3.83 ms | 5.94 ms |
| −50% speed / −7 st | 3.89 ms | 6.20 ms |

The earlier Wavelet-on comparison measured an 11.50 ms median with two regular
mixer periods. These comparisons include the system-effect configuration change.
The fast speaker path still reported about **28 ms of output latency**, additional
to input-to-render time. This is a driver estimate, not a microphone measurement
of total finger-to-speaker latency. The 2–6 ms physical end-to-end target is not
verified. Raw physical reports and their conditions are in the Android build
record. The emulator independently retained its supported 960-frame periods and
stable two-period queue; 192 frames is not hardcoded for other phones.

## Input-routing measurements and limits

The initial input-routing comparison was measured from source **`e20d12b`** on
**2026-11-02**, API 35 arm64 Android emulator, optimized Release probe,
cached 645-second AAC fixture `7sFnp7bKwdE`, 48 kHz, two bursts/1920 frames. Each
case alternates two real `input motionevent` pad presses for 24 trials and discards
four warmups. Both routes use the same buffer configuration and cached cues.
The release's `Plugin-Build-1.0.5-Android-arm64.json` contains the four historical
routing reports and the current cue-residency reports, each with a source commit,
SHA-256 digest, individual samples and device/buffer metadata.

| Input route | Renderer load | Median to render | p95 to render | New underruns |
| --- | --- | ---: | ---: | ---: |
| Original WebView/React command path | Normal | 10.14 ms | 19.90 ms | 0 |
| Native touch-down | Normal | 7.12 ms | 16.92 ms | 0 |
| Original WebView/React command path | Deliberate 1500 ms stall | 1438.74 ms | 1452.40 ms | 0 |
| Native touch-down | Deliberate 1500 ms stall | 3.64 ms | 11.44 ms | 0 |

These are **Android input-event timestamp to audio-render-callback completion**
measurements. They exclude touch-panel scanning and speaker/output buffering.
The emulator reported roughly 105–110 ms of output latency independently of these
input-path numbers. Host adb/CDP elapsed times include additional test overhead.
They do not establish 2–6 ms or 10 ms physical finger-to-speaker latency on a
Nothing Phone (1); that requires measurement on the phone and its selected output.

The integration fixture verifies exactly one queued command per press, stale
source/generation fallback, landscape resize, original-position holds, empty and
Overwrite marking, cue-deletion exclusions, dialogs/overlays, two-finger UI
fallback, native sample import, sample-only playback, editing and removal/cue
fallback. Screen-off uncached next-track playback also passes independently of
renderer evaluations. Shared engine and Android/iOS UI regression checks pass.

## Reproduce

Build the usual debug APK, or use an optimized **internal** Release probe:

```sh
sh mobile/android/gradlew -p mobile/android :pluginStandalone:assembleRelease \
  -PbeatmakerStandaloneOnly=true -PbeatmakerLatencyProbe=true
adb install -r plugin/Android/app/build/outputs/apk/release/pluginStandalone-release.apk
export ANDROID_APPLICATION_ID=app.owaega.beatmakercuesstandalone.latencyprobe
node scripts/check-android-plugin.mjs
node scripts/check-android-pad-touch.mjs
node scripts/check-android-cue-residency.mjs --speed=50 --tuning=5 --output release/cue-residency-fast.json
node scripts/check-android-cue-residency.mjs --speed=-50 --tuning=-7 --output release/cue-residency-slow.json
node scripts/check-android-cue-residency.mjs --output release/cue-residency-unity.json
node scripts/benchmark-android-latency.mjs --baseline --bursts=2 --output release/android-original.json
node scripts/benchmark-android-latency.mjs --bursts=2 --output release/android-native.json
node scripts/benchmark-android-latency.mjs --baseline --bursts=2 --renderer-stall=1500
node scripts/benchmark-android-latency.mjs --bursts=2 --renderer-stall=1500
node scripts/check-android-screen-off.mjs
```

Set `ADB` to the SDK's adb executable if it is not on PATH. The probe is labelled
**Beatmaker Cues (latency test)** and has its own
application ID/data, optimized native code, WebView debugging and test-only burst
controls. `--bridge-only` isolates direct Java/JNI commands without raw touch;
`--bursts=0` uses the adaptive two-burst default. The import/screen-off fixtures
are emulator checks; the timing script can run on an attached debuggable device.

For publication, rebuild **without** `-PbeatmakerLatencyProbe=true`. The APK
packager rejects internal IDs and debuggable binaries and verifies the persistent
release certificate and real arm64 native library.

## Release identity

This refresh replaces the Android APK, its build record, corresponding-source
archives and release notes/inventory/checksums in the existing v1.0.5 release.
Per-asset source commits are recorded in `Release-Build-1.0.5.json`. The original
tag remains `5f010dbf7c435699a76c6f05996c1876e6dd9849`; the other published platform
binaries and portable Xcode exports retain that baseline. The refreshed source
archives identify the newer Android source commit in `SOURCE-INFO.json`.
