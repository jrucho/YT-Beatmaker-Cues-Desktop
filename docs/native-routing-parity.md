# Native-routing parity work

## Integration rule

The requested target is full feature parity across the main desktop, iOS/iPadOS
and Android apps. Native core playback alone is insufficient to replace the
desktop Advanced audio graph. Existing feature routes remain available while
their native equivalents are built and verified.

## Audited source boundaries

- `web/src/beatmaker/runtime.ts` adapts the original studio's storage, MIDI,
  transport and browser messaging.
- `YTbeatmakercues/content.js` owns the Advanced graph, four parallel FX corners,
  compressor/leveling stages, buses, sequencers, sidechain curves and routing.
- `YTbeatmakercues/worklets/` contains quantizers, phaser, stutter, vinyl break,
  speed/stretch and loop recording.
- `YTbeatmakercues/addons/stems/` owns separation, retained stem media, aligned
  playback and prepared stretch. Native stems must preserve shared timelines.
- `YTbeatmakercues/vj-live.js` and `video-region-loop.js` own video/projection and
  video region scheduling. VJ has a video synchronization contract as well as audio.
- Current main engines are Electron/Web Audio, iOS AVAudioEngine and Android
  ExoPlayer; the plug-in uses JUCE/sample-offset native rendering.

## Portable DSP kernels

`plugin/Source/dsp/EffectKernels.h` is independent of JUCE and platform APIs:

| Original effect identifier | Native kernel status |
| --- | --- |
| `bitDecimator` | Quantization and original X-to-4–12-bit mapping ported |
| `bitCrash` | Same original decimator alias ported |
| `twelveBit` | Original 12-bit quantizer ported |
| `centerCancel` | Original left-preserve/right-invert stereo routing and gain ported |

JavaScript's negative half-tie rounding and negative zero are reproduced, rather
than using C++'s different `round` rule. The center-cancel kernel intentionally
matches the original graph's stereo phase inversion, not a different mono
subtraction effect.

The plug-in engine can run a selected kernel before output gain, with a coherent
block-boundary control snapshot, backward-compatible host state, and exact bypass.
The internal `effectKernel` bridge validates controls and rejects unported effects.
These kernels also form part of the larger native graph below.

## Four-corner FX graph

`dsp/FxGraph.h`, `FxPrimitives.h` and `Dynamics.h` now implement four parallel
corners, single/multi routing, the master leveler and the original per-effect
leveling stages. The graph is available through the internal `fxGraph` bridge
and optional `NativeFxGraph` host-state child. It is disabled for older states.

The graph supports **29 original effect identifiers plus `none` bypass**:

- Quantization/phase: `twelveBit`, `bitDecimator`, `bitCrash`, `centerCancel`.
- Delay/hold: `delay`, `tapeEcho`, `echoBreak`, `oneShotDelay`, `freezeLooper`.
- Filters/drive: `isolator`, `equalizer`, `subsonic`, `filterDrive`, `distortion`,
  `overdrive`, `fuzz`, `resonator`, `wah`.
- Modulation: `autopan`, `tremoloPan`, `ringMod`, `chorus`, `flanger`.
- Original delay-modulation aliases: `pitch`, `octave`, `chromPitchShift`,
  `pitchFine` (these preserve the original implementations, not a new pitch algorithm).
- Dynamics: `compressor`, `duckComp`.

Key behavioral details verified against the original browser implementation:

- Feedback returns through a 128-frame quantum; a flanger's DelayNode can still
  have zero instantaneous delay. Fractional delay/interpolation is preserved.
- Overlapping 40 ms linear ramps retain their scheduled order, including
  equal-time endpoints and changes between single/multi mode. A bounded event
  timeline reproduces this behavior rather than restarting every ramp.
- Web Audio's low/high-pass Q convention, default shelf frequencies, finite
  WaveShaper curve interpolation and additive oscillator/AudioParam values are
  retained.
- Dynamics adapt the pinned WebKit algorithm, including adaptive release,
  automatic makeup, stereo linking and look-ahead. BSD notices are retained in
  source, native package licenses and Apple bundle resources.
- The host receives the graph's look-ahead latency (e.g. 288 samples for one
  leveler, 576 for two at 48 kHz). Disabled graph playback retains zero declared
  look-ahead. Echo/hold tails continue with paused transport and are reported to
  the host, including infinite feedback where the original permits it.
- Delay memory is allocated during prepare; resets invalidate old history in
  bounded time. Control snapshots use a lock-free triple buffer. Rendering,
  control consumption and curve updates allocate no C++ heap memory in tests.

This is a native graph implementation, not completion of all Advanced routing.
Unported identifiers still reject explicitly: `vinylSim`, `reverb`, `phaser`,
`beatRepeat`, `noiseGen`, `radioTuning`, `slicerFlanger`, `bpmLooper`, `vinylBreak`,
`stutterGrain`, `jagFilter`, `loopBreaker`, `reverbBreak`, `pitchUp`, `flangerJet`,
and `phaserSweep`. Effect replacement/fade lifecycle also needs broader UI
acceptance alongside these remaining nodes.

The original UI is not switched to this partial path. Full native routing still
needs the complete graph, buses, stems, sequencer/sidechain scheduling, recording,
all remaining effect types and VJ synchronization, followed by platform bindings
and acceptance checks.

## Verification

- `scripts/check-native-effect-kernels.mjs` executes the actual original quantizer
  AudioWorklet sources in a VM, then compares native output bit-for-bit over
  deterministic Float32 vectors and boundary controls: **73,908 comparisons passed**.
- `EffectKernelTests` also checks negative half ties, signed zero, stereo phase
  routing, control mapping and containment of nonfinite audio.
- Engine tests verify host-bus placement before gain, stereo independence, control
  validation, native state recall, old-state compatibility and unchanged bypass,
  under the existing callback-allocation guard.
- Real-WebView tests exercise the native bridge and unsupported-effect rejection.
- `scripts/check-native-fx-graph.mjs` renders the actual original factories in
  Chromium `OfflineAudioContext` and compares them with native output. **123
  comparisons passed** at 44.1/48/96 kHz, including corner mixing, overlapping
  ramps, mode switches, filter/drive/compressor changes and variable delay.
  Reference renders must contain nonzero effect output. Static stages/graphs use
  peak and normalized-RMS limits of 0.0001; oscillator/modulated-delay cases use
  0.005 peak and 0.001 normalized RMS to account for browser oscillator tables and
  SIMD delay read-position precision. These are numerical comparisons, not a
  claim that every browser's output is bit-identical.
- Native graph tests cover fractional/feedback impulses, nonallocating bounded
  resets, all supported identifiers, 100,000 concurrent control snapshots, tail
  rendering with paused transport, host latency, state recall and exact bypass.
- Both local editions' test targets also exercise the shared-store WebView and
  bridge validation. Apple plug-in/container builds compile the native graph;
  physical listening and DAW acceptance remain separate release checks.

This work does not establish full Advanced/stems/FX/sequencer/sidechain/VJ parity.

## Device update — 2026-10-26

The connected iPhone 17 Pro received in-place updates to the main app
**1.0.4 / 10004** and plug-in container **1.0.4** with its embedded AUv3. Both
development-signed apps launched successfully; no app was uninstalled. The app
identifiers were preserved. App Groups remain disabled for this private-storage
device build. Installation/launch is not a physical listening or AUv3-host test.

The subsequent native-kernel build was signed and verified after those successful
updates. After reconnecting the iPhone, that follow-up plug-in/container/AUv3
update was also installed successfully. The updated container launched, and the
main app was reopened afterward.

The later standalone update adds native background Now Playing controls and
foreground reconciliation; see `ios-plugin-standalone-player.md`. It also carries
the current native FX graph. Desktop UI styling work is recorded separately in
`desktop-ui-refresh.md`. These additions do not complete the remaining native
Advanced/stems/sequencer/sidechain/VJ routing work.
