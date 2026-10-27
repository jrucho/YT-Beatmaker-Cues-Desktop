import {spawnSync} from 'node:child_process';
import {mkdir,copyFile,chmod} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function buildNative(arch=process.arch){
  const build=path.join(root,'.native-build',`${process.platform}-${arch}`),output=path.join(root,'native-bin',arch);
  const args=['-S',path.join(root,'native'),'-B',build,'-DCMAKE_BUILD_TYPE=Release'];
  if(process.platform==='darwin')args.push(`-DCMAKE_OSX_ARCHITECTURES=${arch==='x64'?'x86_64':arch}`,'-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0');
  if(process.platform==='win32')args.push('-A',arch==='arm64'?'ARM64':'x64');
  if(process.platform==='linux'&&arch!==process.arch){
    if(arch!=='arm64'||process.arch!=='x64')throw new Error(`Unsupported native helper cross-build: ${process.arch} -> ${arch}`);
    args.push('-DCMAKE_SYSTEM_NAME=Linux','-DCMAKE_SYSTEM_PROCESSOR=aarch64','-DCMAKE_CXX_COMPILER=aarch64-linux-gnu-g++');
  }
  const cmake=process.env.CMAKE_COMMAND||'cmake';
  for(const command of [args,['--build',build,'--config','Release']]){
    const result=spawnSync(cmake,command,{stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)throw new Error('Native library-lock helper build failed');
  }
  await mkdir(output,{recursive:true});const name='beatmaker-library-lock'+(process.platform==='win32'?'.exe':'');
  const binary=path.join(output,name);await copyFile(path.join(build,...(process.platform==='win32'?['Release']:[]),name),binary);await chmod(binary,0o755);return binary;
}
export default async function beforePack(context){await buildNative(({0:'ia32',1:'x64',3:'arm64'})[context.arch]||process.arch);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildNative(process.argv[2]||process.arch);
