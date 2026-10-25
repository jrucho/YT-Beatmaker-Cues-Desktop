import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {cleanBackupState} from '../../web/src/lib/backupState.ts';

const [libraryPath, statePath, output] = process.argv.slice(2);
assert(libraryPath && statePath && output, 'Usage: node mobile/scripts/combine-migration-backup.mjs old-library.json captured-local-storage.json combined-backup.json');
const library = JSON.parse(readFileSync(libraryPath, 'utf8'));
assert.equal(library.format, 'musike-backup');
assert.equal(library.version, 1);
assert(library.library && Array.isArray(library.library.playlists) && Array.isArray(library.library.favorites), 'Invalid library backup');
const localState = cleanBackupState(JSON.parse(readFileSync(statePath, 'utf8')));
assert(localState['musike:cues:v1'], 'Captured state has no mobile cue-bank data; check the selected WebView');
writeFileSync(output, JSON.stringify({...library, localState}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
console.log(`Created combined migration backup: ${output}. Library and cue data are included; verify it before uninstalling the old app.`);
