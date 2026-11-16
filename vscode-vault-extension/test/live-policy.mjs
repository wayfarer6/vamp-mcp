import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {VaultCli} from '../src/vault_cli.mjs';
const binary=process.env.VAULT_TEST_KEEPASSXC;
if(!binary){console.log('Live approval policy test skipped: set VAULT_TEST_KEEPASSXC.');process.exit(0);}
const root=await mkdtemp(path.join(os.tmpdir(),'vamp-policy-'));const db=path.join(root,'test.kdbx');const socket=process.platform==='win32'?`\\\\.\\pipe\\vamp-policy-${process.pid}`:path.join(root,'bridge.sock');const sockets=new Set();
const policy={mode:'each-read',revision:0,unlocked:true,allow:true,prompts:0};
const bridge=net.createServer(client=>{sockets.add(client);client.on('close',()=>sockets.delete(client));let buffer='';client.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const text=buffer.slice(0,i);buffer=buffer.slice(i+1);const request=JSON.parse(text);let result;if(request.op==='state')result={unlocked:policy.unlocked,approval_mode:policy.mode,cache_minutes:5,revision:policy.revision};else if(request.op==='approve'){policy.prompts++;result={approved:policy.allow,remember:true};}else if(request.op==='unlock')result={password:'public-policy-test',cancelled:false};else result={};client.write(JSON.stringify({id:request.id,ok:true,result})+'\n');}});});
await new Promise(resolve=>bridge.listen(socket,resolve));
let client;
try{
 const cli=new VaultCli({keepassxcCli:binary,kdbxPath:db});await cli.createDatabase({file:db,password:'public-policy-test'});await cli.addEntry({file:db,entry:'Example',username:'demo',secret:'fixture-only',databasePassword:'public-policy-test'});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve(import.meta.dirname,'../backends/vault/server.mjs')],env:{...process.env,VAULT_KEEPASSXC_CLI:binary,VAULT_KDBX:db,VAULT_BRIDGE_SOCKET:socket,VAULT_BRIDGE_TOKEN:'policy-test',VAULT_APPROVAL_MODE:'off',VAULT_AUTO_DOWNLOAD:'0'}});
 client=new Client({name:'live-policy-test',version:'1.0.0'});await client.connect(transport);
 async function read(){const response=await client.callTool({name:'vault_get_credential',arguments:{entry:'Example',fields:['username']}});return JSON.parse(response.content[0].text);}
 assert.equal((await read()).status,'ok');assert.equal(policy.prompts,1);assert.equal((await read()).cached,true);assert.equal(policy.prompts,2);
 policy.mode='off';policy.revision++;assert.equal((await read()).status,'ok');assert.equal(policy.prompts,2);
 policy.mode='each-read';policy.revision++;policy.allow=false;assert.equal((await read()).status,'denied');assert.equal(policy.prompts,3);
 policy.mode='per-session';policy.revision++;policy.allow=true;assert.equal((await read()).status,'ok');assert.equal(policy.prompts,4);policy.allow=false;assert.equal((await read()).status,'ok');assert.equal(policy.prompts,4);
 policy.unlocked=false;policy.revision++;assert.equal((await read()).status,'denied');assert.equal(policy.prompts,5);
 console.log('7 live-policy checks passed: each-read cache approval, live off/strict transitions, remembered entry/action and lock invalidation.');
}finally{await client?.close();for(const client of sockets)client.destroy();await new Promise(resolve=>bridge.close(resolve));await rm(root,{recursive:true,force:true});}
