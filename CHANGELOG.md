# Changelog

## 1.0.7

- Release the iPhone-first recording, import/gallery, editing, numbering/velocity/bank, per-song playback, event-looper, compressor/mixer, monitoring and song-transition feature set across the native Android and responsive plug-in/standalone edition.
- Correct the Android import menu's zero-height panel and supported audio/video file MIME types. Preserve real native touch/hold/release ownership and smooth visual playback updates.
- Add an optional disabled-by-default DAW Recorder-input bus, keeping hardware routing host-owned and monitoring Off by default. Capture input before output rendering and monitor after playback recording.
- Record the user's successful manual Android and VST acceptance. Rebuild the normal Android APK with the original production app ID and persistent release certificate.
- Prevent a background native session snapshot from reapplying stale per-song settings over a newer edit; verify the interleaved save/edit case in the native engine suite.
- Align the full desktop studio to 1.0.7 without functional changes. Build from the exact published 1.0.6 desktop source, changing only product-version metadata; include a separate corresponding desktop-source archive and verify source identity before recording the installers.
- Build and verify stable packages on a dedicated release branch; include exact source provenance, build records and SHA-256 checksums.

## 1.0.6

- Add a signed Android 1.0.6 maintenance APK and full desktop studio 1.0.6 installers for Mac Apple Silicon/Intel and Windows x64. Desktop studio features/audio match 1.0.5; Android retains the verified native touch/adaptive-output/cache path. Use real versioned builds and per-asset provenance while preserving the original native release tag.
- Add native UIKit touch-down forwarding for iOS/AUv3, Cocoa mouse-down forwarding for Mac AU/VST3/standalone, and scoped Windows WebView2 pointer forwarding. Saved cue/sample hits enter the native audio queue before WebView event processing; event-time receipts reconcile the interface once.
- Isolate adapters to their own embedded browser, including sibling plug-in editors sharing a host window. Invalidate resized/stale layouts and guard audio generations, native track revisions, blocked controls, dialogs, sample editing and zoomed views.
- Ship the selected-bank cue attack cache and chunked playback-window refill on the new native Apple/desktop builds, retaining the same 16 MiB PCM budget, native decoding, Signalsmith stretch, tuning and cue transitions.
- Preserve original-position long-press marking, empty/Overwrite pads, independent samples without a song, number-key pads, host keyboard isolation and sample-offset MIDI.
- Verify the shared engine/PCM/allocation suites, real Cocoa/WKWebView single-hit behavior through a 450 ms renderer stall, sibling-browser isolation, and the simulator UIKit/WKWebView cue/sample path with injected touches. Physical iOS acceptance requires renewed development provisioning; input-path checks do not measure touch hardware or acoustic output latency.
- Prepare native iOS/AUv3, Mac and Windows artifacts and corresponding source separately from the existing v1.0.5 full desktop studio and Android releases.

## 1.0.5

### Android input-latency refresh

- Observe the actually accepted Android stream, use its period/capacity for adaptive buffering, and reconfigure on stream revisions. Avoid probing another exclusive stream while audio is open. Production retains float-first Media/Music output; alternate transports are probe-only.
- Verify 72 physical Nothing Phone (1) pad presses across normal/stretched/tuned playback with Wavelet off: 2.95–3.89 ms median input-to-render, no new underruns, plus roughly 28 ms driver-reported output latency. Record the system-effect conditions separately from app timing; preserve device-adaptive values for other phones.
- Follow-up: prioritize the selected bank's attacks/continuation with all 160 cues marked, use smaller pages at the same 16 MiB PCM budget, and batch playback-window refills to avoid decoder seek thrashing. Native regression covers J/E/A banks and exact PCM; all 48 prepared-bank Android presses across three speed/tuning settings had zero cache misses. Preparation time is recorded separately.
- Keep command timing pending through cache-wait blocks, expose render-block elapsed diagnostics, and reduce platform status traffic to 10 Hz with immediate source/inset invalidation. Avoid redundant inset CSS writes.
- Route saved cue/sample touch-down from the Android view directly to the native command queue, with source/generation guards and event-time-matched UI receipts to prevent duplicate hits after renderer stalls.
- Retain native decoding, Signalsmith stretch, speed/tuning and cue transitions. Start with two native bursts/output rate and grow buffering after repeated underruns; the underrunning one-burst experiment remains internal.
- Preserve original-position hold/Overwrite marking, sample-only playback, deletion/dialog/overlay exclusions and resized hit regions. Use independent pointer hold timers and open sample management on release.
- Verify 17 native Android input/sample cases, renderer-stall comparisons, screen-off uncached advancement and shared native/UI regressions. Emulator median input-event-to-render improved from 10.14 to 7.12 ms, excluding touch hardware and output buffering; Nothing Phone physical latency remains to be measured.
- Refresh Android and corresponding-source assets in v1.0.5 with per-asset provenance; preserve the initial tag and other platform build records.

### Initial release

- Fixed desktop Space-bar play/pause across Discover, Studio and music/cue views, including after pad/button/fader focus. Auto-repeat is suppressed; text entry and hosted DAW Space handling are preserved.
- Simplified native cue/sample pads with no external border/ring; keyboard focus is drawn inside a pad.
- Added the default hosted **16 pads** preset: ascending notes 36–51 on any MIDI channel, using the selected bank like Legacy 12. Saved project presets remain restorable.
- Speed-fader track/thumb, brand marks, intro and waveform follow the selected accent colour.
- Improved smaller iPad and iOS landscape layouts with a readable playlist dock/overlay, explicit close controls and compact collection headers. Long playlist titles wrap within their available width.
- Stabilized artwork frames for loaded, missing and failed images. Recent-card titles are limited to two lines without resizing the artwork.
- Added a persistent Recently Played list/grid selector on Home and desktop Discover.
- Verified linear MIDI mappings, 12 native responsive shapes, 500-song queue end reachability, real Cocoa host key routing, native engine tests and desktop regression checks.

## 1.0.4

### Plug-in keyboard refresh

- Restored number-key pads in focused VST3/AU editors, retaining the existing standalone shortcuts. Letter/player shortcuts remain disabled in hosted mode.
- Added direct Mac hosted key-down/key-up routing to the host responder, with auto-repeat suppression and note-release cleanup on focus loss/editor close. Number pads use one native trigger path; text fields keep typing. A Cocoa host/WebView fixture verifies one event pair and sample-offset MIDI playback; Ableton Live hardware/user acceptance is pending.
- Refreshed native Mac/Windows archives, portable projects and source in the existing v1.0.4 release. The original v1.0.4 tag and retained mobile/full-studio binaries keep their original baseline; build records identify the refreshed source separately.

- Released the native cue standalone for Mac (universal) and Windows x64 alongside AU/VST3, native Android, and an unsigned iOS app with embedded AUv3. Full desktop studio installers remain separately labeled for Mac and Windows.
- Added per-pad sample imports on native desktop/mobile: 32-voice one-shot playback, MIDI timing/velocity, app-local retained files and session persistence. Sample pads never mark/jump cues; unassigned pads retain normal cue behavior.
- Disabled letter/player keyboard shortcuts in hosted VST3/AU/AUv3 mode so DAW computer-keyboard MIDI and transport keys remain available. Number-pad and standalone shortcuts remain active.
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
