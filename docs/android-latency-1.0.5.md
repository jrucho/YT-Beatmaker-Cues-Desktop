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

## Measurements and limits

Measured on **2026-11-02**, API 35 arm64 Android emulator, optimized Release probe,
cached 645-second AAC fixture `7sFnp7bKwdE`, 48 kHz, two bursts/1920 frames. Each
case alternates two real `input motionevent` pad presses for 24 trials and discards
four warmups. Both routes use the same buffer configuration and cached cues.
The release's `Plugin-Build-1.0.5-Android-arm64.json` contains the four raw reports,
their SHA-256 digests, individual samples and device/buffer metadata.

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
node scripts/benchmark-android-latency.mjs --baseline --bursts=2 --output release/android-original.json
node scripts/benchmark-android-latency.mjs --bursts=2 --output release/android-native.json
node scripts/benchmark-android-latency.mjs --baseline --bursts=2 --renderer-stall=1500
node scripts/benchmark-android-latency.mjs --bursts=2 --renderer-stall=1500
node scripts/check-android-screen-off.mjs
```

Set `ADB` to the SDK's adb executable if it is not on PATH. The probe has its own
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
