import {existsSync} from 'node:fs';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const plugin=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const revision='29396c22c93392d6738e021b83196283d6e4d850';
const directory=path.resolve(process.argv[2]||path.join(plugin,'.android-deps/juce'));
if(existsSync(path.join(directory,'modules/juce_core/juce_core.h'))){console.log(directory);process.exit(0);}
await mkdir(directory,{recursive:true});
const archive=path.join(directory,'juce.tar.gz');
try{
  const response=await fetch(`https://github.com/juce-framework/JUCE/archive/${revision}.tar.gz`);if(!response.ok)throw Error('JUCE source download failed: '+response.status);
  await writeFile(archive,Buffer.from(await response.arrayBuffer()));execFileSync('tar',['-xzf',archive,'-C',directory,'--strip-components=1']);
  await writeFile(path.join(directory,'BEATMAKER-REVISION'),revision+'\n');console.log(directory);
}finally{await rm(archive,{force:true});}
