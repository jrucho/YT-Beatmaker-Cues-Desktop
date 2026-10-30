# Beatmaker Cues 1.0.4 — unpublished development notes

Publication and further pushes are on hold at the user's request. See
`docs/official-product-lineup.md` for the current product direction: the native
iOS and Android apps and responsive native plug-ins use the original iOS icon;
desktop 1.0.3 remains the official full desktop standalone. The inventory below
describes development build targets, not a published 1.0.4 release.

## Downloads

- Main desktop: Mac arm64/x64 DMGs retain the full desktop studio interface.
- Main mobile: Android stable-key Setup APK and development-key Test APK; unsigned
  iOS IPA and portable main-iOS Xcode project. These use the responsive mobile UI.
- Native plug-ins: Mac universal AU/VST3 plus separate plug-in standalone ZIPs.
  The normal editor uses the mobile-style interface.
- Separate `Desktop-Beta` archives use the desktop studio layout and distinct
  IDs and independent sessions. They host-route core cue/transport/loop/speed controls;
  browser stems/FX, sequencer, sidechain and VJ are not yet host-routed.
- AUv3: unsigned container IPA with embedded extension and portable plug-in Xcode
  export. Automatic sharing with the main iOS app is not configured.
- Android plug-in standalone: a separate arm64 APK using the JUCE native engine,
  mobile-style editor, cue banks and Android system media controls. It installs
  alongside the main Android app, with its own sandboxed library and sessions.
  Its WebView layout includes measured viewport/safe-area handling and a cue
  workspace with visible performance controls in portrait and landscape.
- Complete source ZIP/TAR.GZ and plug-in corresponding-source/dependency ZIP are
  attached. The repository tag, source and final binaries must identify one SHA.

## Changes

Automatic library saves and backup recovery; concurrent plug-in library merging
and separate sessions; stable track-ID caches; local audio import; native pad
feedback; smoother atomic plug-in cue retriggers; native playlist handling;
FFmpeg executable discovery; integrated native projects and clean-source exports.
Large catalogs now load progressively and use windowed lists/grids. The native
bridge avoids repeatedly escaping large catalog responses on the UI thread.
Long tracks use a fixed 16 MiB stereo PCM page cache, background reads and
cue/loop look-ahead rather than requiring the entire decoded track in memory.

Desktop Discovery and Beatmaker styling now follow the library theme, including
borderless controls. Desktop editions share a merge-safe library while retaining
independent transport, cue banks and host/session state. iOS App Group sharing
is opt-in and requires matching entitlements; the default keeps private storage.

The iOS plug-in standalone now publishes Now Playing metadata and native remote
transport for Lock Screen/Control Center. The AUv3 extension does not own these
standalone media controls.

Portable native FX kernels and a partial four-corner graph are implemented and
compared against the original browser DSP. Full desktop native stems/FX,
sequencer, sidechain and VJ parity is still in progress; these internal kernels
do not switch the existing full desktop UI to a complete native graph.
See CHANGELOG.md and the per-platform build records for detail.

## Installation and migration

Mac builds are ad-hoc signed and not notarized.
iOS IPAs require your Apple signing account. The Android Setup APK uses the new
persistent release key. The published 1.0.3 Android APK has a different key and
cannot update in place: read `docs/android-1.0.4-migration.md` before uninstalling.
Old library backups alone do not preserve separately stored mobile cue banks.

The JUCE-based public binaries use the AGPLv3 licensing option; see
THIRD_PARTY_NOTICES.md and the corresponding-source download. A commercial JUCE
license is separate. Build and fork instructions are in `docs/build-from-source.md`.

## Acceptance status

Automated build/test success is recorded per platform, not a claim of universal
host/device approval or zero physical latency. Record exact tested DAWs/devices
before final publication. Desktop full-UI beta work is separate from the normal
plug-in and must be identified as beta with its own compatibility/feature status.

Local Android API 35 arm64 emulator checks passed launch, the 500-track SOUL
SAMPLES catalog, native AAC playback of the 645-second Jean Carn track,
mid-track cueing, and system play/pause with playback progressing while the app
was backgrounded. On-demand AAC page decoding replaces the old 75–79-second
full-file conversion: the long song reached first render in about 2.39 seconds
including a fresh download, or 0.18–0.31 seconds from its encoded cache.
Physical Android listening, Bluetooth and device-specific latency remain unverified.

The iOS main app and plug-in standalone/AUv3 were built and updated in place on
an iPhone 17 Pro. Physical Lock Screen/headset acceptance and entitled App Group
sharing still require device validation. No claim of complete native routing
parity or universal DAW/device approval is made by this prerelease.
