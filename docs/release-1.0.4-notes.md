# Beatmaker Cues 1.0.4 — release candidate

This is a coordinated candidate: validate the attached build manifest, source
commit and platform acceptance results before publishing as stable.

## Downloads

- Main desktop: Mac arm64/x64 DMG, Windows x64 installer, Linux x64/arm64
  AppImage/Debian packages. These retain the desktop studio interface.
- Main mobile: Android stable-key Setup APK and development-key Test APK; unsigned
  iOS IPA and portable main-iOS Xcode project. These use the responsive mobile UI.
- Native plug-ins: Mac universal AU/VST3, Windows/Linux x64 VST3, plus separate
  plug-in standalone ZIPs. The normal editor uses the mobile-style interface.
- Separate `Desktop-Beta` archives use the desktop studio layout and distinct
  IDs/library storage. They host-route core cue/transport/loop/speed controls;
  browser stems/FX, sequencer, sidechain and VJ are not yet host-routed.
- AUv3: unsigned container IPA with embedded extension and portable plug-in Xcode
  export. Automatic sharing with the main iOS app is not configured.
- Complete source ZIP/TAR.GZ and plug-in corresponding-source/dependency ZIP are
  attached. The repository tag, source and final binaries must identify one SHA.

## Changes

Automatic library saves and backup recovery; concurrent plug-in library merging
and separate sessions; stable track-ID caches; local audio import; native pad
feedback; smoother atomic plug-in cue retriggers; native playlist handling;
FFmpeg executable discovery; integrated native projects and clean-source exports.
See CHANGELOG.md and the per-platform build records for detail.

## Installation and migration

Mac builds are ad-hoc signed and not notarized; Windows/Linux outputs are unsigned.
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
