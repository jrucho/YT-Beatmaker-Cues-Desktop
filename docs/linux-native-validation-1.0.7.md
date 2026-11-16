# Linux native validation — 1.0.7

## Scope and publication

This work covers the **responsive native VST3 instrument and its standalone app**
for **Linux x86-64**, built on Ubuntu 24.04. It is not the Electron full desktop
studio, an AppImage, an ARM64 build, or the separate desktop-layout beta.

The product version remains **1.0.7**. Linux files have not been added to the
existing release. The published Mac/Windows/Android/unsigned-iOS assets, tag and
release branch are unchanged. Native Linux validation is complete; publication
remains subject to user approval.

## Fixes

The apparent WebView startup timeout had multiple underlying JUCE/Linux issues:

1. The console test harness's extracted WebKit helper tried to `dlopen` an
   executable, which glibc rejects. The launcher now uses `dladdr` to locate the
   module that owns `juce_gtkWebkitMain`: load the VST3 shared object, or re-execute the application
   with JUCE's child flag when the symbol belongs to the executable. The comparison
   uses `hostApplicationPath`, since on Linux `currentExecutableFile` may identify
   the plug-in module rather than the actual process executable.
2. Pipe frames counted Unicode characters instead of UTF-8 bytes, and received
   UTF-8 as ASCII. GTK's JavaScript callback had a second ASCII conversion.
   Non-ASCII playlist data was truncated/corrupted before the library could
   commit it. All three boundaries now explicitly preserve UTF-8.
3. Pipe writes now resume after short writes and `EINTR`.
4. Runtime loading now uses versioned SONAMEs. End users do not need the
   unversioned symlinks supplied only by development packages.

`plugin/Scripts/patch_juce_linux.py` applies these changes to the pinned JUCE
source at configure time. Each replacement is checked and the patch is idempotent.
It does not change the other platforms' JUCE sources.

## Verification

The regression executable uses the actual patched JUCE transport/callback code,
not a separately implemented copy. On this macOS development machine, the
original code failed the Unicode/short-write cases. With the patch, all six pass:

- ASCII baseline;
- Unicode framing and fragmented receive;
- short writes;
- interrupted short writes;
- 409,648-byte multilingual library payload;
- GTK JavaScript-to-native Unicode callback.

Matching source ZIP/tar/dependency archives have been exported from the clean
Linux build commit below. SHA-256/ZIP integrity, private-file exclusions, ZIP/tar content
agreement and idempotent patching of the bundled JUCE source pass. An extracted
source archive installs from the frozen lockfile, typechecks all workspaces and
regenerates the native UI. An independent macOS arm64 build using the bundled
dependencies also passes all six portable engine/library/FX tests. Those portable
build inputs are unchanged by the final Linux-only launcher correction. This is
source-rebuild verification, not a substitute for Linux runtime testing.

**Linux CI passed completely:**
[run 43887845345](https://github.com/jrucho/YT-Beatmaker-Cues-Desktop/actions/runs/43887845345),
source `2946741190d42a09f6c59d0a2658dfdbd89c85eb`.

| Check | Result |
| --- | --- |
| Engine, persistence, large-library cache, transport, effect kernels, FX graph and original-worklet parity | All 7 native suites pass |
| Electron/native shared library | Additive migration and 85 concurrent cross-language writes pass |
| Original browser/native FX comparison | All 123 comparisons pass |
| Offline real WebView/native audio | Local AAC, cues, sample pads, keyboard looper, background navigation, editor recall and durable library pass |
| Large multilingual library | 500-track commit/load and exact Unicode/quotes/backslashes round-trip pass; responsive/windowed layout passes at five sizes |
| Real Linux standalone | App-owned WebKit child and JavaScript/native bridge pass |
| Real VST3 loaded by a separate host | JavaScript bridge, optional DAW input/monitor PCM, MIDI/audio, editor resize and state round-trip pass |
| Installed Debian package in clean Ubuntu 24.04 | Runtime-only dependencies and installed standalone WebKit/JavaScript pass |

Standalone and hosted tests execute JavaScript; merely constructing an editor
or finding an unrelated WebKit process is not sufficient.

The clean container installs the `.deb` and its declared runtime dependencies,
asserts that development symlinks are absent, and launches the installed
standalone with an app-owned WebKit process and a JavaScript/native bridge
round-trip. CI uses Xvfb/software rendering and disables
WebKit sandbox/compositing only inside that headless test environment; these
settings are not installed into the application launcher.

Downloaded artifacts independently pass SHA-256, ZIP CRC, safe-path/private-data,
build-provenance, ELF x86-64, executable-permission, license and Debian metadata
checks. The VST3 and standalone binaries are byte-identical between the Debian
package and their corresponding ZIPs. Matching source archives identify the same
clean commit and include the Linux fixes and pinned dependency sources.

## Verified candidate files

These are CI artifacts, **not assets of the published v1.0.7 release**.

| Package | Bytes | SHA-256 |
| --- | ---: | --- |
| `Beatmaker-Cues-Plug-ins-1.0.7-Linux-x64.deb` | 9,762,224 | `629c08b3449036086c657a82ea3f535f4b887058cf6c87c85a988d78fb1aad13` |
| `Beatmaker-Cues-Plug-ins-1.0.7-Linux-x64.zip` | 11,934,414 | `2ea7a60346df06da594d4cd26dbfd5c0225b5af3f351683f8408d1d1efc0bfda` |
| `Beatmaker-Cues-Plugin-Standalone-1.0.7-Linux-x64.zip` | 6,021,877 | `b98f0671be29c76759c8d70c63bf2beee52443b878cae9ad284ebbc0dbb5c833` |

The artifact also contains `Plugin-Build-1.0.7-Linux-x64.json` and
`SHA256SUMS-Plugins-1.0.7-Linux-x64.txt`.

## Candidate installation

Use an x86-64 Ubuntu 24.04-compatible system with X11 or XWayland.

The Debian package installs both the native standalone and VST3:

```sh
sudo apt install ./Beatmaker-Cues-Plug-ins-1.0.7-Linux-x64.deb
```

The standalone is available in the application menu. The VST3 is installed at
`/usr/lib/vst3/Beatmaker Cues.vst3`; rescan the DAW after installation.

For a per-user VST3 installation, unpack the plug-in ZIP and run its
`python3 install.py`, which copies the VST3 to `~/.vst3`. ZIP installation does
not install runtime dependencies. The standalone ZIP contains the native app,
not the full desktop studio.

## Acceptance still requiring real hardware

Headless CI does not establish audible output, microphone/interface behavior,
physical latency, reconnect handling, or compatibility with every third-party
Linux DAW. Those remain manual acceptance checks. No existing library/profile
data is included in candidate packages or uploaded diagnostics.
