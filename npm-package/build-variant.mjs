import {execFileSync} from 'node:child_process';
import {cp,rm,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const kind=process.argv[2];
if(kind!=='vault')throw Error('Expected vault');
const source='vscode-vault-extension';
execFileSync(process.execPath,[path.join(root,source,'build.mjs')],{cwd:root,stdio:'inherit'});
const destination=path.join(root,'npm-packages',kind);
for(const name of ['runtime','notices']) {
 await rm(path.join(destination,name),{recursive:true,force:true});
 await cp(path.join(root,source,'dist',name),path.join(destination,name),{recursive:true});
}
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md'])await copyFile(path.join(root,source,name),path.join(destination,name));

