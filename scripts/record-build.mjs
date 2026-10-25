import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const platform = process.argv[2];
assert(['macOS', 'Windows', 'Linux', 'Android'].includes(platform));
const {version} = JSON.parse(readFileSync('package.json', 'utf8'));
const prefix = platform === 'Android' ? `Beatmaker-Cues-` : `YT-Beatmaker-Cues-Desktop-${version}-`;
const files = readdirSync('release').filter(name => name.startsWith(prefix) && name.includes(version) && name.includes(platform) && /\.(dmg|exe|AppImage|deb|apk|aab)$/.test(name));
assert(files.length, 'No packaged files to record');
const metadata = {
  version, platform,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}).trim(),
  runURL: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  checks: (process.env.RELEASE_CHECKS || '').split(',').filter(Boolean),
  signing: platform === 'macOS' ? 'ad-hoc; not notarized' : platform === 'Android' ? 'see certificate fingerprint; test APK uses a separate development key' : 'unsigned',
  files: Object.fromEntries(files.map(name => [name, {sha256: createHash('sha256').update(readFileSync(path.join('release', name))).digest('hex')}])),
};
if (platform === 'Android') {
  const setup = files.find(name => name === `Beatmaker-Cues-Setup-${version}-Android.apk`);
  if (setup) {
    const text = execFileSync(path.join(process.env.ANDROID_HOME, 'build-tools/36.0.0/apksigner'), ['verify', '--print-certs', path.join('release', setup)], {encoding: 'utf8'});
    metadata.certificateSha256 = /certificate SHA-256 digest: ([0-9a-f]{64})/.exec(text)?.[1];
    assert(metadata.certificateSha256, 'Missing release certificate fingerprint');
  }
}
writeFileSync(`release/Main-Build-${platform}-${version}.json`, JSON.stringify(metadata, null, 2) + '\n');
