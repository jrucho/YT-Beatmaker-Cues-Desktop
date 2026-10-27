# Shared libraries

The 1.0.4 working tree shares playlists, favorites, history and registered imported
audio between the main desktop app, Vanilla plug-in, Desktop Beta and plug-in
standalone. iOS sharing is optional and requires an entitled App Group.

## Desktop location and migration

The common document is `Beatmaker Cues/SharedLibrary/library-v1.json` under:

- macOS: `~/Library/Application Support`
- Windows: `%APPDATA%`
- Linux: `$XDG_CONFIG_HOME`, or `~/.config` when unset

`BEATMAKER_SHARED_LIBRARY_DIR` overrides the common directory. Standalone HTTP
server deployments keep their existing private `data/library.json` unless this
override and `BEATMAKER_LIBRARY_LOCK_HELPER` are explicitly configured. Explicit
native test directories also remain isolated unless a shared directory is passed.

On first access, each product imports its old library **additively**. Existing
shared playlist names and fields win; missing playlist tracks are added by ID.
Original library files, local audio and backups remain in place. Import markers
prevent an old private library from resurrecting entries subsequently removed
from the shared library. iOS markers use stable bundle identities rather than
the installation's changing sandbox path.

Desktop local-audio registrations retain their file paths, including missing-file
references. New imports go into `SharedLibrary/Media`. iOS migration copies
accessible private imported media atomically into the group container before
publishing their references, retaining the originals.

Transport, active queues, cue banks, per-track cues, loops, DAW state, window
dimensions and product preferences remain in their existing product/session
storage. Sharing a playlist does not replace another instance's performance state.
The view refreshes its library when focus/visibility returns; every edit reloads
the latest committed library before applying its change.

## Concurrency and recovery

All three implementations use the same schema-1 JSON document and byte-0 kernel
write-lock protocol (`fcntl` on Apple/Linux, `LockFileEx` on Windows). An additional
process-local mutex serializes native instances in the same host. The lock file
is persistent and is never deleted; a process exit releases its kernel lock.

Electron ships a tiny C++ lock-holder child, avoiding Node ABI-specific add-ons.
The child holds the lock while Node reads/merges/writes, and exits on parent EOF.
Library edits use keyed three-way merge so concurrent playlist renames and track
edits survive together. Writes use synchronized temporary files and atomic rename;
healthy backups and damaged originals are retained for recovery. History stays
bounded to 60 entries after merges.

The default paths are local-user storage. A shared folder on another computer is
not cross-device synchronization. Existing older application versions do not
understand this shared-store protocol and continue using their private files.

## Building the desktop helper

Desktop source builds now require CMake 3.24+ and a C++17 compiler, in addition to
Node/pnpm. `desktop/scripts/bundle.mjs` builds the host helper; electron-builder's
`beforePack` hook builds the appropriate helper for each packaged architecture.
Set `CMAKE_COMMAND` when CMake is outside PATH.

- macOS builds arm64/x64 helpers with the corresponding deployment architecture.
- Windows uses the Visual Studio x64 CMake toolchain and static C++ runtime.
- Cross-building the Linux arm64 package on x64 also requires
  `g++-aarch64-linux-gnu` (installed by the release workflow).

The executable is bundled under `Resources/native`, outside `app.asar`. The
macOS app-signing configuration includes that executable.

## Optional iOS App Groups

Unconfigured/default builds retain private storage and remain usable with existing
development signing. To enable sharing, use an App Group registered for the team
that signs **all three** targets: main app, plug-in container and AUv3 extension.
For example, replace this sample with your team's registered identifier:

```sh
# Plug-in/container/AUv3 CMake configuration:
cmake -S plugin -B plugin/build-ios-shared -G Xcode \
  -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0 \
  -DBEATMAKER_APP_GROUP=group.yourteam.beatmakercues

# Main app build settings, in Xcode or on xcodebuild:
# BEATMAKER_APP_GROUP=group.yourteam.beatmakercues
# CODE_SIGN_ENTITLEMENTS=App/SharedLibrary.entitlements
```

Choose provisioning profiles containing that group entitlement for each target.
The main app's Info.plist uses the configured group; the plug-in uses its CMake
definition and generated entitlements. Both select
`<group container>/Beatmaker Cues/SharedLibrary`. If no authorized container is
available, they keep using private storage. No bundle identifier changes or app
uninstalls are required for this feature.

The App Group API is not a way to share with desktop or Android across operating
systems. Physical App Group/signing acceptance is still pending; do not infer that
the current Personal Team/device installation already has working group access.

## Verification completed locally

- Main JavaScript, native C++ and Swift writers made **105 concurrent edits** to
  one isolated store without losing additions.
- Tests cover additive migration, concurrent rename/track merge, deletion across
  reopening, preserved original files/preferences, shared imported-media paths,
  and release of locks after helper/parent termination.
- Native tests also exercise eight same-process instances (48 writes), separate
  processes, backups and corrupt-file recovery. This caught and fixed a concurrent
  first-directory-creation race.
- Swift Foundation tests cover migration, Unicode, field/track merge and cold
  reopening, and participate in the cross-language writer test.
- Main iOS unsigned builds compile with both default/private and App Group build
  settings; plug-in container/AUv3 compiles with generated group entitlements.
- Both real plug-in WebViews passed the shared-store offline integration test:
  local AAC, native cues, Unicode library round trips, 500-track windowing,
  responsive sizing and session/library recall.
- The main app's full browser regression passed with the shared backend, including
  original Advanced panels, VJ, cues, loops and session restoration.
- A local macOS arm64 app package included the native helper, passed deep/strict
  ad-hoc signature verification, and its packaged helper passed the same
  cross-language interoperability and process-termination checks.

Windows/Linux runtime execution, physical iOS entitlement/container access, and
full hardware/DAW acceptance remain release checks. These changes are not yet in
the existing installed apps or published installers.
