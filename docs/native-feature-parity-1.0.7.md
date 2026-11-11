# Native feature port — 1.0.7

## Stable release acceptance

The user reports successful manual **Android and VST** testing of the published
candidate and has requested stable 1.0.7 builds. No additional functionality is
required for this release. The original production Android signing credentials
are configured in GitHub Actions; the release workflow rebuilds the normal app
with its original ID/certificate. Device/host details beyond the user's report are
not inferred. See `manual-acceptance-1.0.7.json` and `release-1.0.7-notes.md`.

The separate full desktop studio is rebuilt from its exact 1.0.6 source, changing
only product/display version metadata. `desktop/release-baseline.json` pins the
baseline; `scripts/prepare-desktop-maintenance.py` verifies every source file and
exports matching desktop source. `.github/workflows/stable.yml` coordinates these
desktop maintenance builds with the current native release and source builds.

## Development candidate history

Reference: the full cumulative iPhone feature set through installed **1.0.715**,
plus the approved Android/plug-in adapters and candidate-716 corrections. Feature
work originated on `dev/ios-pad-order-1.0.7` in an uncommitted development tree.
Those candidate packages were published as a development prerelease:
https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/tag/v1.0.7-candidate.716

GitHub verification matched the names, byte sizes and SHA-256 digests of all
**11 public assets**. The release includes Android, Mac universal plug-ins and
standalone, a sanitized unsigned iOS/AUv3 IPA, the candidate working-source ZIP,
build records, release notes and checksums. Use the attached source ZIP for the
actual candidate code; the release tag retains the committed baseline. The normal
latest stable at candidate publication was 1.0.6. Local record:
`release/GitHub-1.0.7-candidate-716-verification.json`.

## Platform status at candidate 716

| Target | Implemented | Verified locally | Distribution status |
| --- | --- | --- | --- |
| iPhone standalone | All cumulative features, native gallery and song fades | 715 installed/launched, full saved-data hash readback; native 716 UIKit/recording simulator checks and signed device build passed | User's phone remains on 715; retained private 715 checkpoint and private 716 IPA |
| Android arm64 standalone | Shared features, gallery, microphone/playback recording, audio-device selectors, monitoring and native looper touch receipts/releases | API-35 real WebView/JNI/device callbacks; Files/gallery, visible/touchable source menu, native cue/sample/loop gestures and recording passed | Isolated `.development` candidate 716 APK; normal signed upgrade needs release signing credentials |
| macOS VST3 | Shared features and optional DAW Recorder-input/sidechain | Real binary host instantiation, input monitoring PCM, instrument output, editor resize and state; native engine/UI checks | Universal development package |
| macOS AU | Shared features and optional DAW Recorder-input bus | Universal compilation; actual Logic/AU-host routing remains acceptance work | Universal development package |
| macOS plug-in standalone | Shared features and direct device input/output controls | Real output device callbacks, non-silent playback recording, input-Off startup and failed-output rollback | Universal app; physical microphone/interface/reconnect acceptance remains |
| iOS AUv3 | Shared features and optional host Recorder-input bus | Native engine coverage; signed arm64 container/extension build passed | Physical AUv3-host routing remains acceptance work |
| Windows VST3/standalone | Shared portable engine/UI, hosted input bus, native mouse release and standalone-device adapters | No Windows toolchain/host run in this macOS session | Windows build/runtime validation pending |
| Linux VST3/standalone | Shared portable engine/UI, hosted input bus and standalone-device adapter | No Linux toolchain/host run in this macOS session | Linux build/runtime validation pending |

The separate full desktop studio/Desktop Beta is not this responsive native
plug-in edition. Its unported browser stems/VJ/sequencer features are not included.

## Candidate packages

- `release/Android-1.0.7-development-candidate-716/Beatmaker-Cues-1.0.7-Android-arm64-development.apk`
- `release/macOS-1.0.7-development-candidate-716/Beatmaker-Cues-Plug-ins-1.0.7-macOS-universal.zip`
- `release/macOS-1.0.7-development-candidate-716/Beatmaker-Cues-Plugin-Standalone-1.0.7-macOS-universal.zip`
- `release/iOS-1.0.7-development-candidate-716/Beatmaker-Cues-1.0.7-iOS-development-signed.ipa`
- Exact uncommitted source/plan and candidate hashes:
  `release/Beatmaker-Cues-1.0.7-Cross-platform-Checkpoint-candidate-716/`

The Android development APK updates the separate `.development` app. Its debug
certificate does not replace the normal release-signed app; the persistent release
key is required for that in-place update. Source/build records and checksum
manifests accompany the packages. The private iOS IPA includes device development
provisioning and is not a public unsigned release.

## Ported behavior

- Saved numbering for Linear 16/Legacy 12, fixed SP-404 presets, velocity On/Off,
  paired or ten-bank controls, single-hit native/browser input ownership.
- Position-stable cue/sample/looper content swaps, shared session undo/redo,
  precise retained-source waveform/start editing and held-pad audition policy.
- Per-song speed/mode/tuning, neutral defaults and native/background queue recall.
- Automatic Imports/Cues, blank recording workspace, native Files/gallery video
  import, contextual sample chopping, renamed songs and original-byte export/share.
- Distinct active looper colour/pulse and persistence/record/play/overdub/layer
  gestures; native compressor and song/sample mixer.
- Immediate monitor gate on lost device, retained requested On state and
  same-route restoration. Platform adapters report accepted routes. Hosted
  plug-ins use the user-approved optional DAW bus, not direct sound-card access.
- Default-On sequential song fades with Off/Instant and saved duration; visual
  frame-rate playhead/transport animation without 60-Hz native calls or React updates.
- Selection/callout prevention and full-width icon toolbar; Android retains its
  original erase-X appearance.

## Candidate 715 blank Android menu correction

The user's report was reproduced: Android WebView computed `max-height:68dvh` as
zero for `.media-import-panel`, leaving only the dialog title. Candidate 716 uses
`calc(var(--plugin-vh)*68)`, based on the native measured viewport. The Cues root
lock also uses the measured height to keep Android hit-testing inside the page.
`scripts/check-android-features.mjs` verifies panel height/all four source buttons
and drives real Android DOWN/UP input for UI actions, not hidden DOM `.click()`.

The Android MIME registry also includes M4A/AAC/FLAC/OGG/MP4 types missing from
JUCE's historical table, so supported sample files are selectable in Files.

## Hosted input contract

The DAW owns bus connection and hardware/session routing. Recorder input starts
disabled; its supported mono/stereo layouts never pass input through by default.
Raw input is captured before clearing the output buffer; optional input monitoring
is mixed after the Beatmaker playback recorder. Monitoring On/level survives host
state, mutes on bus stop/removal and resumes only when a bus is ready. Manual Off
persists. The audio callback uses preallocated monitor storage and remains
allocation-free under the checked render tests. Main-output alias writes mark the
host buffer non-clear; otherwise a stale silence flag could hide rendered samples.

## Verification entry points

- `pnpm typecheck`
- `node scripts/check-native-ui.mjs --ios-preview`
- `node scripts/check-native-ui.mjs --features --platform=android`
- `MUSIKE_TEST_PLATFORM=ios node scripts/check-android-cues.mjs`
- `ctest --test-dir plugin/build-mac-permanent --output-on-failure`
- `PluginProbe` against the actual VST3 bundle, including optional input PCM/state
- `WebIntegration --shared-offline`, including actual Cocoa/WKWebView/host keyboard
- `StandaloneRecordingFixture`, using actual desktop output callbacks
- `NativePadInputIOSFixture` and `RecordingIOSFixture` on the iOS simulator
- `scripts/check-android-features.mjs` against the isolated emulator app;
  `release/Android-Feature-Port-1.0.7-Emulator-build-716.json` retains its report

Physical USB/SP-404 accepted duplex routes, unplug/reconnect, acoustic latency,
gallery-provider selection and DAW musical listening remain hardware/host checks.
Simulator/emulator results are not physical-device latency measurements.
