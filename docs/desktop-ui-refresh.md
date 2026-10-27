# Desktop Discovery / Beatmaker UI refresh

The desktop workspaces now use the Musike library's shared theme tokens and
Geist UI typography, with flatter controls and less hardware-style framing.

- Button faces have no exterior borders or shadow rings. Keyboard focus uses an
  inset accent indicator.
- Search fields, session names, selectors and tool actions use rounded app-style
  surfaces. Primary transport/actions share the library's accent colors.
- Library cards, cue pads, deck/transport containers and Discovery panels separate
  by surface tone rather than outlined boxes.
- Selected banks, tracks, packs and active/pressed pads use fill/tint feedback.
  Cue timing, MIDI feedback and control behavior are preserved.
- Discovery genre colors remain visible, with softer cards, playlist rows and
  sample actions. Theme-dependent text/icon colors follow the library palette.
- Existing desktop engine panels and the compact bar receive borderless button
  styling while retaining their original controls and state feedback.

The changes are scoped to `.bm-app` / `.ds-app` and desktop engine panels.
The vertical Cues UI and the main library's components keep their own styles.
The shared desktop components are used by the main desktop app and the
desktop-layout beta assets; native feature availability remains as documented in
`native-routing-parity.md` and the plug-in README.

## Local verification

- Typechecks and the main desktop browser regression passed, including library,
  cues, MIDI mappings, FX/Advanced panels, video/VJ, persistence and responsiveness.
- Visual review used isolated synthetic tracks/artwork. Visible studio buttons
  had zero computed border widths, and the narrow desktop layout had zero
  horizontal overflow.
- Both plug-in UI archives were regenerated. Real-WebView native checks cover
  500-track windowing and portrait/landscape/square/wide/tall editor sizes.
- Local review images are in `release/ui-review/` (development artifacts).
- Fresh ad-hoc-signed macOS arm64 plug-in/standalone candidates are in
  `release/working-candidate/`. Use the **Desktop-Beta** packages for the desktop
  layout. Their metadata explicitly records an uncommitted/dirty source tree.
- The local main macOS app bundle is at
  `desktop/.native-build/package-check/mac-arm64/YT Beatmaker Cues Desktop.app`.
  Packaging and deep/strict signature verification passed.

These are working-tree changes. Existing public installers are not updated until
the coordinated release candidates are rebuilt from the final source revision.
