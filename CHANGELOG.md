# Changelog

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
