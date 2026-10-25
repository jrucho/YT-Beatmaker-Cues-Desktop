import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const {version} = JSON.parse(await readFile('package.json','utf8'));
const sourceCommit = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const temporary = await mkdtemp(path.join(tmpdir(),'beatmaker-release-gate-'));
const staging=path.join(temporary,'staging'),output=path.join(temporary,'final');
await mkdir(staging);
const run=()=>spawnSync(process.execPath,['scripts/assemble-release.mjs',staging,output],{encoding:'utf8'});
try {
  // Exercise rejection of incomplete/mixed/tampered runs, not native binaries.
  const missing=run();assert.notEqual(missing.status,0);
  const inventory=JSON.parse(execFileSync(process.execPath,['scripts/assemble-release.mjs','--inventory'],{encoding:'utf8'}));
  assert(inventory.length>20,'Release gate must enumerate the full required matrix');
  const unique=[...new Set(inventory)];
  for(const name of unique)await writeFile(path.join(staging,name),name.endsWith('.json')?JSON.stringify({version,sourceCommit,workingTreeDirty:false,certificateSha256:(await readFile('mobile/android/release-certificate.sha256','utf8')).trim()}):'fixture');
  assert.equal(run().status,0,'Complete consistent run should assemble');
  await rm(output,{recursive:true});
  const windows=`YT-Beatmaker-Cues-Desktop-${version}-Windows.exe`;
  await rm(path.join(staging,windows));assert.notEqual(run().status,0,'Missing Windows artifact must block assembly');await writeFile(path.join(staging,windows),'fixture');
  const metadata=`Source-Build-${version}.json`;
  await writeFile(path.join(staging,metadata),JSON.stringify({version,sourceCommit:'0'.repeat(40),workingTreeDirty:false}));
  assert.notEqual(run().status,0,'Mixed source commits must block assembly');
  await writeFile(path.join(staging,metadata),JSON.stringify({version,sourceCommit,workingTreeDirty:true}));
  assert.notEqual(run().status,0,'Dirty source must block assembly');
  await writeFile(path.join(staging,metadata),JSON.stringify({version,sourceCommit,workingTreeDirty:false}));
  const androidName=`Main-Build-Android-${version}.json`;
  const androidRecord=await readFile(path.join(staging,androidName),'utf8');
  await writeFile(path.join(staging,androidName),JSON.stringify({...JSON.parse(androidRecord),certificateSha256:'0'.repeat(64)}));
  assert.notEqual(run().status,0,'Unexpected Android release key must block assembly');await writeFile(path.join(staging,androidName),androidRecord);
  await writeFile(path.join(staging,`SHA256SUMS-Test-${version}.txt`),'0'.repeat(64)+'  '+windows+'\n');
  assert.notEqual(run().status,0,'Tampered checksum must block assembly');await rm(path.join(staging,`SHA256SUMS-Test-${version}.txt`));
  await writeFile(path.join(staging,'unrelated-old-release.zip'),'not for publication');
  assert.equal(run().status,0);
  assert(!(await readdir(output)).includes('unrelated-old-release.zip'),'Older files must not contaminate final release');
  console.log('PASS: complete matrix, missing target, mixed SHA, dirty source, tampered checksum and staging isolation gates');
} finally {await rm(temporary,{recursive:true,force:true});}
