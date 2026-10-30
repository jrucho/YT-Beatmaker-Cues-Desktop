# Build, modify or fork Beatmaker Cues 1.0.4

Use the complete Git repository/tag or `Beatmaker-Cues-Source-1.0.4.zip`/`.tar.gz`.
Main app, web/server, Android/iOS and native plug-in projects are in the same
source tree. Source downloads and release binaries must identify the same commit.
Read `THIRD_PARTY_NOTICES.md`, particularly the JUCE-based binary license terms.
Archives include `SOURCE-INFO.json` so packaging can identify their source
baseline without a `.git` directory. Without Git, local modifications cannot be
reliably detected and packaging records that status as unknown, not clean.

## Shared setup

Install Node.js 24, enable Corepack and use pnpm 10.14.0. At the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

Run `pnpm desktop` to build/start the main desktop app. The desktop workspace
includes the studio; native mobile builds use the responsive phone interface.
Desktop builds also require CMake 3.24+ and a C++17 compiler for the portable
shared-library lock helper. Set `CMAKE_COMMAND` if CMake is outside PATH.

## Main desktop installers

Build on each platform using its native compiler/tools as required by Electron:
Linux x64-to-arm64 packaging additionally needs `g++-aarch64-linux-gnu`.

```sh
pnpm installer:mac     # macOS arm64 and x64 DMGs
pnpm installer:win     # Windows x64 NSIS installer, on Windows
pnpm installer:linux   # Linux x64/arm64 AppImage and Debian packages, on Linux
```

Packages are copied into `release/`. Local Mac builds are ad-hoc signed and not
notarized. Fork maintainers can configure their own distribution credentials.

## Android (native app)

Install JDK 21 and Android command-line tools. Set `JAVA_HOME` and `ANDROID_HOME`.
Install `platform-tools`, `platforms;android-36`, `build-tools;36.0.0`,
`ndk;28.1.13356709` and `cmake;3.31.6` using
`sdkmanager`; Gradle may also install its required build-tools version.

```sh
python3 plugin/Scripts/build_mobile_ui.py .
sh mobile/android/gradlew -p mobile/android :pluginStandalone:assembleDebug -PbeatmakerStandaloneOnly=true --console=plain
```

The test APK is at `plugin/Android/app/build/outputs/apk/debug/pluginStandalone-debug.apk`.
On Windows use `mobile\android\gradlew.bat -p mobile\android ...` instead of
`sh mobile/android/gradlew ...`; when using the signing wrapper, invoke it as
`cmd /c mobile\android\gradlew.bat ...`.
For persistent release signing, create your own key **outside the checkout**:

```sh
node mobile/scripts/create-release-key.mjs /existing/private-parent/android-signing
node mobile/scripts/with-release-key.mjs /existing/private-parent/android-signing/signing.json \
  sh mobile/android/gradlew -p mobile/android :pluginStandalone:assembleRelease -PbeatmakerStandaloneOnly=true --console=plain
```

Build web/native assets before release Gradle tasks as well. Never commit private
keys/configs. A fork cannot update someone else's installed Android app without
its original signing key. See `android-1.0.4-migration.md` for the old debug-key
migration and cue-data limitations.

## Native iOS and AUv3

Use the portable native Xcode export from [v1.0.4 downloads](downloads-1.0.4.md),
or generate the project from the complete checkout:

```sh
python3 plugin/Scripts/build_mobile_ui.py .
cmake -S plugin -B plugin/build-ios -G Xcode -DCMAKE_SYSTEM_NAME=iOS \
  -DCMAKE_OSX_SYSROOT=iphoneos -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0 \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED=NO
xcodebuild -project plugin/build-ios/BeatmakerCuesPrototype.xcodeproj \
  -scheme BeatmakerCues_Standalone -configuration Release \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
python3 plugin/Scripts/package_ios.py --build-dir plugin/build-ios
python3 plugin/Scripts/export_xcode.py --build-dir plugin/build-ios
```

For installation select your own signing team for the standalone and AUv3 targets.

## Historical Capacitor iOS project

Use a full Xcode 26+ supporting Capacitor 8. Select it with `DEVELOPER_DIR` if
the system default points at Command Line Tools.

```sh
pnpm --filter @musike/mobile build:ios
open mobile/ios/App/App.xcodeproj
```

Select the App scheme, your development team and a suitable bundle identifier.
`pnpm --filter @musike/mobile ipa` builds an unsigned archive/IPA.
`node mobile/scripts/export-xcode.mjs` exports a portable project with built web
assets and local Swift plug-in sources. The exported project needs Xcode/SPM and
internet for declared remote Swift dependencies; Node is not needed just to
compile the export. Signing and profile renewal use your own Apple account.
Optional App Group sharing is documented in [shared libraries](shared-libraries.md).
It is disabled by default and needs appropriately entitled provisioning profiles.

## Native AU/VST3/AUv3 and plug-in standalone

Install CMake 3.24+, a C++17 compiler and the platform development dependencies in
`.github/workflows/plugins.yml`. Windows needs the WebView2 SDK/runtime. Linux
needs ALSA/X11/GTK3/WebKitGTK 4.1/CURL/FreeType/Fontconfig plus FFmpeg. macOS/iOS
use their native platform media readers. See `plugin/README.md` for audio limits.

```sh
python3 plugin/Scripts/build_mobile_ui.py .
cmake -S plugin -B plugin/build-release -DCMAKE_BUILD_TYPE=Release
cmake --build plugin/build-release --config Release --parallel 3
ctest --test-dir plugin/build-release -C Release --output-on-failure
```

On macOS add `'-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64'` for universal binaries.
On Windows use a Visual Studio generator and configure
`JUCE_WEBVIEW2_PACKAGE_LOCATION` to the downloaded NuGet SDK package location.
Use `xvfb-run -a ctest ...` for Linux GUI-dependent tests on headless CI.

Dependencies normally download from pinned commits. The corresponding-source
ZIP also supplies exact dependency trees under `Frameworks/`; to use those copies:

```sh
cmake -S plugin -B plugin/build-source -DCMAKE_BUILD_TYPE=Release \
  -DFETCHCONTENT_SOURCE_DIR_JUCE="$PWD/Frameworks/JUCE" \
  -DFETCHCONTENT_SOURCE_DIR_SIGNALSMITHSTRETCH="$PWD/Frameworks/SignalsmithStretch" \
  -DFETCHCONTENT_SOURCE_DIR_SIGNALSMITHLINEAR="$PWD/Frameworks/SignalsmithLinear"
```

For AUv3 configure `-G Xcode -DCMAKE_SYSTEM_NAME=iOS
-DCMAKE_OSX_SYSROOT=iphoneos -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0
-DCMAKE_OSX_ARCHITECTURES=arm64`; build the `BeatmakerCues_Standalone` scheme.
The source includes the extension-safety patch script applied to JUCE during
configuration. The portable plug-in Xcode ZIP contains those patched dependency
sources and generated inputs; choose your own team for both targets.

## Forks and release automation

- Change your fork's branding and identifiers deliberately. Keep original IDs
  only when intentionally maintaining the same product/update chain.
- The normal plug-in has legacy IDs for DAW compatibility. The desktop-UI beta
  must have distinct IDs and packages so it can coexist with the normal editor.
- Run `Complete release candidate` to build all required targets at one SHA.
  It requires persistent Android signing secrets for coordinated candidates.
- Source exports require a clean committed tree. A clean extracted-source build
  runs in CI. Native platform CI is still required; a Mac build is not a Windows
  or Linux runtime test.
- Candidate jobs upload artifacts. Draft creation is a separate manual input;
  final public publication follows recorded device/DAW acceptance.
- The full development matrix runs manually or on `candidate/**` branches.
  `Windows native and desktop builds` produces both Windows standalone editions
  and VST3 artifacts from the selected source ref.
- The public v1.0.4 inventory is Mac/Windows/Android/iOS. After clean source export
  and platform builds, `scripts/prepare-public-release.py` verifies the exact
  source SHA, archives, native standalone binaries and checksums before staging
  GitHub assets. It does not publish or include personal iOS provisioning.
