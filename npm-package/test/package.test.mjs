import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,rm,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tarball=process.env.VAMP_TEST_TARBALL;
const vault=process.env.VAMP_TEST_PACKAGE==='vault';
const packageName=vault?'vamp-mcp-vault':'vamp-mcp';

test('packed npm install works outside the repository', {timeout:45000}, async t=>{
  assert.ok(tarball,'Set VAMP_TEST_TARBALL to the npm pack tarball');
  const temporary=await mkdtemp(path.join(os.tmpdir(),'vamp-npm-test-'));
  t.after(()=>rm(temporary,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  const npmCli=process.env.npm_execpath;
  assert.ok(npmCli,'Run this check through npm test so npm_execpath is available');
  execFileSync(process.execPath,[npmCli,'install','--prefix',temporary,'--ignore-scripts','--no-audit','--no-fund',tarball],{stdio:'pipe'});
  const cli=path.join(temporary,'node_modules',packageName,'bin',packageName+'.mjs');
  assert.equal(execFileSync(process.execPath,[cli,'--version'],{encoding:'utf8'}).trim(),vault?'0.1.6':'0.2.6');
  assert.match(execFileSync(process.execPath,[cli,'--help'],{encoding:'utf8'}),vault?/usage:/i:/No VM/);
  if(!vault) {
    await t.test('packaged KVM creation requires confirmation and rejects an active VirtualBox VM',async()=>{
      const source=path.join(temporary,'installer.iso');await writeFile(source,'test');
      const args={name:'Blocked-Test',iso_path:source,confirmed:false};
      if(process.platform==='win32') {
        assert.throws(()=>execFileSync(process.execPath,[cli,'kvm','--call','remote_vm_create','--args',JSON.stringify(args)],{encoding:'utf8'}),error=>{
          assert.match(error.stdout,/unsupported on win32/);return true;
        });
        return;
      }
      const pending=JSON.parse(execFileSync(process.execPath,[cli,'kvm','--call','remote_vm_create','--args',JSON.stringify(args)],{encoding:'utf8'}));
      assert.equal(pending.status,'needs_confirmation');
      const fake=path.join(temporary,'busy-vbox');await writeFile(fake,'#!/bin/sh\necho busy-vm\n',{mode:0o700});
      const work=path.join(temporary,'uncreated-work');
      assert.throws(()=>execFileSync(process.execPath,[cli,'kvm','--workdir',work,'--call','remote_vm_create','--args',JSON.stringify({...args,confirmed:true})],{encoding:'utf8',env:{...process.env,VBOXMANAGE_PATH:fake}}),error=>{
        assert.match(JSON.parse(error.stdout).message,/VirtualBox VM is active/);return true;
      });
      await assert.rejects(access(work));
    });
  }
  for (const [command,expected] of (vault?[[null,'vault_status']]:[['virtualbox','vamp_setup'],['kvm','remote_vm_list'],['library','rpa_search'],['remote','remote_vm_list']])) {
    await t.test(`${command}: initialize and discover real MCP tools`,{timeout:12000},async()=>{
      const child=spawn(process.execPath,[cli,...(command?[command]:[])],{cwd:temporary,env:{...process.env,VAMP_RPA_REGISTRY:path.join(temporary,'catalog')}});
      let stdout='',stderr='';
      child.stderr.on('data',chunk=>stderr+=chunk);
      try {
        const result=await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error(`MCP timeout: ${stderr}`)),8000);
          child.on('error',error=>{clearTimeout(timer);reject(error);});
          child.on('exit',code=>{clearTimeout(timer);reject(Error(`Early exit ${code}: ${stderr}`));});
          child.stdout.on('data',chunk=>{
            stdout+=chunk;
            while (stdout.includes('\n')) {
              const index=stdout.indexOf('\n');const line=stdout.slice(0,index);stdout=stdout.slice(index+1);
              try {
                const message=JSON.parse(line);
                if (message.id===1) {
                  assert.ok(message.result?.serverInfo,JSON.stringify(message));
                  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
                  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})+'\n');
                } else if (message.id===2) {clearTimeout(timer);resolve(message);}
              } catch (error) {clearTimeout(timer);reject(error);}
            }
          });
          child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'vamp-package-test',version:'1.0.0'}}})+'\n');
        });
        assert.ok(result.result?.tools.some(tool=>tool.name===expected),JSON.stringify(result));
        if(command==='virtualbox')for(const name of ['vm_packer_prepare','vm_golden_images','vm_golden_image_delete'])assert.ok(result.result.tools.some(tool=>tool.name===name),name);
        if(command==='kvm'||command==='remote')for(const name of ['remote_packer_prepare','remote_golden_images','remote_golden_image_delete'])assert.ok(result.result.tools.some(tool=>tool.name===name),name);
        if(command==='kvm'||command==='remote')assert.ok(result.result.tools.some(tool=>tool.name==='remote_vm_create'));
      } finally {child.kill();}
    });
  }
});
