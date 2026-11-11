# Beatmaker Cues 1.0.7 downloads

[GitHub release](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/tag/v1.0.7)
· [Release notes](release-1.0.7-notes.md)

## Full desktop studio — unchanged functionality, version 1.0.7

| Platform | Download |
| --- | --- |
| Mac Apple Silicon | [ARM64 DMG](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/YT-Beatmaker-Cues-Desktop-1.0.7-macOS-arm64.dmg) |
| Mac Intel | [x64 DMG](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/YT-Beatmaker-Cues-Desktop-1.0.7-macOS-x64.dmg) |
| Windows x64 | [Installer](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/YT-Beatmaker-Cues-Desktop-1.0.7-Windows.exe) |
| Corresponding desktop source | [Version-only maintenance source ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/Beatmaker-Cues-Desktop-Source-1.0.7.zip) |

The desktop source is pinned to the published 1.0.6 baseline. Its packaging and
displayed version fields are the only changes. Native Android/plug-in features do
not change the desktop studio's stems/VJ/FX/sequencer/sidechain implementation.

## Native apps and plug-ins

| Platform | Download |
| --- | --- |
| Android arm64 | [Normal release-signed APK](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/Beatmaker-Cues-1.0.7-Android-arm64.apk) |
| Mac AU/VST3/standalone | [Universal ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/Beatmaker-Cues-Plug-ins-1.0.7-macOS-universal.zip) |
| Mac cue standalone only | [Universal app ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/Beatmaker-Cues-Plugin-Standalone-1.0.7-macOS-universal.zip) |
| Windows VST3/standalone | [x64 ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/Beatmaker-Cues-Plug-ins-1.0.7-Windows-x64.zip) |
| Windows cue standalone only | [x64 app ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/Beatmaker-Cues-Plugin-Standalone-1.0.7-Windows-x64.zip) |
| Linux VST3/standalone | [x64 ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/Beatmaker-Cues-Plug-ins-1.0.7-Linux-x64.zip) |
| iOS app and AUv3 | [Unsigned IPA](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/Beatmaker-Cues-1.0.7-iOS-unsigned.ipa) |
| iOS portable Xcode project | [Source/dependency ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/Beatmaker-Cues-Plugin-Xcode-1.0.7.zip) |
| Current native application source | [Source ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/Beatmaker-Cues-Source-1.0.7.zip) |
| Native corresponding source with dependencies | [Plug-in source ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/Beatmaker-Cues-Plugin-Source-1.0.7.zip) |
| Checksums | [SHA-256 manifest](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.7/SHA256SUMS-1.0.7.txt) |

Android updates the existing normal release app with its original certificate.
The development candidate is a separate installation/library. iOS requires the
installer's own signing. Mac packages retain ad-hoc signing. Linux full desktop
installers remain in the earlier releases; the Linux 1.0.7 packages are native.

## Rebuilding the unchanged desktop studio

From the committed release checkout (with the pinned baseline Git history):

```sh
python3 scripts/prepare-desktop-maintenance.py
pnpm --dir release/desktop-studio-source install --frozen-lockfile
pnpm --dir release/desktop-studio-source installer:mac
# On Windows, use installer:win instead.
```

Alternatively, extract the separate **Desktop-Source** ZIP, install its locked
dependencies, then run its normal `installer:mac` or `installer:win` command.
`.github/workflows/stable.yml` builds the studio this way on both platforms and
verifies that the functionality source stayed unchanged.
