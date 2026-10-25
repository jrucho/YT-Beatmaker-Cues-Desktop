# 1.0.4 release plan and audit

Audit date: 2026-10-25. Repository:
<https://github.com/jrucho/YT-Beatmaker-Cues-Desktop>.

## Decision and present state

### Decisions approved after the audit

- Keep the mobile-style editor as the main plug-in; add a separate desktop-layout
  beta with distinct IDs and data storage. The beta currently covers native
  core controls; desktop stems/FX/sequencer/VJ host routing is not implemented.
- Use a new persistent Android release key plus explicit migration. The key was
  created outside the checkout and configured as encrypted GitHub Actions
  secrets. Its public certificate fingerprint is committed under
  `mobile/android/release-certificate.sha256`; final assembly checks it.
- Implemented a coordinated reusable-workflow pipeline and draft-only assembly,
  source exporter, licensing/build guides and cue-aware backup tooling. Native
  cross-platform candidate execution and physical acceptance remain outstanding.

**Not ready for a complete stable release yet.** Local development packages are
available, but Windows/Linux 1.0.4 builds, unified publication, clean-source
rebuilds, Android signing continuity and hands-on acceptance are outstanding.

The permanent working checkout is `Downloads/Beatmaker-Cues-1.0.4`, branch
`release/1.0.4`. The implementation remains uncommitted on top of
`8037ceb214ea36b415006804ab575cc14c1289f0`. Local packages with that base SHA and
`workingTreeDirty: true` are test candidates, not final immutable-release builds.

## Published release comparison

GitHub API audit:

| Release | Published | Uploaded assets | Coverage |
| --- | --- | --- | --- |
| v1.0.0 | 2026-10-20 | 3 | Mac arm64/x64 DMGs and checksums |
| v1.0.1 | 2026-10-20 | 8 | Mac, Windows x64, Linux x64/arm64, checksums |
| v1.0.2 | 2026-10-21 | 14 | Above plus Android test APK, unsigned iOS IPA, portable main-iOS Xcode ZIP, metadata/checksums |
| v1.0.3 | 2026-10-24 | 16 | Above plus desktop-refresh source ZIP and separate desktop checksums |
| v1.0.4 | Not published | None on GitHub | Integrated plug-ins are new for this release |

GitHub's automatically generated source links are additional to uploaded assets.
Previous releases have **no AU/VST3/AUv3 or plug-in standalone downloads**.

The v1.0.3 tag points to `4dbaabecfd45d4911a06bcc527bd5fbac805d608`, while
the subsequent desktop refresh/main checkout is `8037ceb...`. For 1.0.4, eliminate
this source/artifact ambiguity: one final source SHA must match the tag and every
final build record. Preserve older releases and their existing assets.

## Product/UI contract to freeze

- Main macOS/Windows/Linux application: full desktop interface and studio.
- Main iOS/Android application: responsive mobile interface with vertical phone
  layout. Responsive/vertical does not imply portrait-only orientation.
- All current plug-in editors and the plug-in standalone use the embedded
  mobile-style interface. Desktop plug-ins do **not** have the full desktop
  Advanced/stems/VJ interface.
- Confirm whether that plug-in interface is acceptable for 1.0.4. If full desktop
  UI is required in desktop plug-ins, complete that feature before freezing.
- Main-app and plug-in libraries remain separate. No App Groups or automatic
  iOS main-app/container/extension library sharing is promised.

## Required download matrix

Use these names to avoid confusing the main desktop app with the plug-in
standalone. Architecture coverage is explicit; there is no implied Windows ARM
or Linux ARM plug-in support in this initial plug-in matrix.

| Product | Required artifacts | Current evidence / remaining work |
| --- | --- | --- |
| Main macOS | `YT-Beatmaker-Cues-Desktop-1.0.4-macOS-arm64.dmg`, `YT-Beatmaker-Cues-Desktop-1.0.4-macOS-x64.dmg` | Local builds, versions/architectures, signatures, DMG integrity and shared regressions pass. Final frozen-SHA rebuild and packaged-app/upgrade acceptance pending. Intel hardware pending. |
| Main Windows | `YT-Beatmaker-Cues-Desktop-1.0.4-Windows.exe` | Native Windows 1.0.4 build and installation/playback verification pending. |
| Main Linux | `YT-Beatmaker-Cues-Desktop-1.0.4-Linux-{x64,arm64}.{AppImage,deb}` | Native Linux CI packaging and runtime/dependency checks pending. Retain both architectures from 1.0.3. |
| Main Android | `Beatmaker-Cues-Test-1.0.4-Android.apk`; production-signed Setup APK/AAB only if a persistent production key is configured | Local debug build, v2 signature, 1.0.4/10004 metadata and bridge checks pass. No connected physical device. Confirm signing/migration before final publication. |
| Main iOS | `Beatmaker-Cues-Test-1.0.4-iOS.ipa`, `Beatmaker-Cues-Xcode-1.0.4.zip` | Local unsigned archive/export, independent portable-export build and packaging checks pass. Separately development-signed 1.0.4/10004 installed/launched on iPhone. User acceptance pending. |
| macOS plug-ins | `Beatmaker-Cues-Plug-ins-1.0.4-macOS-universal.zip` containing AU/VST3/standalone; `Beatmaker-Cues-Plugin-Standalone-1.0.4-macOS-universal.zip` | arm64 local builds, engine/store/WebView/VST3 checks pass. Universal build, exact-final AU validation and DAW acceptance pending. |
| Windows plug-ins | `Beatmaker-Cues-Plug-ins-1.0.4-Windows-x64.zip`, `Beatmaker-Cues-Plugin-Standalone-1.0.4-Windows-x64.zip` | Native build, VST3 probe, WebView2/FFmpeg/runtime checks pending. |
| Linux plug-ins | `Beatmaker-Cues-Plug-ins-1.0.4-Linux-x64.zip`, `.deb`, and `Beatmaker-Cues-Plugin-Standalone-1.0.4-Linux-x64.zip` | Native build, VST3 probe, display/WebKitGTK/CURL/FFmpeg checks pending. |
| iOS plug-in | `Beatmaker-Cues-AUv3-1.0.4-iOS-unsigned.ipa`, `Beatmaker-Cues-Plugin-Xcode-1.0.4.zip` | Container + embedded AUv3 build and portable export rebuild pass. Separately development-signed container 1.0.4 installed/launched. Host listening, session/editor-closed and iPad acceptance pending. |

Only advertise production-signed Android APK/AAB when the actual key and artifact
are verified. Unsigned release outputs may be offered for developers with clear
labels, but are not the installable end-user APK. No paid Apple signing or
notarization is a prerequisite for publishing honestly labelled unsigned/ad-hoc
downloads; do not describe them as App Store/TestFlight/notarized releases.

## Confirmed Android update blocker

The published v1.0.3 APK was downloaded and checked with `apksigner`:

- 1.0.3 certificate SHA-256:
  `12920d71c9dad3ee13c5ba5a2a613ee8aaab6230e617aaefac49186a3882219c`
- Current local 1.0.4 test certificate SHA-256:
  `1b64441a2f1d5cde7a41b6c2f2287d858f920f195ba616eb1282589803525312`

These differ. The current APK **cannot update that published APK in place**.

Before final publication:

1. Determine whether the old private signing key is available. A certificate or
   an old APK alone cannot recover the private key.
2. If available, sign the candidate with it and test `adb install -r` while
   retaining library/cues/settings.
3. Otherwise document and test library export/import migration before any
   uninstall, or choose a deliberate side-by-side migration strategy. Do not
   silently change the application ID or uninstall user data.
4. Establish a persistent key for future builds, back it up, and configure CI
   secrets. Fresh runner-generated debug keys are not a stable upgrade strategy.

## Phased execution order

### Phase 1 — scope, compatibility and source review

- [ ] Resolve desktop plug-in UI scope above.
- [ ] Resolve Android key/migration strategy above.
- [ ] Review all tracked changes and newly imported plug-in files; include only
      intended source and required assets. Review team/bundle settings without
      breaking legacy IDs, cue numbering, MIDI IDs or DAW state compatibility.
- [ ] Keep local SDK/JDK/Gradle downloads, signed device builds, credentials,
      user libraries/cache, `node_modules`, native build trees and release backups
      out of repository/source artifacts. Project-local tooling and device-build
      directories now have repository ignore rules as well as local exclusions.
- [ ] Validate stored-library/legacy-state migration, missing media handling and
      multi-instance edits. No automatic cross-sandbox sharing is required.

### Phase 2 — complete the build and publication pipeline

The current workflows are not a complete coordinated release:

- `release.yml` builds/publishes main desktop + Android independently.
- `ios.yml` normally builds on release publication, or manual dispatch; its
  publisher contains historical text and unsupported approval claims.
- New `plugins.yml` uploads CI artifacts but does not attach them to a GitHub
  release or gate the main publisher. It is not on GitHub yet.
- The main desktop publisher can therefore complete before plug-ins/iOS exist.

Required fixes:

- [ ] Add branch/PR candidate builds or reusable workflows so all targets can run
      before public publication, including the new plug-in workflow.
- [ ] Add one orchestration/aggregation step accepting a frozen source SHA. Build
      main desktop/mobile, desktop plug-ins and AUv3 from that exact SHA.
- [ ] Collect only an explicit expected asset list in a fresh staging directory.
      Do not upload `release/*` from this mixed local folder: it also contains
      previous releases, backups, unpacked exports and development metadata.
- [ ] Make final publication wait for every required build/export/verification.
- [ ] Remove stale iOS release-note text, the claim that latency work is still
      deferred to 1.0.4, and claims of user approval not evidenced for this build.
- [ ] Generate truthful per-platform metadata (SHA, dirty flag, architecture,
      toolchain, run URL, signature and actual passed tests). Local iOS metadata
      now records a dirty working tree too.
- [ ] Add final asset/version/architecture/checksum validation and verify the
      uploaded GitHub digests. Gate any overwrite of final assets on a deliberate
      release operation; ordinary build dispatches should produce artifacts only.

### Phase 3 — clean-checkout and native build verification

- [ ] Review/commit the source branch; merge reviewed source and freeze the actual
      resulting release SHA. PR build success is preliminary if the merged SHA
      differs. Build the final artifacts from the frozen SHA.
- [ ] Verify `pnpm install --frozen-lockfile` on a fresh checkout; no old paths,
      personal checkout, temporary tools or existing caches may be required.
- [ ] Run native Windows/Linux builds, fix failures, then repeat affected checks.
- [ ] Build macOS universal plug-ins and verify both Mach-O slices. Run the exact
      final AU and VST3 host checks; do not reuse old prototype validation results.
- [ ] Run mapping, persistence/recovery/concurrency, audio/codec/render checks,
      desktop regression and Android/iOS bridge/native policy checks.
- [ ] Extract both portable Xcode archives into new folders and compile without
      the original repository's node_modules/CMake build tree. Main iOS may still
      fetch its declared remote Swift dependencies.
- [ ] Verify packaged apps start, find their resources, import local audio and
      restore data after replacement; check Windows runtime and Linux dependency
      installation, not just archive creation.

### Phase 4 — physical device and DAW acceptance

- [ ] iPhone main app: search/playback, cache reuse, rapid cues/MIDI, background
      queue, close/reopen, settings/library/cue restoration and upgrade retention.
- [ ] AUv3: select instrument in a real host; test rendered audio/MIDI, preset and
      cue recall, editor reopening, editor-closed advancement and two instances.
- [ ] Mac main app/AU: install the actual packages, repeat save/reopen and
      rapid-trigger listening checks in intended DAWs; validate duplicate legacy
      plug-in installation handling and preserved IDs.
- [ ] Android: install the candidate, exercise native playback/MIDI, screen-off
      progression, portrait UI and storage recovery; test the chosen migration.
- [ ] Verify Windows/Linux hosts and target architectures where available.
- [ ] Record physical iPad/Intel/other unavailable hardware as untested; avoid
      blanket parity or latency claims. A critical failure blocks stable release.

### Phase 5 — source, project and licensing deliverables

- [ ] Publish the complete reviewed repository on GitHub, with the release tag
      resolving to the exact build SHA, so users can fork the complete project.
- [ ] Create `Beatmaker-Cues-Source-1.0.4.zip` and `.tar.gz` from that commit,
      including main desktop/web/server, Android/iOS, plug-in source, tests,
      lockfiles, assets, workflows, dependency pins, scripts and license notices.
      GitHub's automatic source downloads should resolve to the same commit.
- [ ] Provide a plug-in corresponding-source/dependency bundle, e.g.
      `Beatmaker-Cues-Plugin-Source-1.0.4.zip`, with exact JUCE/Signalsmith source,
      license texts, applied JUCE patches and build scripts matching the binaries.
      Do not substitute a binary archive or only an iOS project for full source.
- [ ] Add third-party notices and explain the MIT main-source versus JUCE
      AGPLv3/commercial distribution terms. Make corresponding-source and build
      access appropriate to the chosen JUCE license; do not label every binary
      simply MIT because the repository root has an MIT license.
- [ ] Write clean-machine build/fork instructions: Node/pnpm, JDK/SDK, CMake/C++,
      Xcode/SPM, WebView2, Linux development/runtime dependencies, FFmpeg,
      signing variables, and changing bundle IDs in a fork without claiming
      compatibility with an unrelated installed identity.
- [ ] Check downloaded source archives unpack and build in clean CI, including
      dependency fetching, UI regeneration and package creation. Pin versions
      and record toolchains; do not claim bit-for-bit reproducibility untested.

### Phase 6 — draft, verify and publish

- [ ] Tag the frozen SHA as `v1.0.4` in coordination with corrected workflow
      triggers; a tag push must not publish a partial release automatically.
- [ ] Assemble a **draft** release with all expected artifacts and source bundles.
- [ ] Generate one top-level `SHA256SUMS-1.0.4.txt`, build manifest and tested-host
      matrix from final staged files. Retain useful per-platform metadata.
- [ ] Download/verify the draft assets and GitHub digests; verify all links,
      versions, file names, licenses and signing labels.
- [ ] Publish only after all required targets pass and acceptance results are
      recorded. If acceptance remains incomplete, publish an explicitly labelled
      prerelease, not an unconditional stable release.
- [ ] Update README download tables and changelog to 1.0.4, clearly separating
      main apps, plug-ins, plug-in standalone, Xcode projects and full source.
- [ ] Preserve v1.0.2/v1.0.3 downloads and explain Android migration and Apple
      signing requirements beside the relevant download links.

## Work continued during this audit

- Compared live GitHub release inventory, main SHA and v1.0.3 tag.
- Confirmed the Android certificate mismatch using the actual published APK.
- Built the missing main-iOS 1.0.4 unsigned IPA and portable Xcode ZIP locally;
  package integrity, arm64/version/bundle checks and checksums pass. Extracted
  the Xcode ZIP into a new folder and built it independently; output is arm64
  version 1.0.4.
- Added repository ignore rules for project-local tools and device build output.
- Made local iOS provenance report uncommitted working-tree changes honestly.

Next implementation priority: settle Android signing/UI scope, correct and
connect the candidate-build/publication workflows, then build Windows/Linux and
universal Mac targets from reviewed source. Local test packages remain useful for
acceptance, but final release binaries must be rebuilt from the frozen commit.
