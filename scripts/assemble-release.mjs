import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const staging = path.resolve(process.argv[2] || 'release-staging');
const output = path.resolve(process.argv[3] || 'release-final');
const {version} = JSON.parse(readFileSync('package.json', 'utf8'));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
const sha = name => createHash('sha256').update(readFileSync(path.join(staging, name))).digest('hex');
const expected = [
  ...['arm64', 'x64'].map(arch => `YT-Beatmaker-Cues-Desktop-${version}-macOS-${arch}.dmg`),
  `YT-Beatmaker-Cues-Desktop-${version}-Windows.exe`,
  ...['x64', 'arm64'].flatMap(arch => ['AppImage', 'deb'].map(ext => `YT-Beatmaker-Cues-Desktop-${version}-Linux-${arch}.${ext}`)),
  `Beatmaker-Cues-Test-${version}-Android.apk`, `Beatmaker-Cues-Setup-${version}-Android.apk`, `Beatmaker-Cues-${version}-Android.aab`,
  `Beatmaker-Cues-Test-${version}-iOS.ipa`, `Beatmaker-Cues-Xcode-${version}.zip`,
  ...[['macOS', 'universal'], ['Windows', 'x64'], ['Linux', 'x64']].flatMap(([platform, arch]) => [
    `Beatmaker-Cues-Plug-ins-${version}-${platform}-${arch}.zip`, `Beatmaker-Cues-Plugin-Standalone-${version}-${platform}-${arch}.zip`,
    `Plugin-Build-${version}-${platform}-${arch}.json`,
  ]),
  ...[['macOS', 'universal'], ['Windows', 'x64'], ['Linux', 'x64']].flatMap(([platform, arch]) => [
    `Beatmaker-Cues-Desktop-Beta-Plug-ins-${version}-${platform}-${arch}.zip`,
    `Beatmaker-Cues-Desktop-Beta-Standalone-${version}-${platform}-${arch}.zip`,
    `Desktop-Beta-Build-${version}-${platform}-${arch}.json`,
  ]),
  `Beatmaker-Cues-Desktop-Beta-Plug-ins-${version}-Linux-x64.deb`,
  `Beatmaker-Cues-Plug-ins-${version}-Linux-x64.deb`,
  `Beatmaker-Cues-AUv3-${version}-iOS-unsigned.ipa`, `Beatmaker-Cues-Plugin-Xcode-${version}.zip`,
  `Beatmaker-Cues-Source-${version}.zip`, `Beatmaker-Cues-Source-${version}.tar.gz`, `Beatmaker-Cues-Plugin-Source-${version}.zip`,
  `Source-Build-${version}.json`, `iOS-Build-${version}.json`, `AUv3-Build-${version}.json`,
  ...['macOS', 'Windows', 'Linux', 'Android'].map(platform => `Main-Build-${platform}-${version}.json`),
];
if (process.argv[2] === '--inventory') {
  console.log(JSON.stringify(expected, null, 2));
  process.exit(0);
}
const available = new Set(readdirSync(staging));
assert.deepEqual(expected.filter(name => !available.has(name)), [], 'Incomplete release: required assets are missing');
const records = expected.filter(name => name.endsWith('.json'));
for (const name of records) {
  const data = JSON.parse(readFileSync(path.join(staging, name), 'utf8'));
  assert.equal(data.version, version, `${name}: version mismatch`);
  assert.equal(data.sourceCommit, sourceCommit, `${name}: source SHA mismatch`);
  assert.equal(data.workingTreeDirty, false, `${name}: not a clean-source build`);
  for (const [file, record] of Object.entries(data.files || {})) {
    assert.equal(path.basename(file), file, 'Unsafe file name');
    assert.equal(sha(file), record.sha256, `${file}: checksum mismatch`);
  }
}
const android = JSON.parse(readFileSync(path.join(staging, `Main-Build-Android-${version}.json`), 'utf8'));
assert.equal(android.certificateSha256, readFileSync('mobile/android/release-certificate.sha256', 'utf8').trim(), 'Unexpected Android signing key');
for (const name of available) {
  if (!name.startsWith('SHA256SUMS-') || !name.includes(version)) continue;
  for (const line of readFileSync(path.join(staging, name), 'utf8').trim().split('\n')) {
    const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line);
    assert(match, `${name}: malformed checksum entry`);
    assert.equal(sha(match[2]), match[1], `${match[2]}: checksum mismatch`);
  }
}
mkdirSync(output); // An existing release staging directory must not be overwritten.
for (const name of expected) copyFileSync(path.join(staging, name), path.join(output, name));
const manifest = {version, sourceCommit, files: expected.map(name => ({name, sha256: sha(name)})), status: 'candidate; physical acceptance and final publication are separate'};
const manifestName = `Release-Build-${version}.json`;
writeFileSync(path.join(output, manifestName), JSON.stringify(manifest, null, 2) + '\n');
const all = [...manifest.files, {name: manifestName, sha256: createHash('sha256').update(readFileSync(path.join(output, manifestName))).digest('hex')}];
writeFileSync(path.join(output, `SHA256SUMS-${version}.txt`), all.map(file => `${file.sha256}  ${file.name}\n`).join(''));
console.log(`Verified ${expected.length} required assets from ${sourceCommit}; staged in ${output}`);
