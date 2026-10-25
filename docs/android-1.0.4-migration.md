# Android 1.0.3 → 1.0.4 signing migration

1.0.4 uses a persistent release key for future updates. The published 1.0.3 APK
used a different development key, so Android cannot replace that installation
with a new-key build while keeping its private data automatically.

**Keep the old app installed until backups have been captured and checked.**

## What to preserve

- Settings → library backup → Export saves playlists, favorites, history and
  selected preferences. Copy the JSON outside the app and verify its contents.
- The 1.0.3 library export does **not** include separately stored mobile cue
  banks, current queue/session or every MIDI setting. Do not assume a library
  export protects them. Cached audio is also not a portable backup.
- If you use cue banks, capture the old WebView's local-storage data before
  uninstalling. For the development APK, Android USB debugging and Chrome's
  `chrome://inspect/#devices` can expose the running Beatmaker WebView. In its
  console, export `JSON.stringify(Object.fromEntries(Object.entries(localStorage)))`
  to a file. Keep it private: it can contain library/session information.
- In the inspected WebView console, `copy(JSON.stringify(Object.fromEntries(Object.entries(localStorage))))`
  copies the capture to the desktop clipboard. Save it as a private JSON file.
- Combine the old library export and captured state with Node.js 24:

  ```sh
  node mobile/scripts/combine-migration-backup.mjs old-library.json captured-state.json combined-backup.json
  ```

  The helper requires valid mobile cue data, filters supported keys, preserves
  the library and refuses to overwrite an existing output file. Import the
  resulting combined backup using 1.0.4's normal Settings backup importer.
- 1.0.4 backup exports now include supported cue/MIDI data too. Library-only
  1.0.3 backups remain accepted. Physical-device migration verification remains
  required before declaring this a fully tested migration route.

## Installation sequence

1. Export and inspect the library JSON; capture/verify cue state if applicable.
2. Keep independent copies of those files outside app storage.
3. Test migration on a spare device/profile first where available.
4. Only after the necessary data is safely captured, uninstall the old-key app
   and install the stable-key `Beatmaker-Cues-Setup-1.0.4-Android.apk`.
5. Import the library in Settings, restore supported cue state, and verify songs,
   banks, MIDI preset and settings before considering migration complete.

Neither an old APK nor its public certificate can recover its private signing
key. Future stable-key builds must use the same backed-up private key. The test
APK is development-key signed and is separate from this stable-key update chain.

## Maintainers

Create the key outside the checkout using `mobile/scripts/create-release-key.mjs`.
Run builds with `mobile/scripts/with-release-key.mjs /private/signing.json ...`.
Its `--github-secrets /path/to/gh owner/repository` mode configures the MUSIKE signing secret names in the explicitly selected repository;
key material is sent over stdin and is not printed. Back up the private key and
password config securely; never include them in Git, source ZIPs or release assets.
