import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';

export function sourceInfo(root) {
  if (existsSync(path.join(root,'.git'))) return {
    sourceCommit: execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
    workingTreeDirty: !!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),
  };
  const file=path.join(root,'SOURCE-INFO.json');
  if(existsSync(file))return {sourceCommit:JSON.parse(readFileSync(file,'utf8')).sourceCommit,workingTreeDirty:null,sourceArchiveBaseline:true};
  return {sourceCommit:null,workingTreeDirty:null};
}
