# Official product lineup (local development; publication on hold)

User direction, 2026-10-27: wait until the applications and plug-ins are ready
together. Do not publish 1.0.4 or push further changes while this hold applies.

| Product | Official implementation |
| --- | --- |
| iOS | Native JUCE app formerly called the plug-in standalone, with its embedded AUv3 |
| Android | New native JUCE Android application, with the loading, touch and safe-area fixes |
| Desktop standalone | Existing full desktop 1.0.3 application |
| VST3 / AU | Native plug-in with a unified responsive cue workspace, supporting portrait and landscape |

## Name, icon and compatibility

- The native application shell is named **Beatmaker Cues**.
- The official icon is the original iOS artwork from
  `mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`.
  The native build uses its copy at `plugin/Assets/AppIcon.png`. Active native
  builds do not use `PluginIcon.png` or the artwork with the PLUGIN caption.
- Existing native bundle/application IDs, plug-in codes and internal plug-in
  settings name are retained so candidate updates preserve libraries, cue banks,
  sessions and DAW identity. The plug-in's internal name remains
  `Beatmaker Cues Plug-in`; its application shell and icon use the official brand.
- The separate historical desktop-layout beta remains a development target.
  The official responsive cue interface provides both orientations in one build.

## Responsive cue workspace

The Library return button and the Cues entries in both the mobile tab bar and
wide sidebar allow navigation between browsing and performance without reloading
the audio engine. The performance page has its own transport and hides the
duplicate mini-player/player bar.

Pads, banks A–J, marking/overwrite, speed, independent tuning and IN/OUT controls
share the visible page height. Portrait normally uses a 4×4 pad grid; short
landscape windows use an 8×2 grid. Legacy twelve-pad mode adapts to 3×4 or 6×2.
MIDI/controller selection and compact-layout individual cue deletion remain
available in the MIDI settings dialog.

Android layout follows measured window dimensions, because some JUCE-hosted
WebViews report zero-height CSS viewport units and incorrect orientation media
queries. Native cutout/system-bar geometry supplies the safe-area padding.

## Android audio improvements

The Android reader now decodes AAC pages on demand with MediaExtractor/MediaCodec
behind the bounded native PCM cache. It no longer waits for a whole-song PCM
conversion or writes that conversion to disk before starting playback.

Local API 35 arm64 emulator observations for the 645-second Jean Carn test song:

- Previous full-file conversion: about 75–79 seconds before first render.
- New fresh download: about 2.39 seconds from native load request to first render,
  including 2.16 seconds downloading the encoded file.
- New cached encoded file: about 0.18–0.31 seconds to first render.
- A 200-second Ralfi Pagan song: about 1.54 seconds observed from selection;
  native load-to-render was 1.25 seconds, including a 0.94-second download.
- Streaming PCM matched the previous sequential decoder exactly at seven
  start/early/middle/late/backward-read windows. AAC timestamps are aligned to
  inferred access-unit boundaries to avoid one-sample seek offsets.

The standalone selects two supported hardware audio bursts rather than JUCE's
40/100 ms default queue. On the emulator this changed the requested buffer from
4800 to 1920 frames at 48 kHz. Real touch-down checks reached native transport in
24–34 ms; these observations exclude physical audio-device output latency.

Full desktop native stems/FX/sequencer/sidechain/VJ parity is still separate work.
The desktop 1.0.3 implementation remains the official full desktop standalone.
