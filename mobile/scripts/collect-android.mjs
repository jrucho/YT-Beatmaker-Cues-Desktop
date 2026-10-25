import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {archiveApk} from './archive-apk.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {version}=JSON.parse(readFileSync(path.join(root,'mobile/package.json'),'utf8'));
const [major,minor,patch]=version.split('.').map(Number),build=major*10000+minor*100+patch;
const sdk=process.env.ANDROID_HOME;assert(sdk,'ANDROID_HOME is required');
const tools=path.join(sdk,'build-tools/36.0.0'),release=path.join(root,'release');mkdirSync(release,{recursive:true});
const files=[];
for(const variant of ['debug','release']){
  const apk=path.join(root,`mobile/android/app/build/outputs/apk/${variant}/app-${variant}.apk`);
  if(!existsSync(apk)){assert(variant==='release','Missing test APK');continue;}
  const metadata=execFileSync(path.join(tools,'aapt'),['dump','badging',apk],{encoding:'utf8'});
  assert(metadata.includes(`name='app.musike.android' versionCode='${build}' versionName='${version}'`),'APK identity/version mismatch');
  const signature=execFileSync(path.join(tools,'apksigner'),['verify','--print-certs',apk],{encoding:'utf8'});
  if(variant==='release')assert.equal(/certificate SHA-256 digest: ([0-9a-f]{64})/.exec(signature)?.[1],readFileSync(path.join(root,'mobile/android/release-certificate.sha256'),'utf8').trim(),'Wrong persistent release key');
  const name=`Beatmaker-Cues-${variant==='debug'?'Test':'Setup'}-${version}-Android.apk`,target=path.join(release,name);
  if(existsSync(target))archiveApk(target,'Previous APK preserved before verified replacement');
  copyFileSync(apk,target);files.push(name);
}
const aab=path.join(root,'mobile/android/app/build/outputs/bundle/release/app-release.aab');
if(existsSync(aab)){
  const signer=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin/jarsigner'):'jarsigner';
  const result=execFileSync(signer,['-verify',aab],{encoding:'utf8',maxBuffer:4*1024*1024});
  assert(result.includes('jar verified.'),'AAB signature did not verify');
  const name=`Beatmaker-Cues-${version}-Android.aab`;copyFileSync(aab,path.join(release,name));files.push(name);
}
writeFileSync(path.join(release,`SHA256SUMS-Android-${version}.txt`),files.map(name=>createHash('sha256').update(readFileSync(path.join(release,name))).digest('hex')+'  '+name+'\n').join(''));
console.log('Verified and collected:\n'+files.join('\n'));
