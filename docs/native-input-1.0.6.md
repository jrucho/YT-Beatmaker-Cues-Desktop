# Native input verification — 1.0.6

The native adapters receive UIKit/Cocoa/Windows input on the view/message thread
and submit the existing cue/sample command. The render thread consumes commands
without locking. Source-generation guards reject queued cues after a song change.
Receipt matching uses the original event time, selected bank/pad and cue/sample;
claims are single-use and survive delayed renderer delivery for up to 60 seconds.

UI geometry is normalized to the browser viewport. The adapter checks viewport
dimensions/DPR, layout/native-track revisions, assigned samples and blocked
controls. Dialogs, editing, overlay queues and zoomed views clear the map. Apple
uses the native view associated with the specific JUCE browser component; Windows
uses the component's associated WebView2 HWND. A host-wide browser search is not
used. Mouse/touch events continue to the normal UI.

## Automated checks

- `CueEngine`: native cue/sample input before the audio callback, exact single-hit
  consumption, pre-jump position, receipt time mismatch/double-claim rejection,
  physical-pixel DPR, stale source/generation/track/layout, blocked controls,
  background exclusion, sample-only/Overwrite/removal behavior, no callback
  allocation. The existing selected-bank suite verifies exact PCM and bounded
  cache use across banks and speed/tuning settings.
- Mac `WebIntegration --shared-offline`: actual Cocoa mouse events and WKWebView
  pointer delivery, rendering before JavaScript, a 450 ms renderer stall, one-time
  receipt reconciliation and two sibling browsers sharing a native window.
  Existing host-keyboard, sample, local AAC, persistence, responsive and 500-track
  checks also run. `PluginProbe` checks real VST3 MIDI/audio/state and editor sizes.
- Windows `WebIntegration --shared-offline` includes real `SendInput`/WebView2
  single-hit and 450 ms renderer-stall checks. Native Windows CI is required to
  confirm this platform; Mac execution does not substitute for it.
- Shared browser checks: `pnpm typecheck`, `check-android-cues.mjs` in Android and
  iOS modes, `check-native-ui.mjs`, controller mapping and CoreMIDI parsing.

## iOS Simulator fixture

Configure a separate Xcode build with `CMAKE_SYSTEM_NAME=iOS`,
`CMAKE_OSX_SYSROOT=iphonesimulator`, `CMAKE_OSX_ARCHITECTURES=arm64`,
`CMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED=NO` and
`BEATMAKER_IOS_INPUT_TESTS=ON`. Build `NativePadInputIOSFixture`, then:

```sh
xcrun simctl install <simulator-udid> \
  "plugin/build-ios-input-simulator/NativePadInputIOSFixture_artefacts/Release/Beatmaker Input Tests.app"
xcrun simctl launch --console <simulator-udid> app.owaega.beatmakercuesinputfixture
```

The separate test app uses temporary test storage and a bundled local tone. It
injects UITouch subclasses into the actual installed gesture observer, renders
audio before JavaScript, and delivers matching DOM pointer events to the real
React pads. Cue/sample receipt reconciliation, non-cancelling/non-delaying gesture
configuration and modal exclusion pass. The fixture is simulator-only and is not
included in release packages. This does not measure touch hardware or verify real
UIKit gesture arbitration under a user's fingers.

## Physical-device status

Both registered Apple devices remain paired. The original team's app and AUv3
development profiles expired November 7, 2026; Xcode currently rejects renewal of
their existing bundle IDs. Physical installation/acceptance requires renewed
signing. A new bundle ID would create another app/data container, so the product
identity is retained. Unsigned arm64 iOS/AUv3 builds compile successfully.

## Timing interpretation

`padTouchDiagnostics` reports supported/map state, accepted/claimed command
counts and last native input-to-render time. Timing waits through cue-cache
buffering. Cold cue preparation, touch hardware, the audio interface/device
buffer, OS mixer and acoustic output are separate. Hosted plug-ins use the DAW's
audio scheduling and do not impose an Android-style device-buffer policy.
