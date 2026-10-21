# Local Android build backups

APK backups are kept in `release/backups/`, in dated folders with a checksum suffix. They stay on this computer and are ignored by Git.

Each folder contains:

- The APK and its optional `.idsig` file.
- `SHA256SUMS.txt` and `build.json` with the build notes.
- For new builds, `changes.patch` and (when needed) `untracked-sources.tar.gz`, plus the base Git commit in `build.json`.

`pnpm --filter @musike/mobile apk` automatically preserves the previous output before replacing it and archives the new build with its source changes. Manually signed test APKs can be archived with:

```sh
node mobile/scripts/archive-apk.mjs release/Beatmaker-Cues-Test-1.0.2-Android.apk "Description of this build" --snapshot-source
```

Only use `--snapshot-source` immediately after building from the current source. For an older APK whose source is no longer present, omit that flag.

## Reinstall an older build

Choose the dated folder and install its APK:

```sh
adb install -r "release/backups/<dated-folder>/<build-name>.apk"
```

These test builds share the same application ID and version code. With the same signing key, installing an earlier test build replaces the app while retaining its stored data. APK archives do not snapshot the phone's library or cue data; use the app's library export for that.

## Restore archived source

Use a separate checkout at `sourceBaseCommit`, apply `changes.patch` with `git apply`, and extract `untracked-sources.tar.gz` there if present. This reconstructs the build's local source without overwriting the active workspace.

## Available history

- Previous native-audio test APK: checksum starts with `829d629a`; preserved before the cue/tuning corrections. It has the reported cue-seeking regression.
- Corrected cue/tuning build: see its dated archive and notes in `build.json`.
- Splash/APK-preview correction: a subsequent build uses a dedicated padded splash and flat APK-preview icon, preserving the adaptive home-screen icon.

The earlier 3.8 MB APK (checksum starting `2a98c3b8`) had already been overwritten before backups were introduced, so it cannot be restored byte-for-byte from these archives.
