# Beatmaker Cues — native Android app

This is the new official Android implementation (`app.owaega.beatmakercuesstandalone`),
using the native JUCE processor and the responsive portrait/landscape cue workspace.
It is distinct from the Capacitor main Android app and uses private app data.
The initial port targets arm64 devices, Android 7/API 24 or newer.

## Build

Install Java 21, Android SDK platform/build-tools 36, NDK 28.1.13356709 and SDK
CMake 3.31.6. Set `JAVA_HOME` and `ANDROID_HOME`, then from the repository root:
On a Linux build host, JUCE's host-side resource compiler also requires the X11,
Xext, Xrandr, Xinerama, Xcursor, FreeType and Fontconfig development packages.

```sh
pnpm install --frozen-lockfile
python3 plugin/Scripts/build_mobile_ui.py .
sh mobile/android/gradlew -p mobile/android :pluginStandalone:assembleDebug -PbeatmakerStandaloneOnly=true
```

The Gradle preparation task downloads the pinned JUCE source into ignored
`plugin/.android-deps/juce`. CMake fetches the pinned Signalsmith sources. An
existing JUCE source directory can be supplied with `-PbeatmakerJuceDir=...`.
Debug output: `plugin/Android/app/build/outputs/apk/debug/pluginStandalone-debug.apk`.
The standalone-only property skips the main app's generated Capacitor modules,
so a clean checkout does not require a Capacitor sync before building this port.

For release signing, use the existing `MUSIKE_KEYSTORE`,
`MUSIKE_KEYSTORE_PASSWORD`, `MUSIKE_KEY_ALIAS`, `MUSIKE_KEY_PASSWORD` environment
variables and build `:pluginStandalone:assembleRelease`. Keep credentials outside
source/export archives. Package with:

```sh
python3 plugin/Scripts/package_android.py --apk plugin/Android/app/build/outputs/apk/release/pluginStandalone-release.apk
```

The packager verifies the persistent signing certificate, arm64 native binary
and records the source commit and clean/dirty status. Public binaries use the
JUCE AGPLv3 option; distribute the corresponding-source/dependency archive.

## Runtime and acceptance

- The Android activity uses JUCE's application lifecycle registration. The
  optional push-notification `JuceActivity` is not needed.
- The HTML bootstrap evaluates JUCE Android user scripts before importing the
  application, so storage, HTTP and native audio bridges exist at startup.
- The Android bridge measures the viewport in pixels for the app and dialog
  bounds. Some JUCE-hosted WebViews resolve CSS `vh`/`dvh` units as zero despite
  a correct `innerHeight`; this previously clipped the content to a narrow top
  strip and left a large black region. Startup, resize and resume synchronize
  the measured bounds. Portrait (412×915 CSS pixels), landscape (732×412) and
  restored portrait layouts were checked on the API 35 emulator.
- MediaExtractor/MediaCodec decode AAC pages on the load/page workers behind the
  fixed-size native PCM cache. Full first-use PCM conversion is no longer required.
  The 645-second test song reached first render in 2.39 seconds including a fresh
  2.16-second download, or about 0.18–0.31 seconds from an encoded cache hit.
- Native cutout/status-bar insets position the header below the camera. The
  standalone chooses two supported audio bursts for cue playback rather than
  JUCE's default 40/100 ms queue; physical output latency remains device-dependent.
- Native media snapshots feed a MediaSession/foreground playback service;
  system play, pause, seek and navigation command the C++ engine independently
  of WebView event delivery. Audio focus loss pauses playback.
- API 35 arm64 emulator: launch, live 500-track catalog, long AAC native
  playback, cueing and background system play/pause passed. Hardware listening,
  Bluetooth, unplug handling and API 24/36 device acceptance remain pending.
- Native full desktop Advanced/stems/FX/sequencer/sidechain/VJ parity remains
  incomplete. This port uses the normal plug-in interface and core native engine.

See `official-product-lineup.md` for the current official app/icon direction and
the publication/push hold. Local candidates may identify an uncommitted working
tree; they are not published 1.0.4 releases.
