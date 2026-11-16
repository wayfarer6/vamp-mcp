#!/usr/bin/env node
// Keep the existing server's approval and credential policy unchanged.
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {readFileSync} from 'node:fs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.argv.includes('--version'))console.log(JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version);
else {
 const server=path.join(root,'runtime/backends/vault/server.mjs');
 process.argv=[process.argv[0],server,...process.argv.slice(2)];
 await import(pathToFileURL(server).href);
}
