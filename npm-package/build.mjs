// Reuse the VSIX's shared runtime and dependency-license bundle; no UI ships here.
import {execFileSync} from 'node:child_process';
import {cp, rm, copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.dirname(here);
execFileSync(process.execPath,[path.join(root,'vscode-extension/build.mjs')],{cwd:root,stdio:'inherit'});
for (const name of ['runtime','notices']) {
  await rm(path.join(here,name),{recursive:true,force:true});
  await cp(path.join(root,'vscode-extension/dist',name),path.join(here,name),{recursive:true});
}
for (const name of ['LICENSE','THIRD_PARTY_NOTICES.md','requirements-mcp.txt']) {
  await copyFile(path.join(root,name),path.join(here,name==='requirements-mcp.txt'?'runtime/requirements-mcp.txt':name));
}
