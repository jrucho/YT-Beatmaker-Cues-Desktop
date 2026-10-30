# Changelog

## 1.0.4

- Released the native cue standalone for Mac (universal) and Windows x64 alongside AU/VST3, native Android, and an unsigned iOS app with embedded AUv3. Full desktop studio installers remain separately labeled for Mac and Windows.
- Added per-pad sample imports on native desktop/mobile: 32-voice one-shot playback, MIDI timing/velocity, app-local retained files and session persistence. Sample pads never mark/jump cues; unassigned pads retain normal cue behavior.
- Disabled player and pad keyboard shortcuts in hosted VST3/AU/AUv3 mode so DAW computer-keyboard MIDI and transport keys remain available. Standalone shortcuts remain active.
- Unified portrait/landscape native cue layouts with real waveform editing, a rich playlist dock, bottom transport/navigation and whole-number pitch/speed values.
- Fixed Android browsing-player safe-area placement and the one-pixel native window edge; imported samples use document-provider streams rather than inaccessible file paths.
- Added on-demand Android AAC decoding, rate-transition smoothing and Windows multi-instance decoder-cache locking. Verified uncached next-track playback with the Android emulator screen off.
- Added complete source/dependency archives, portable iOS/macOS Xcode exports, release inventory/checksums and main-branch download links.

- Added cue/MIDI-aware portable backups and an explicit Android signing migration route. Created a persistent release-signing setup for future APK updates; published 1.0.3 test APKs have a different certificate and cannot update in place.
- Added a coordinated, same-commit candidate workflow, clean-source exports and verified draft-only assembly with a complete target inventory. Individual build workflows no longer publish partial releases.
- Added a separate experimental desktop-layout plug-in/standalone with distinct IDs and data storage. It routes core studio controls through native host audio; stems/browser FX/sequencer/sidechain/VJ are not yet host-routed.
- Added durable automatic library saves with valid backups and corrupt-file recovery. Initial reads are single-flight, and failed writes no longer prevent later saves.
- Integrated the native AU, VST3, AUv3 and plug-in standalone sources under `plugin/`, preserving legacy internal IDs. Added native build/package workflows and portable AUv3 Xcode export.
- Plug-in libraries use revisioned atomic writes, interprocess locking and keyed concurrent-edit merging; session snapshots are stored separately from the library. Legacy DAW library data is archived during migration.
- Added desktop/plug-in local audio imports and retained missing-media references.
- Prefer stable track-ID caches before remote resolution; reuse native Apple HTTP connections and keep decode/download work away from the render thread.
- Added native MIDI/touch pad feedback and editor-closed plug-in playlist preparation/advancement. Plug-in cues use an atomic command with a 3 ms transition continuous across rapid/pitch-processed retriggers.
- Fixed FFmpeg discovery selecting an executable-named directory instead of the binary inside it.
- Added persistence/concurrency/recovery checks, real AAC decode verification, render-allocation checks and live plug-in WebView restoration checks.
- iOS uses private storage by default; App Group sharing is opt-in. Signing, platform-native CI and hardware verification status are documented in `plugin/README.md`.

## 1.0.3

- Desktop compatibility refresh: restored the 1.0.2 direct proxy audio path. When yt-dlp resolves a URL that is refused with HTTP 403/410, audio now bypasses that rejected resolver result using the existing direct-audio fallback rather than repeating the same rejection.
- Verified real YouTube playback and switching song 1 → song 2 → song 1 in Electron. Added an opt-in live desktop test, distinct from deterministic fixture checks.
- Simplified desktop Discovery/studio surfaces to match the library's flat dark styling and pill controls; removed the Ready/Cues saved footer and technical studio badge. Visible headings now use Beatmaker Cues, and both desktop Play buttons show an animated loading indicator.
- The earlier desktop bounded-range proxy experiment has been rolled back from the playback path in favor of 1.0.2 compatibility. Native mobile downloaders are unaffected.
- Desktop layout refresh: explicitly size all four pad rows equally; Legacy uses three equal rows in its four-column desktop grid. The fourth sixteen-pad row no longer falls into an implicit grid track.
- Expanded the mobile and desktop studio to sixteen pads in a 4×4 layout, preserving existing cue numbers and bank storage.
- Selecting Legacy 12-pad changes the visible grid and sequential Mark limit to twelve on every platform; switching back restores sixteen. The chosen preset is remembered after reopening, and hidden extended cues are preserved.
- Android/iOS Legacy uses a 3-column × 4-row grid (1–3, 4–6, 7–9, 10–12). Mode A/B retain 4×4; desktop retains its four-column layout.
- Mark now fills empty pads and continues through banks A–J, switching the visible bank when marking begins there. Existing cues are never overwritten by sequential Mark.
- Added shared SP-404MKII Mode A and Mode B controller presets, using Roland's physical pad layout. Mode A uses channels 1–10 for A–J; Mode B uses the default channels 1/2 and bank-specific note ranges. Kept the Legacy 12-pad preset; removed the redundant Standard preset from the selector.
- MIDI hits mark empty pads and trigger assigned cues. Overwrite mode replaces cues. Note Off and velocity-zero Note On release pad highlighting without stopping one-shot playback. Unmapped desktop MIDI messages continue through the original engine.
- Fixed first Play after reopening on native platforms: an empty native snapshot no longer makes an unloaded song appear ready or resets its saved position. The shared player saves progress every second and on transport changes. iOS also persists the native playhead during background playback.
- Reduced iOS cue discontinuities with a sample-level 3 ms incoming ramp/outgoing tail, without a fade timer delaying cue execution. The already-running audio engine no longer reactivates the session on each pad hit. Validated on the user's iPhone; this is not a measured end-to-end latency guarantee. Desktop retains its existing cue micro-fade; Android retains native cached seeking.
- Added mapping checks for all 320 Mode A/B pad/bank combinations, native reopen regression checks, and desktop sixteen-pad/Mark/MIDI checks.
- Future measured latency improvements are planned for 1.0.4. The previous 1.0.2 release remains available as a fallback.

### Installation

- The Android APK is a development-key-signed test build. Its certificate may differ from a previous test APK; export your library before uninstalling an older test build if Android rejects an in-place update.
- The iOS IPA is unsigned and must be signed with the installer's own Apple account. The portable Xcode ZIP contains no personal signing team or certificates.

## 1.0.2

- Fixed iOS songs staying on loading and eventually failing with “The network connection was lost”: selected songs and playlist preloads now use validated 1 MB byte-range downloads, bounded retries and complete-file cache publication.
- Continue to the next YouTube client when a response has no playable audio format; corrected resolver closure ownership.
- Verified the playback fix on an iPhone 17 Pro and added six native downloader regression checks to the iOS release checks and portable Xcode ZIP.
- This remains the recommended stable baseline; the next update is 1.0.3, followed by patch increments.
- Added Android and iOS Beatmaker Cues projects with twelve native-backed touch cue pads, ten saved banks, sequential marking, native playhead capture, IN/OUT loops, 1% faders and independent semitone tuning.
- Moved playlist advancement, next-track preparation and lock-screen transport into the native players so screen-off continuation does not rely on WebView JavaScript; the interface reconciles playback on return.
- Added native USB/CoreMIDI inputs, playlist import deduplication/removal, remembered playlist navigation, updated branding and padded launch artwork.
- Added local build backups, portable Xcode exports and a GitHub Actions workflow that builds an unsigned iOS IPA and updates existing release assets with checksums and source provenance.
- Fixed automatic FFmpeg installation on macOS and Linux by downloading builds from GitHub instead of an unavailable third-party host.
- Added a **Download FFmpeg** action in Settings, and FFmpeg is retried in the background on every launch when missing.
- Added `pnpm share:mac` to build quarantine-free macOS folders and zips for USB drives or AirDrop, with an installer that avoids the Privacy & Security prompt.

## 1.0.1

- Discover search results appear above recent library tracks, with a horizontally scrollable row of matching YouTube playlists.
- Search public YouTube playlists or paste a playlist link, preview their songs, then save the playlist to the shared library (up to 500 playable tracks per import, with an explicit limit indicator).
- Studio displays saved playlists by name and track count; open a playlist to see its songs or delete it directly.
- Remove tracks from a selected playlist, favorites, history, or the whole library using the studio's trash controls.
- Discover now includes recently played library tracks and quick access to saved playlists.
- Search finds saved playlists in Discover and the full music browser.
- Create playlists and add tracks to them directly from the studio; use the collection selector to keep the track list focused.
- Simplified studio status text and removed technical readiness banners.
- Enlarged the green mark in the macOS, Windows and Linux application icons.
- Added Windows x64 installers and Linux x64/ARM64 AppImage and Debian packages, built on GitHub Actions.
- Fixed the CI Settings check when playback tools need installation.

## 1.0.0

First release of **YT Beatmaker Cues Desktop** as a standalone project.

### Added

- A Discover Samples opening page with music crates, live catalog search, previews and direct loading into the studio.
- A global Discover player bar with artwork, transport, seeking, favorites and volume, plus one-click cue marking that opens the studio without restarting playback.
- Thirty bundled WAV drum hits with preview and download actions.
- A reference-inspired, monochrome desktop studio with a music library and four-column cue-pad grid.
- Direct integration of the original YT Beatmaker Cues 2.4.5 engine with Musike's media element.
- Twelve cue pads and ten independent banks per track, including keyboard triggers and local autosave.
- White cue pins on the studio timeline so cue positions stay visible against the dark theme.
- A pitch-black interface across the library, Settings, dialogs and the studio shell.
- A new green four-pad logo across the app, splash screen, favicon and installers.
- English, French and Spanish interface languages, including catalog search and the desktop splash screen.
- Performance controls for the original sequencer, FX Pad, sidechain, region loops, VJ and Advanced tools.
- Pitch control and audio/video switching.
- Session export/import for track references and cue banks.
- App-local extension storage/messaging adapters and optional stems-host support.
- A separate native window for VJ projection output.
- macOS DMG installers for Apple Silicon and Intel.

### Verification

- Workspace TypeScript checks and production builds.
- HTTP Range fixture checks for playback, cue capture/seeking, cue banks, pitch control, persistence and session export/import.
- Original engine panel initialization and narrow-viewport checks.
- Packaged Apple Silicon app launch; app signatures and installer checksums.

### Fixed during the control audit

- MAP now opens actual MIDI mappings instead of the guide.
- The compact cue controls can reopen after the original Advanced action removes them, and have their own close button.
- The default compact-bar position no longer covers its workspace toggle.
- Performance controls wait for the engine/media they need; VJ requires a video source.
- Browser-tab-only VJ options are hidden in the desktop app.
- Studio settings no longer expose appearance controls that do not affect the studio.
- The workspace rate fader stays in percent when the original engine is in semitone mode, and identifies its current pitch/speed target.
- Cue save status reflects persisted cue data, and failed session imports do not report full success.
- The **Beatmaker workspace** switch now lives in the library sidebar (and mobile tab bar), away from the desktop title bar.

### Known limitations

- Ad-hoc signed; not Apple-notarized.
- Hardware MIDI, device routing, projector output and full optional-model inference require device/model testing.
- VJ uses the integrated player; Chrome multi-tab feeds are not desktop decks.
- Session export does not include recorded audio, the optional model or every engine preference.
