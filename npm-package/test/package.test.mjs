import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFile,execFileSync} from 'node:child_process';
import {mkdtemp,rm,writeFile,access,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
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
  const cache=path.join(temporary,'cache');
  const env={...process.env,VAMP_ASSETS_DIR:cache,VAMP_RPA_REGISTRY:path.join(temporary,'catalog')};
  const sourceManifest=JSON.parse(await readFile(vault
    ? path.resolve(root,'../npm-packages/vault/package.json') : path.join(root,'package.json'),'utf8'));
  assert.equal(execFileSync(process.execPath,[cli,'--version'],{encoding:'utf8'}).trim(),sourceManifest.version);
  assert.match(execFileSync(process.execPath,[cli,'--help'],{encoding:'utf8'}),vault?/usage:/i:/No VM/);
  if(!vault) {
    await t.test('packaged proxy requires an explicit Linux KVM host', () => {
      const runProxy = args => spawnSync(process.execPath, [cli, 'proxy', ...args], { encoding: 'utf8' });
      const missing = runProxy([]);
      assert.equal(missing.status, 1);
      assert.equal(missing.stdout, '');
      assert.match(missing.stderr, /Remote host is not configured/);
      const unsupported = runProxy(['--host', 'lab.example', '--backend', 'virtualbox']);
      assert.equal(unsupported.status, 1);
      assert.equal(unsupported.stdout, '');
      assert.match(unsupported.stderr, /requires a Linux KVM host/);
    });
    await t.test('packaged KVM creation requires confirmation and rejects an active VirtualBox VM',async scenario=>{
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
      const conflictEnv={...env,VBOXMANAGE_PATH:fake,VAMP_ASSETS_DIR:path.join(temporary,'kvm-conflict-cache')};
      const manifest=path.resolve(path.dirname(cli),'../runtime/provisioning-assets.json');
      if(await access(manifest).then(()=>true,()=>false)) {
        const output=process.env.VAMP_TEST_ASSETS_OUTPUT;
        if(!output) {
          scenario.skip('Set VAMP_TEST_ASSETS_OUTPUT to exercise the conflict check with the offline Packer runner.');
          return;
        }
        const [,name]=(await readFile(path.join(output,'SHA256SUMS'),'utf8')).trim().split(/\s+/);
        execFileSync(process.execPath,[cli,'assets','install',path.join(output,name)],{stdio:'pipe',env:conflictEnv});
      }
      assert.throws(()=>execFileSync(process.execPath,[cli,'kvm','--workdir',work,'--call','remote_vm_create','--args',JSON.stringify({...args,confirmed:true})],{encoding:'utf8',env:conflictEnv}),error=>{
        assert.match(JSON.parse(error.stdout).message,/VirtualBox VM is active/);return true;
      });
      await assert.rejects(access(work));
    });
  }
  for (const [command,expected] of (vault?[[null,'vault_status']]:[['unified','podman_view_container_screen'],['virtualbox','vamp_setup'],['kvm','remote_vm_list'],['library','rpa_search'],['remote','remote_vm_list']])) {
    await t.test(`${command}: initialize and discover real MCP tools`,{timeout:12000},async()=>{
      const child=spawn(process.execPath,[cli,...(command?[command]:[])],{cwd:temporary,env});
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
        if(command==='unified')for(const name of ['vault_attach_container','podman_workspace_unlock','podman_workspace_lock','rpa_run_saved'])assert.ok(result.result.tools.some(tool=>tool.name===name),name);
        if(vault)for(const name of ['vault_rename_group','vault_check_placeholders','vault_attach_container','vault_attach_vm'])assert.ok(result.result.tools.some(tool=>tool.name===name),name);
        if(command==='virtualbox')for(const name of ['vm_packer_prepare','vm_golden_images','vm_golden_image_delete'])assert.ok(result.result.tools.some(tool=>tool.name===name),name);
        if(command==='kvm'||command==='remote')for(const name of ['remote_packer_prepare','remote_golden_images','remote_golden_image_delete'])assert.ok(result.result.tools.some(tool=>tool.name===name),name);
        if(command==='kvm'||command==='remote')assert.ok(result.result.tools.some(tool=>tool.name==='remote_vm_create'));
      } finally {child.kill();}
    });
  }
  await assert.rejects(access(cache),{code:'ENOENT'});
  if (!vault && process.env.VAMP_TEST_ASSETS_OUTPUT) {
    await t.test('split package pins and installs the offline archive',async()=>{
      const output=process.env.VAMP_TEST_ASSETS_OUTPUT;
      const [digest,archiveName]=(await readFile(path.join(output,'SHA256SUMS'),'utf8')).trim().split(/\s+/);
      const runtime=path.resolve(path.dirname(cli),'../runtime');
      const manifest=JSON.parse(await readFile(path.join(runtime,'provisioning-assets.json'),'utf8'));
      const packaged=JSON.parse(await readFile(path.join(runtime,'../package.json'),'utf8'));
      assert.equal(manifest.version,packaged.version);
      assert.equal(archiveName,`vamp-assets-v${manifest.version}.tar.gz`);
      assert.equal(manifest.sha256,digest);
      for (const relative of ['guest_setup','third_party/pyautogui-recorder','scripts/script_server.py','scripts/build_recorder_media.py','backends/virtualbox/provision.py','backends/packer','backends/vagrant/podman_handoff.py']) {
        await assert.rejects(access(path.join(runtime,relative)),{code:'ENOENT'});
      }
      const inventory = await readdir(runtime, { recursive: true, withFileTypes: true });
      assert.deepEqual(inventory.filter(item => item.isFile() && !/\.(?:mjs|cjs|js|json)$/i.test(item.name)), []);
      for (const name of ['replay.py','registry.py']) {
        await assert.rejects(access(path.join(runtime,'backends/library',name)),{code:'ENOENT'});
      }
      for (const name of ['display.py','history.py','mouse_click.py','mouse_move.py','snapshots.py','transfers.py']) {
        await assert.rejects(access(path.join(runtime,'backends/virtualbox',name)),{code:'ENOENT'});
      }
      const archive=path.join(output,archiveName);
      const install=(file,...parameters)=>execFileSync(process.execPath,[cli,'assets','install',file,...parameters],{env,encoding:'utf8',stdio:'pipe'});
      const wrongArchive=path.join(temporary,archiveName);
      await writeFile(wrongArchive,'invalid archive bytes');
      assert.throws(()=>install(archive,'0'.repeat(64)),/SHA-256 mismatch with the digest embedded/);
      assert.throws(()=>install(wrongArchive),/Provisioning archive SHA-256 mismatch/);
      const installed=path.join(cache,`v${manifest.version}`);
      await assert.rejects(access(installed),{code:'ENOENT'});
      assert.equal(install(archive).trim(),installed);
      assert.equal(install(archive,digest.toUpperCase()).trim(),installed);
      await access(path.join(installed,'guest_setup/http/debian-preseed.cfg'));
      const receiver=await readFile(path.join(installed,'guest_setup/vault/vamp-vault-receive'),'utf8');
      assert.ok(receiver.startsWith('#!/usr/bin/python3 -I\n'));
      await access(path.join(installed,'third_party/pyautogui-recorder'));
      await access(path.join(installed,'backends/hyperv/scripts/Manage-Desktop.ps1'));
      await access(path.join(installed,'scripts/script_server.py'));
      await access(path.join(installed,'backends/packer/runner.py'));
      await access(path.join(installed,'backends/packer/podman/host_job.py'));
      await access(path.join(installed,'backends/library/replay.py'));
      await access(path.join(installed,'requirements-mcp.txt'));
    });
    await t.test('concurrent offline installs publish one usable cache',async()=>{
      const output=process.env.VAMP_TEST_ASSETS_OUTPUT;
      const [,archiveName]=(await readFile(path.join(output,'SHA256SUMS'),'utf8')).trim().split(/\s+/);
      const cacheRoot=path.join(temporary,'concurrent-cache');
      const install=promisify(execFile);
      const results=await Promise.all(Array.from({length:4},()=>install(process.execPath,
        [cli,'assets','install',path.join(output,archiveName)],{env:{...env,VAMP_ASSETS_DIR:cacheRoot}})));
      const cacheName=`v${sourceManifest.version}`;
      assert.ok(results.every(({stdout})=>stdout.trim()===path.join(cacheRoot,cacheName)));
      assert.deepEqual(await readdir(cacheRoot),[cacheName]);
      await access(path.join(cacheRoot,cacheName,'guest_setup/http/debian-preseed.cfg'));
    });
    await t.test('release download verifies bytes before publishing and reuses the cache',async()=>{
      const output=process.env.VAMP_TEST_ASSETS_OUTPUT;
      const [,archiveName]=(await readFile(path.join(output,'SHA256SUMS'),'utf8')).trim().split(/\s+/);
      const cache=path.join(temporary,'download-cache');
      const fixture=path.join(temporary,'release-fetch.mjs');
      const calls=path.join(temporary,'release-requests.jsonl');
      await writeFile(fixture,`
        import {appendFile,readFile} from 'node:fs/promises';
        globalThis.fetch = async (url,{signal}) => {
          if (!(signal instanceof AbortSignal)) throw new Error('Expected a download timeout');
          await appendFile(process.env.VAMP_TEST_RELEASE_REQUESTS, JSON.stringify(url)+'\\n');
          const body = process.env.VAMP_TEST_RELEASE_CORRUPT ? 'invalid release bytes'
            : await readFile(process.env.VAMP_TEST_RELEASE_ARCHIVE);
          return new Response(body);
        };
      `);
      const download=(corrupt=false)=>execFileSync(process.execPath,
        ['--import',pathToFileURL(fixture).href,cli,'assets','download'],
        {encoding:'utf8',stdio:'pipe',env:{...env,VAMP_ASSETS_DIR:cache,
          VAMP_TEST_RELEASE_ARCHIVE:path.join(output,archiveName),VAMP_TEST_RELEASE_REQUESTS:calls,
          VAMP_TEST_RELEASE_CORRUPT:corrupt?'1':''}});
      const version=archiveName.slice('vamp-assets-v'.length,-'.tar.gz'.length);
      const target=path.join(cache,`v${version}`);
      assert.throws(()=>download(true),/SHA-256 mismatch/);
      assert.deepEqual(await readdir(cache),[]);
      assert.equal(download().trim(),target);
      assert.equal(download(true).trim(),target);
      const url=`https://github.com/wayfarer6/vamp-mcp/releases/download/v${version}/${archiveName}`;
      assert.deepEqual((await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),[url,url]);
      if (process.env.VAMP_TEST_RECORDER_MEDIA === '1') {
        const work=path.join(temporary,'on-demand');
        const downloadCache=path.join(work,'cache');
        const home=path.join(work,'home');
        const requests=path.join(temporary,'recorder-release-requests.jsonl');
        const child=spawn(process.execPath,['--import',pathToFileURL(fixture).href,cli,'virtualbox'],{
          cwd:temporary,env:{...env,VAMP_HOME:home,VAMP_ASSETS_DIR:downloadCache,
            VAMP_TEST_RELEASE_ARCHIVE:path.join(output,archiveName),VAMP_TEST_RELEASE_REQUESTS:requests,
            VAMP_TEST_RELEASE_CORRUPT:''},
        });
        const lines=createInterface({input:child.stdout});
        const send=message=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
        let stderr='';
        child.stderr.on('data',chunk=>{stderr+=chunk;});
        child.stdin.on('error',()=>{});
        try {
          const result=await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error(`Recorder media MCP timeout: ${stderr}`)),18000);
            const finish=(error,value)=>{
              clearTimeout(timer);
              if(error)reject(error);else resolve(value);
            };
            child.once('error',error=>finish(error));
            child.once('exit',code=>finish(Error(`Recorder media MCP exited ${code}: ${stderr}`)));
            lines.on('line',line=>{
              const reply=JSON.parse(line);
              if(reply.id===1){
                if(reply.error)return finish(Error(JSON.stringify(reply.error)));
                send({method:'notifications/initialized'});
                send({id:2,method:'tools/call',params:{name:'vm_prepare_recorder',arguments:{}}});
              }else if(reply.id===2){
                if(reply.error || reply.result?.isError)return finish(Error(JSON.stringify(reply.error ?? reply.result)));
                finish(null,JSON.parse(reply.result.content[0].text));
              }
            });
            send({id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'vamp-media-qa',version:'1'}}});
          });
          assert.equal(result.status,'media_built');
          assert.equal(result.iso,path.join(home,'artifacts','recorder-setup.iso'));
          assert.equal((await readFile(result.iso)).toString('ascii',32769,32774),'CD001');
          await access(path.join(downloadCache,`v${version}`,'scripts/build_recorder_media.py'));
          assert.equal(JSON.parse((await readFile(requests,'utf8')).trim()),url);
        } finally {
          lines.close();
          child.kill();
        }
      }
    });
  }
});
