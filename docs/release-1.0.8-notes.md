# Beatmaker Cues 1.0.8

This release brings the iPhone library improvements to the native editions:
**iPhone/iPad and AUv3, Android arm64, macOS AU/VST3 and standalone, Windows
VST3 and standalone, and Linux x64 VST3 and standalone**.

- **Find more music.** Songs, Videos, Albums and YouTube Playlists load more
  results when another page is available. Search shows every matching saved
  playlist by name. Large playlist imports no longer stop at 500 tracks;
  the library supports up to 10,000 tracks per playlist.
- **Pick up where you are.** The playing playlist uses the app's accent colour
  for its name and the plain **Playing / En lecture** label beside the track
  count. Open that playlist or follow a source link from Now Playing or Cues
  to see the current song. Back from the playing playlist returns to its
  Library card. Open the playlist panel inside **Cues** to see the current
  song at its actual queue position without changing playback or scrolling
  again on every track change. The source and queue position survive reopening.
- **Start in Pitch mode.** The Cues fader changes speed and pitch together for
  a new song. Previously used songs keep their saved Pitch or Speed setting.
- **Add tracks without interrupting playback.** Import audio directly into a
  saved playlist, or browse **Playlists** first under **From library** and
  switch to **All tracks** as needed. Library undo/redo preserves audio and
  does not replace conflicting newer edits. Save a radio lineup as a playlist
  without changing the live queue or copying tracks you added to it separately.
- **Set your own cover.** Tap any saved playlist's cover, even
  on an empty playlist or one imported from YouTube. Choose **Photos** or
  **Files** on mobile, or an image file on desktop. Covers stay in your
  library until changed or reset. Nothing is written back to YouTube.
- **A cleaner Now Playing view.** On phone layouts it joins the tab bar
  without a strip of the page behind it. Source links use the accent
  colour, with no underline.
- **More room on mobile Home.** On standard phones, the shortcuts under the
  greeting use two columns and three rows. Taller screens can fit a fourth row
  while leaving the larger Recently Played covers and names visible below.
- **Cleaner thumbnails.** If one YouTube image size is missing, the app tries
  the alternate size. A simple waveform tile replaces missing artwork.

The native app still uses YouTube and imported local audio. The Videos search
tab does not add iOS video playback. The experimental desktop-layout beta
is not part of this release.

## Full desktop studio

The separate studio downloads are also version **1.0.8**: macOS (Apple Silicon
and Intel), Windows x64, and Linux (x64 and ARM64). They use the same pinned
studio source as the 1.0.7 studio with only the version changed, so the
native app features above do not change the studio's stems, VJ, FX,
sequencer, or sidechain. Older downloads, including
[v1.0.7](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/releases/tag/v1.0.7),
remain available.

## Install

- **Android:** the release-signed APK uses the existing application ID and
  certificate. Install over your current release, without uninstalling.
- **iOS:** download the unsigned IPA or the portable Xcode project, which
  includes the AUv3 target. You need your own signing team. Keep the same
  bundle IDs/team when updating an already signed installation.
- **macOS:** use the universal AU/VST3 or standalone ZIP. These packages are
  ad-hoc signed, not notarized.
- **Windows:** choose the native VST3/standalone ZIP or the separate x64
  full desktop studio installer.
- **Linux:** the x64 Debian package installs the VST3 and standalone with
  runtime dependencies. It targets Ubuntu 24.04-compatible systems with
  X11/XWayland. The full desktop studio has its own AppImage and Debian packages.

See the [download guide](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/blob/v1.0.8/docs/downloads-1.0.8.md)
and `SHA256SUMS-1.0.8.txt` in the release assets.
