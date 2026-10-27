# iOS plug-in standalone: background player controls

The **Beatmaker Cues Plug-in** standalone/container app now provides the system
Now Playing player on the Lock Screen and in Control Center, like the separate
main iOS app. iOS manages other system presentations, including Dynamic Island.

## Use

1. Open **Beatmaker Cues Plug-in** and start a track.
2. Leave the app or lock the screen.
3. Use native play/pause, toggle, previous/next and playback-position controls.

Title, artist, album, duration, elapsed time, playback rate and artwork come from
the native engine/queue. Artwork is downloaded asynchronously and downsampled.
The playback clock stays stopped while a requested source is still buffering.
The music audio session is claimed when playback is requested, not just when the
controller is created.

Previous restarts a source after three seconds; otherwise it selects the prior
queue entry. Manual Next overrides repeat-one. Queue navigation preserves a
paused play intent, supports rapid commands and wraps when repeat-all is enabled.
Interruption/route handling pauses appropriately and only auto-resumes when the
OS permits it and a newer pause/play intent has not replaced that decision.

## Native ownership and background state

- `IOSStandaloneNowPlaying.mm` is compiled/linked **only** into the iOS standalone
  target. The shared processor uses a small registered factory and checks the
  runtime standalone wrapper type. The controller also rejects extension bundles.
- The AUv3 binary does not link the new MediaPlayer controller/framework. The
  AUv3 host retains audio-session and system-control ownership.
- Remote actions go directly to the native processor; they do not call suspended
  JavaScript. The native queue worker resolves/loads and advances sources.
- Native checkpoints retain the current track/position/cues while the WebView is
  backgrounded. UI event emission and stale UI writes are suppressed; foreground
  reconciliation brings the player back to the native track.
- A late source load preserves a newer remote pause instead of automatically
  resuming it. No app IDs or App Group requirements are added by this feature.

## Verification

Native tests cover metadata, play/pause/toggle, paused seek/navigation, rapid
next/previous, repeat-one override, current-source restart, background checkpoint
and pause during loading. Real-WebView tests suspend native UI events, perform
background navigation, and verify foreground player reconciliation.

The iOS standalone/container and embedded AUv3 compile successfully. Binary
linkage checks show MediaPlayer in the standalone, not the AUv3 target. The
development-signed update was installed over the existing iPhone app and launched.
Physical Lock Screen/Control Center appearance, artwork and headset testing remain
manual acceptance checks after starting a track on the phone.
