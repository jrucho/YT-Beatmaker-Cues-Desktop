# Loading and large-playlist audit — 2026-10-26

These measurements are from the uncommitted 1.0.4 working tree on an Apple Silicon
Mac. They are local diagnostics, not measurements of released packages, physical
iOS/Android devices, or DAW/device output latency.

## Reproduced native UI freeze

Reference playlist: `PLW4NDfp3IicGyAw0Ix0Z0yr-FL35Eo_qB` (SOUL SAMPLES).

The browser-only catalog test completed quickly, but the real JUCE WebView stalled
after receiving a playlist page. Two native runs exceeded 160/240-second command
timeouts. A process sample captured the main thread in
`NativeFunctionsProvider::emitCompletionEvent` → `WebBrowserComponent::Impl::emitEvent`
→ `String::replace` / `replaceSection`. JUCE 8.0.12 repeatedly escapes backslashes
in the serialized response. Large nested catalog JSON causes quadratic copying
on the message thread.

`WebEditor.cpp` now serializes/encodes large worker results into a UTF-8 base64
envelope before posting completion. `bridge.js` decodes that envelope before
resolving the original promise. Small responses retain their existing shape.
Both HTTP responses and library snapshots use this path. An offline real-WebView
500-track round trip checks Japanese text, emoji, quotes and backslashes.

## Live results after the fix

| Path | First 100 tracks | Complete to configured 500-track limit | Warm catalog reopen |
| --- | ---: | ---: | ---: |
| Server, initial run | 525 ms | 1,846 ms | 0 ms / no requests |
| Desktop beta WebView | 536 ms | 2,079 ms | 0 ms |
| Vanilla WebView | 570 ms | 2,299 ms | 0 ms |

The playlist has more entries than the configured limit; results correctly report
`truncated: true`. These times do not measure saving/rendering the entire playlist.

For `GFaNcr3uIvQ` (JOB Orquestra – Only Faith And Hope, 295 seconds), selected
from that playlist, the actual WebView/player/host-bus test measured:

| Editor | Cold observed play-to-audio | Warm observed reload | Cold native request-to-first-render | Warm native request-to-first-render |
| --- | ---: | ---: | ---: | ---: |
| Desktop beta | 1,308 ms | 300 ms | 1,115 ms | 173 ms |
| Vanilla | 1,029 ms | 308 ms | 741 ms | 173 ms |

Observed values include polling granularity. Native timings exclude URL
resolution, while observed values include the UI path. Warm selection can reuse
the JS resolver as well as the native file; the resolver diagnostic may still
describe the original resolution. These are single runs, not statistical claims.

## Other verified changes

- Four browser checks (200/500 tracks; phone/desktop; 4× CPU throttle) mounted
  14–15 rows and 459–482 total DOM nodes. First row: 283–327 ms. Keyboard End/Home
  revealed the appropriate track without placing it under player/navigation.
- Both real WebViews passed 500-track windowing at portrait, landscape, square,
  wide and tall dimensions, reachable native grip and editor-size/state recall.
- A process-local keyed mutex now supplements the per-file interprocess lock.
  POSIX record locks alone do not exclude another downloader thread in the same
  host process. Deterministic injected-transport tests verify one download across
  prefetch promotion and two processor instances, independent start positions,
  warm cache reuse, and cancellation without retries/partial cache publication.
- Native engine, persistent library and 500-track library-cache CTests passed
  in both normal and beta builds. Typechecks and playlist loading/stream checks
  also passed.

## Long-track blocker resolved in the working tree

`7sFnp7bKwdE` (Jean Carn – My Love Dont Come Easy) is 645 seconds long. The initial
audit found it exceeded the old `24 * 1024 * 1024`-frame resident PCM limit.
It now plays successfully in both local native editor builds.

`Source/PagedAudio.{h,cpp}` supplies a fixed-size, lossless float PCM page cache:

- Tracks above 4,194,304 frames use 64 preallocated 32,768-frame pages: **16 MiB
  stereo PCM per loaded cache**, independent of track duration. Short tracks
  retain a resident buffer of at most 32 MiB stereo. These figures exclude decoder,
  UI and indexing overhead; transitions can briefly retain another sample/cache.
- The initial playback window is primed on the loader. A worker then decodes
  look-ahead, loop endpoints and marked cue neighborhoods in priority order.
- The real-time render callback uses pinned pages, lock-free atomics and no
  decoder/IO calls or C++ heap allocations. A missing cold cue window fades to
  silence, holds the requested position and fades back in when ready. Cold cues
  can therefore have a short cache-fill delay; cached cues retain direct routing.
  The cache warms as many cue neighborhoods as fit, not all 160 simultaneously.
- Explicit non-realtime/offline host rendering may wait for the worker so a fast
  bounce does not insert silent cache-wait blocks or stretch the timeline.
- Background read errors notify the UI; obsolete samples and their workers are
  reclaimed off the audio thread. Saved-file/host-state format remains compatible.

Latest live reference-song measurements (separate single runs; no physical
output latency; observed playback polls at 100 ms):

| Editor | Cold observed play-to-audio | Warm observed reload | Warm native request-to-first-render | Cold mid/late-song cue observation |
| --- | ---: | ---: | ---: | ---: |
| Desktop beta | 908 ms | 204 ms | 13.85 ms | 12.3 / 16.6 ms |
| Vanilla | 1,400 ms | 208 ms | 14.93 ms | 8.4 / 14.9 ms |

The cold cue targets were approximately 322.5 and 630 seconds. The reference
playlist still completed to 500 tracks in about 2.0–2.2 seconds in these runs.
Both editors also passed a fresh native processor's host-state recall of the
reference song's full duration, saved position and subsequent host-bus playback.

Both editions' native tests cover a synthetic 645-second stereo source, PCM
content checks, a forced 40 ms background read, replacement/warmed cues, 90 distant
evictions, loops, independent pitch/speed, offline random seeks and a continuous
54-second offline render beyond the cache's capacity, exact end-of-track, and
background read failures. Both macOS AU/VST3/standalone editions rebuilt, and
the VST3 host probes passed MIDI rendering, resize forwarding and saved state.
The new code also compiles for iOS container + AUv3;
physical iOS memory/listening acceptance and Windows/Linux execution remain pending.

Shared main-app/plug-in libraries and opt-in iOS App Group storage are now
implemented locally; see [shared libraries](shared-libraries.md) for verification
and remaining physical signing/container acceptance. Full native
Advanced/stems/FX/sequencer/sidechain/VJ routing remains pending. No release was
created and existing release binaries do not include these working-tree fixes.

## Reproduction

```sh
node --import ./server/node_modules/tsx/dist/loader.mjs scripts/profile-live-playlist.mjs 'http://youtube.com/watch?v=7sFnp7bKwdE&list=PLW4NDfp3IicGyAw0Ix0Z0yr-FL35Eo_qB'

# After building WebIntegration for the desired editor:
./plugin/build-mac-beta/WebIntegration_artefacts/Release/WebIntegration --offline
./plugin/build-mac-beta/WebIntegration_artefacts/Release/WebIntegration --profile-playlist 'http://youtube.com/watch?v=7sFnp7bKwdE&list=PLW4NDfp3IicGyAw0Ix0Z0yr-FL35Eo_qB' short

# Omit "short" to test the supplied 645-second song, including mid/late/start cues
# and native host-state recall.
```

WebIntegration uses isolated temporary library and audio-cache directories and
removes them on normal exit. The server profiler only reads live metadata.
