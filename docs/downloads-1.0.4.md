# v1.0.4 downloads and source

All exports are attached to the [v1.0.4 GitHub release](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/tag/v1.0.4).
The source is on `main`, the `release/1.0.4` branch, and tag `v1.0.4`.
Build artifacts live in GitHub Releases; this index keeps every app accessible from the main branch.

## Apps and plug-ins

| Edition | Release asset |
| --- | --- |
| New native cue standalone, Mac Apple Silicon + Intel | `Beatmaker-Cues-Plugin-Standalone-1.0.4-macOS-universal.zip` |
| New native cue standalone, Windows x64 | `Beatmaker-Cues-Plugin-Standalone-1.0.4-Windows-x64.zip` |
| AU/VST3, Mac universal | `Beatmaker-Cues-Plug-ins-1.0.4-macOS-universal.zip` |
| VST3, Windows x64 | `Beatmaker-Cues-Plug-ins-1.0.4-Windows-x64.zip` |
| Full desktop studio, Mac Apple Silicon | `YT-Beatmaker-Cues-Desktop-1.0.4-macOS-arm64.dmg` |
| Full desktop studio, Intel Mac | `YT-Beatmaker-Cues-Desktop-1.0.4-macOS-x64.dmg` |
| Full desktop studio, Windows x64 | `YT-Beatmaker-Cues-Desktop-1.0.4-Windows.exe` |
| Native Android app, arm64 | `Beatmaker-Cues-1.0.4-Android-arm64.apk` |
| Native iOS app with AUv3, unsigned | `Beatmaker-Cues-1.0.4-iOS-unsigned.ipa` |

The native standalone, plug-ins and mobile apps share the responsive cue/sample-pad interface.
Enable the music-note button beside MIDI, tap a pad and load a sample; disable editing to perform.
Sample pads play one-shots and never mark/jump cues. Empty sample slots retain normal cue behavior.
Hosted VST3/AU/AUv3 disable player keyboard shortcuts so the DAW can use those keys for MIDI/transport.

The full desktop studio contains the original stems/VJ/FX/sequencer/sidechain implementation.
The native cue app is a separate, smaller edition. See [product lineup](official-product-lineup.md).

## Source and portable projects

| Export | Release asset |
| --- | --- |
| Complete app/native source | `Beatmaker-Cues-Source-1.0.4.zip` and `Beatmaker-Cues-Source-1.0.4.tar.gz` |
| Complete source plus pinned JUCE/Signalsmith sources and licenses | `Beatmaker-Cues-Plugin-Source-1.0.4.zip` |
| Portable iOS Xcode project, standalone + AUv3 | `Beatmaker-Cues-Plugin-Xcode-1.0.4.zip` |
| Portable Mac Xcode project, standalone + AU + VST3 | `Beatmaker-Cues-Plugin-Xcode-1.0.4-macOS.zip` |
| Inventory and provenance | `Release-Build-1.0.4.json` and per-platform build records |
| Download verification | `SHA256SUMS-1.0.4.txt` |

Mac native apps are universal; full studio DMGs are architecture-specific. Mac builds are ad-hoc signed, not notarized.
Windows native apps require WebView2 Runtime; FFmpeg supports fallback audio decoding.
The public iOS IPA is unsigned and portable projects use the recipient's Apple signing settings.
Android uses the persistent native-app release key. See [Android migration](android-1.0.4-migration.md) for older installations.

Physical iOS screen-off/next-track verification is pending. Linux v1.0.3 downloads remain available in the previous release.
The historical desktop-layout beta is a source/development target and is not included in this release's binaries.
