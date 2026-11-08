# Downloads — Beatmaker Cues 1.0.6

[Release page](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/tag/v1.0.6)
· [Release notes](release-1.0.6-notes.md) · [Input verification](native-input-1.0.6.md)

| Product | Download |
| --- | --- |
| macOS universal AU, VST3 and standalone | [Plug-ins ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/Beatmaker-Cues-Plug-ins-1.0.6-macOS-universal.zip) |
| macOS universal cue standalone only | [App ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/Beatmaker-Cues-Plugin-Standalone-1.0.6-macOS-universal.zip) |
| Windows x64 VST3 and standalone | [Plug-ins ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/Beatmaker-Cues-Plug-ins-1.0.6-Windows-x64.zip) |
| Windows x64 cue standalone only | [EXE ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/Beatmaker-Cues-Plugin-Standalone-1.0.6-Windows-x64.zip) |
| Android arm64 native app | [Signed APK](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/Beatmaker-Cues-1.0.6-Android-arm64.apk) |
| Full desktop studio — Mac Apple Silicon | [ARM64 DMG](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/YT-Beatmaker-Cues-Desktop-1.0.6-macOS-arm64.dmg) |
| Full desktop studio — Intel Mac | [x64 DMG](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/YT-Beatmaker-Cues-Desktop-1.0.6-macOS-x64.dmg) |
| Full desktop studio — Windows x64 | [Installer EXE](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/YT-Beatmaker-Cues-Desktop-1.0.6-Windows.exe) |
| iOS/iPadOS 15+ app with embedded AUv3 | [Unsigned IPA](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/Beatmaker-Cues-1.0.6-iOS-unsigned.ipa) |
| Portable iOS/AUv3 Xcode project with dependencies | [iOS Xcode ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/Beatmaker-Cues-Plugin-Xcode-1.0.6.zip) |
| Portable Mac AU/VST3/standalone Xcode project | [Mac Xcode ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/Beatmaker-Cues-Plugin-Xcode-1.0.6-macOS.zip) |
| Complete source | [ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/Beatmaker-Cues-Source-1.0.6.zip) · [TAR.GZ](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/Beatmaker-Cues-Source-1.0.6.tar.gz) |
| Native corresponding source, pinned dependencies and licenses | [Dependency/source ZIP](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/Beatmaker-Cues-Plugin-Source-1.0.6.zip) |
| Provenance and checksums | [Release record](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/Release-Build-1.0.6.json) · [SHA256SUMS](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/download/v1.0.6/SHA256SUMS-1.0.6.txt) |

The tag `v1.0.6` preserves the initial native baseline
`d51cc4ee6093ae6489faab0d1b4bc30a53803faf`. Android, full desktop installers and
corresponding source identify their added build baseline in per-asset build
records. The expanded inventory has 24 files, including build records, release
notes and checksums. Native Mac/Windows plug-ins, public iOS binaries and portable
Xcode exports retain their initial bytes; the versioned manifest records each
asset's source commit.

Android 1.0.6 is a maintenance update signed with the persistent release key and
uses the same app ID, allowing an in-place update from 1.0.5. The full desktop
studio is rebuilt with version 1.0.6 and retains 1.0.5 studio features/audio.

Mac is ad-hoc signed and supports Apple Silicon/Intel on macOS 12+. Windows is
unsigned, requires WebView2 Runtime and uses FFmpeg for fallback decoding. The
iOS IPA must be signed with a valid Apple account. A separate local build was
installed and launched on the registered iPhone with freshly provisioned signing
and verified library migration. The native simulator observer/receipt checks pass
with injected touches; physical audio/input latency and iPad acceptance remain
separate checks.

The earlier full desktop studio installers and native Android APK remain in
[v1.0.5](downloads-1.0.5.md).
