// Run a build command or configure GitHub Actions secrets without exposing key material.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

const [configuration, command, ...args] = process.argv.slice(2);
assert(configuration && command, 'Usage: node mobile/scripts/with-release-key.mjs /private/signing.json <command> [args] | --github-secrets [gh-path]');
const config = JSON.parse(readFileSync(configuration, 'utf8'));
assert(config.storeFile && config.storePassword && config.keyAlias && config.keyPassword, 'Incomplete signing config');
if (command === '--github-secrets') {
  const gh = args[0] || 'gh';
  const repository = args[1] || process.env.GITHUB_REPOSITORY;
  assert(repository && /^[\w.-]+\/[\w.-]+$/.test(repository), 'Supply the destination owner/repo after the gh executable path');
  for (const [name, value] of Object.entries({MUSIKE_KEYSTORE_BASE64: readFileSync(config.storeFile).toString('base64'), MUSIKE_KEYSTORE_PASSWORD: config.storePassword, MUSIKE_KEY_ALIAS: config.keyAlias, MUSIKE_KEY_PASSWORD: config.keyPassword})) {
    const result = spawnSync(gh, ['secret', 'set', name, '--repo', repository], {input: value, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']});
    assert.equal(result.status, 0, `Could not configure ${name}: ${result.stderr}`);
    console.log(`Configured encrypted GitHub Actions secret: ${name}`);
  }
} else {
  const result = spawnSync(command, args, {stdio: 'inherit', env: {...process.env, MUSIKE_KEYSTORE: config.storeFile, MUSIKE_KEYSTORE_PASSWORD: config.storePassword, MUSIKE_KEY_ALIAS: config.keyAlias, MUSIKE_KEY_PASSWORD: config.keyPassword}});
  process.exit(result.status ?? 1);
}
