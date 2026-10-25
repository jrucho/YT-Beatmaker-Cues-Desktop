import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';

const directory = path.resolve(process.argv[2] || 'release-final');
const {version} = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(directory, `Release-Build-${version}.json`), 'utf8'));
const sha = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
assert.equal(manifest.sourceCommit, sha);
const checksums = readFileSync(path.join(directory, `SHA256SUMS-${version}.txt`), 'utf8').trim().split('\n').map(line => {
  const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line);
  assert(match, 'Invalid checksum entry');
  const [, digest, name] = match;
  assert.equal(createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex'), digest);
  return {name, digest};
});
const allowed = [...checksums.map(file => file.name), `SHA256SUMS-${version}.txt`];
assert.deepEqual(readdirSync(directory).sort(), [...allowed].sort(), 'Unexpected draft files');
const tag = `v${version}`;
const repo = process.env.GITHUB_REPOSITORY || 'jrucho/YT-Beatmaker-Cues-Desktop';
const gh = args => execFileSync('gh', [...args, '--repo', repo], {encoding: 'utf8'});
const reference = spawnSync('gh', ['api', `repos/${repo}/git/ref/tags/${tag}`], {encoding: 'utf8'});
if (reference.status === 0) {
  let object = JSON.parse(reference.stdout).object;
  while (object.type === 'tag') object = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/git/tags/${object.sha}`], {encoding: 'utf8'})).object;
  assert.equal(object.type, 'commit');
  assert.equal(object.sha, sha, 'Existing release tag points at a different source commit');
} else assert.match(reference.stderr, /HTTP 404/, 'Could not verify existing tag');
// No --clobber: an existing release/tag is deliberately not modified by this operation.
gh(['release', 'create', tag, '--target', sha, '--draft', '--title', tag, '--notes-file', 'docs/release-1.0.4-notes.md']);
gh(['release', 'upload', tag, ...allowed.map(name => path.join(directory, name))]);
const result = JSON.parse(gh(['release', 'view', tag, '--json', 'isDraft,assets,url']));
assert.equal(result.isDraft, true);
for (const file of checksums) assert.equal(result.assets.find(asset => asset.name === file.name)?.digest, `sha256:${file.digest}`);
console.log(`Verified draft only: ${result.url}`);
