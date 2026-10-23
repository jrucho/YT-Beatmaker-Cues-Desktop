# Changelog

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
