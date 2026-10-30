# Beatmaker Cues 1.0.4

Source is available on `main`, `release/1.0.4` and tag `v1.0.4`.
See [all exports](downloads-1.0.4.md) and the [release](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/tag/v1.0.4).
This release covers Mac, Windows, Android and iOS. The complete source includes
the other development targets; Linux installers remain at v1.0.3.

## Downloads

- **New native cue standalone:** universal Mac `.app` ZIP and Windows x64 `.exe` ZIP.
- **Native plug-ins:** universal Mac AU/VST3 and Windows x64 VST3 ZIPs.
- **Full desktop studio:** Apple Silicon/Intel Mac DMGs and Windows x64 installer,
  retaining the original stems, VJ, FX, sequencer and sidechain implementation.
- **Mobile:** persistent-key-signed native Android arm64 APK; unsigned native iOS
  IPA with embedded AUv3 extension. Personal development provisioning is kept local.
- **Projects/source:** portable native iOS and Mac Xcode projects, complete source
  ZIP/TAR.GZ, and corresponding source with pinned JUCE/Signalsmith dependencies.
- **Verification:** per-platform build records, release inventory and SHA-256 sums.

## Changes

Native sample pads work on desktop and mobile. Enable the music-note button beside
MIDI, tap a pad and choose **Load sample…**, then turn editing off to perform.
Loaded pads show **SMP** and play independent polyphonic one-shots, including
without a song. They never mark/jump cues, including in Overwrite mode. Removing a
sample restores normal cue behavior. Imports are retained in managed media
storage; assignments survive restarts and DAW recall. The engine supports 32 voices
and a 128 MiB decoded sample budget, with no callback loading/allocation.

Hosted VST3/AU/AUv3 disable player and pad keyboard shortcuts so the DAW can use
computer-keyboard MIDI/transport keys. Standalone shortcuts remain active.
The shared native UI has real waveform editing, a rich playlist dock, bottom
transport/navigation, directly visible SP-404 presets and whole-number rate controls.
Android's browsing player uses native bottom insets, and the bright right-edge
pixel is fixed. Its file picker uses document-provider streams to retain samples.
Rate changes are smoothed, Signalsmith preload continuation is corrected, and
Windows fallback decoding is locked across concurrent plug-in instances.

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
iOS IPAs require your Apple signing account. The native Android APK uses the new
persistent release key. The published 1.0.3 Android APK has a different key and
cannot update in place: read `docs/android-1.0.4-migration.md` before uninstalling.
Old library backups alone do not preserve separately stored mobile cue banks.

The JUCE-based public binaries use the AGPLv3 licensing option; see
THIRD_PARTY_NOTICES.md and the corresponding-source download. A commercial JUCE
license is separate. Build and fork instructions are in `docs/build-from-source.md`.

## Acceptance status

Automated build/test success is recorded per platform, not a claim of universal
host/device approval or zero physical latency. Record exact tested DAWs/devices
for hardware acceptance. Desktop full-UI beta work is separate from the normal
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
parity or universal DAW/device approval is made by this release. The latest
sample-pad iOS build is packaged; installing it on the previously connected phone
was blocked by device availability.
