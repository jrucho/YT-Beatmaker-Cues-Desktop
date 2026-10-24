# Beatmaker Cues for iOS — 1.0.3

The shared app uses the Android 1.0.2 controls with 1% faders and sequential Mark as its behavioral baseline. The updated iOS 1.0.2 includes the playback-download fix verified on an iPhone 17 Pro.

Version 1.0.3 expands to sixteen pads, Mark across banks, SP-404MKII Mode A/B and Legacy 12-pad presets, restored playback positions, and iOS sample-level cue smoothing. See [controller details](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/blob/main/docs/1.0.3-ios-testing.md). The Standard preset has been removed.

## Open and run

Use **Xcode 26 or newer**. Capacitor 8.5.3's precompiled Swift framework uses Swift 6.2 features that older Xcode releases do not expose correctly.

### This repository

```sh
pnpm install --frozen-lockfile
pnpm --filter @musike/mobile build:ios
open mobile/ios/App/App.xcodeproj
```

Select the **App** scheme and an iPhone or iPad. In **App → Signing & Capabilities**, choose your Apple development team. The display name is **Beatmaker Cues**, version **1.0.3**, build **10003**, bundle ID `app.musike.ios`. If that bundle ID is unavailable to your team, choose your own unique identifier.

For a physical iPhone, connect and unlock it, trust the Mac and enable Developer Mode if requested. Xcode can use a free Personal Team; its installed development build normally needs renewal after seven days. If iOS asks you to trust the developer, use **Settings → General → VPN & Device Management**. No personal team or signing certificate is included in the download.

### Portable Xcode ZIP

Unzip `Beatmaker-Cues-Xcode-1.0.3.zip` and open `App.xcodeproj` inside it. The web app, native code, artwork and local Capacitor plugin packages are included; Node/pnpm are not needed just to open and run the exported project. Xcode downloads the pinned Capacitor and filesystem framework dependencies through Swift Package Manager on first open.

To regenerate the portable project from the repository:

```sh
pnpm --filter @musike/mobile xcode:export
```

## Included behavior

- The same search, playlist import/deduplication, library removal, navigation, remembered playlists, translations and animated intro as Android.
- Sixteen touch cue pads and ten saved banks per track; sequential **Mark 1 → Mark 16** continues through subsequent banks and visibly switches to the bank being marked, without overwriting saved cues.
- Native playhead capture for cue and IN/OUT marks, source-generation checks, and cue jumps that leave a loop when the cue is outside it.
- Native IN/OUT segment scheduling, with the next loop segment queued before OUT.
- Both speed modes use **1% fader steps**. Varispeed couples speed and pitch; pitch-kept mode has independent **±1 semitone** controls (±12 semitones).
- Double-tap the fader to reset speed while retaining tuning.
- CoreMIDI inputs (USB and already-connected Bluetooth MIDI): SP-404MKII Mode A/B physical layouts and Legacy 12-pad presets. Empty pads mark; assigned pads play; Overwrite replaces. Mode A channels 1–10 select A–J; Mode B uses default channels 1/2 and bank-specific note ranges.
- Native-owned playlist advancement and next-track preparation with the screen off, plus foreground reconciliation to the current native song/playhead.
- Background audio, native lock-screen/Control Center transport, volume/mute, and audio-interruption handling.
- Padded, centered launch artwork and the four-pad app icon for iPhone and iPad.

## iOS audio routing

iOS uses `AVAudioEngine` with `AVAudioPlayerNode`, `AVAudioUnitVarispeed` and `AVAudioUnitTimePitch`. Audio is downloaded natively into a bounded **320 MB** local cache before it starts, avoiding WKWebView streaming restrictions and network seeks on cue hits. The first play of an uncached track can therefore take longer to start. A cached track starts without re-downloading it.

Downloads use **1 MB HTTP byte ranges**, validating offsets, lengths and total size, with bounded timeouts and retries for interrupted requests. Completed files are moved into the cache only after all chunks arrive; cancelled or failed partial downloads are removed. This fixes full-file requests that stalled and eventually reported a lost network connection. The same downloader handles next-track preparation.

The app requests a short audio I/O buffer; iOS and the selected audio device determine the actual buffer duration. Independent time/pitch processing adds its own latency. Version 1.0.3 schedules a sample-level 3 ms incoming ramp and outgoing tail on cue jumps, through the same processing chain, without waiting for a fade timer. The iPhone test build was approved by the user. This is not a measured cue-latency or seamless-loop guarantee; background behavior and hardware MIDI need broader device testing. Bluetooth headphones add output latency; use the built-in speaker, wired headphones or a USB interface for timing tests. Further latency work is planned for 1.0.4.

The repository's shared browser/bridge checks can exercise both platforms:

```sh
node scripts/check-android-cues.mjs
MUSIKE_TEST_PLATFORM=ios node scripts/check-android-cues.mjs
node scripts/check-ios-midi.mjs
node scripts/check-native-playlist.mjs
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if Chromium is installed outside Playwright's cache.

The native playlist check also runs the downloader regression tests. To run only those tests on macOS:

```sh
python3 mobile/ios/Tests/test_audio_download.py  # Repository
# Or, from the portable Xcode ZIP:
python3 Tests/test_audio_download.py
```

These cover multi-chunk assembly, servers without range support, interrupted requests, invalid ranges, HTTP errors and cancellation.

## Local versions

The exporter preserves previous Xcode ZIPs and archives each new ZIP under `release/backups/`. Build products and personal signing settings are excluded from the portable project.

## Build the IPA on GitHub

Open **Actions → iOS IPA and Xcode project → Run workflow**. Select `main`, set `release_tag` to `v1.0.3`, and leave publishing enabled. The workflow selects a recent stable Xcode (26+), runs the mobile/native-queue checks, archives an unsigned arm64 app, and updates the existing release with its IPA, Xcode ZIP, checksums and `iOS-Build-1.0.3.json` source/build metadata.

The unsigned IPA needs signing with your Apple account before installation, for example through AltStore/Sideloadly. Opening the Xcode project and choosing your development team is the direct-device alternative. No Apple signing credentials are stored in this repository or required by this unsigned workflow.
