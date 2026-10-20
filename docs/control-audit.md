# Version 1.0 control audit

This is a record of what the automated checks exercise, not a claim that every hardware/model combination has been tested.

## Tested with real app code and deterministic external-media fixtures

| Area | Verified action |
| --- | --- |
| Opening page | Discover Samples is shown first; returning from the studio works |
| Music crates | All six crate buttons send catalog searches and show results |
| Search | Submit, empty-result state, request failure and retry |
| Included banks | Kick, snare and hi-hat selectors each expose ten real files |
| Sample previews | Play the bundled WAV file, rather than animate a placeholder |
| Sample downloads | Download links produce the selected WAV filename; all thirty files are checked |
| Music preview | Preview/pause is connected to the shared player |
| Favorites | Save changes persist through the actual local library API |
| Load in Studio | Selects the track and enters the performance workspace |
| Cue pads | Capture, keyboard seeking, extra pads and bank isolation/restoration |
| Transport | Seeking, return-to-start, volume and pitch control |
| Region loops | I/O creates a persisted enabled region; I+O clears it |
| Cue randomization | Generates actual cue positions |
| Guide | Opens and closes with Escape |
| MAP | Opens the original MIDI mapping panel |
| Original tools | Advanced, Sequencer, FX Pad and Sidechain open and close without JavaScript errors |
| Compact controls | Rebuild after the original Advanced action removes them; toggle remains reachable |
| Audio/video | Changes the shared player's media element using a decoded video fixture |
| VJ | Opens for video, enables processing, and creates a monitor with a live compositor video track |
| Settings | Studio-inapplicable appearance settings are omitted |
| Optional stems host | Model-status requests work when no model is installed |
| Sessions | Export contains track references; import persists cues and a real playlist |
| Library views | Cover/list buttons change the actual layout |
| Persistence | Navigating away and reloading retains cue data |
| Layout | Discovery and studio do not overflow a narrow viewport |
| Resources | Missing engine assets and browser JavaScript errors fail the checks |

The tests run a real isolated server/library. YouTube catalog responses and media streams are fixtures so that network changes do not make the control checks unreliable. The included drum files are checked as shipped, not replaced by test audio.

## Corrections made

- Replaced MAP's guide action with the original MIDI mapping action.
- Made the compact bar reconstructible and independently closable, and moved its default position away from its toggle.
- Connected workspace cue triggering through the original sequencer/MIDI-recording path.
- Added disabled states for controls awaiting the engine, a loaded source or video.
- Removed Chrome-tab-only controls from the single-player VJ interface.
- Removed studio-inapplicable appearance settings from the studio's Settings dialog.
- Kept the native rate fader in percent regardless of the original engine's percent/semitone setting.
- Made cue-save status compare against actual local persistence.
- Added failure feedback instead of silent actions for engine readiness and session failures.
- Made copied cue links point to the YouTube source rather than a local server address.

## Device/model-dependent verification

MIDI hardware detection/mapping, microphone permissions, output-device routing, full AI model download/inference, physical projector behavior and every original DSP parameter combination still require the intended devices or model. Their controls call the original implementations; they are not simulated success buttons. Intel installers are built and signature-checked, but not run on Intel hardware.

## Run

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec playwright install chromium
pnpm test:app
```

To use an already installed Chromium browser, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable.
