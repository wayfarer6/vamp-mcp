import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { remoteReplayEndpoint, runWithVault } from './vault-replay.mjs';

test('remote replay discovers only an owner-private live socket descriptor', {skip:process.platform!=='linux'}, async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'vamp-replay-endpoint-'));
  const socketPath=path.join(directory,'bridge.sock');
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  await chmod(socketPath,0o600);
  const file=path.join(directory,'vamp-vault-replay.json');
  const endpoint={socketPath,token:'a'.repeat(64)};
  await writeFile(file,JSON.stringify(endpoint),{mode:0o600});
  assert.deepEqual(await remoteReplayEndpoint(directory),endpoint);
  await chmod(file,0o644);
  assert.equal(await remoteReplayEndpoint(directory),null);
  await rm(file);
  await symlink(socketPath,file);
  assert.equal(await remoteReplayEndpoint(directory),null);
});

test('reviewed replay stops on denied delivery and resumes on a receipt', {timeout:15000}, async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'vamp-replay-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const id=randomUUID(), vmId=randomUUID(), token=randomUUID();
  const catalog=path.join(root,'한글 카탈로그');
  const registry=path.join(catalog,id);
  await mkdir(registry,{recursive:true});
  const trace=path.join(root,'trace.jsonl');
  const engine=fileURLToPath(new URL('./replay.py',import.meta.url));
  const harness=path.join(root,'driver.py');
  await writeFile(harness,`
import json, os, runpy, sys
from pathlib import Path

assert not any(name.upper().startswith('VAULT_') for name in os.environ)

class Fixture:
    def __init__(self, vm): self.held = set()
    def geometry(self): return [1920, 1080]
    async def drain(self): pass
    def close(self): pass
    def down(self, key):
        with Path(${JSON.stringify(trace)}).open('a') as out:
            out.write(json.dumps(key) + '\\n')
    def up(self, key): pass

def install_fixture(frame, event, arg):
    if event == 'call' and frame.f_code.co_name == 'run' and frame.f_code.co_filename == ${JSON.stringify(engine)}:
        frame.f_globals['VBox'] = Fixture

sys.settrace(install_fixture)
runpy.run_path(${JSON.stringify(engine)}, run_name='__main__')
`);
  const source='# reviewed fixture';
  const actions=JSON.stringify([
    {op:'press',presses:1,keys:['tab'],interval:0},
    {op:'write',text:'${login}'},
    {op:'press',presses:1,keys:['enter'],interval:0},
  ]);
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const expectedResult='주문 저장 완료';
  await Promise.all([
    writeFile(path.join(registry,'source.py'),source),
    writeFile(path.join(registry,'actions.json'),actions),
    writeFile(path.join(registry,'rpa.json'),JSON.stringify({id,format:'vamp-saved-rpa',backend:'virtualbox',reviewed:true,
      inputs:['login'],resolution:[1920,1080],expected_result:expectedResult,source_sha256:hash(source),actions_sha256:hash(actions)})),
  ]);
  const git=(...args)=>execFileSync('git',['-C',registry,...args],{stdio:'pipe'});
  git('init','-q');
  git('add','.');
  git('-c','user.name=QA','-c','user.email=qa@example.invalid','commit','-qm','fixture');
  const socketPath=process.platform==='win32'?`\\\\.\\pipe\\vamp-rpa-${id}`:path.join(root,'bridge.sock');
  let consent=false;
  let readiness='ready';
  const calls=[];
  const server=net.createServer(socket=>createInterface({input:socket}).on('line',line=>{
    const call=JSON.parse(line);
    calls.push(call);
    const status=call.op==='check-replay-destination'?readiness:(consent?'delivered':'denied');
    socket.write(JSON.stringify({id:call.id,ok:true,result:{status,value:'fixture-must-not-leave-bridge'}})+'\n');
  }));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  t.after(()=>server.close());
  const request={id,vm_id:vmId,registry:catalog,inputs:{login:'${vault:QA/Fixture#password}'},vault_destination:'fixture',confirmed:true};
  const python=process.env.RPA_HOST_PYTHON || (process.platform==='win32'?'python':'python3');
  const original=process.env.VAULT_MASTER_PASSWORD;
  const originalEncoding=process.env.PYTHONIOENCODING;
  process.env.VAULT_MASTER_PASSWORD='qa-replay-env-fixture';
  process.env.PYTHONIOENCODING='ascii';
  t.after(()=>{
    if(original===undefined) delete process.env.VAULT_MASTER_PASSWORD;
    else process.env.VAULT_MASTER_PASSWORD=original;
    if(originalEncoding===undefined) delete process.env.PYTHONIOENCODING;
    else process.env.PYTHONIOENCODING=originalEncoding;
  });
  const run=()=>runWithVault(python,harness,request,{socketPath,token});
  const keys=async()=>(await readFile(trace,'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  const denied=await run();
  assert.equal(denied.status,'approval_required');
  assert.equal(denied.actions_completed,1);
  assert.deepEqual(await keys(),['tab']);
  consent=true;
  await writeFile(trace,'');
  const finished=await run();
  assert.equal(finished.status,'completed_unverified');
  assert.equal(finished.expected_result,expectedResult);
  assert.equal(finished.resolved,1);
  assert.deepEqual(await keys(),['tab','enter']);
  assert.ok(!JSON.stringify(finished).includes('fixture-must-not-leave-bridge'));
  readiness='denied';
  await writeFile(trace,'');
  const rejected=await run();
  assert.equal(rejected.status,'approval_required');
  assert.equal(rejected.actions_completed,0);
  assert.equal(await readFile(trace,'utf8'),'');
  for (const missing of ['placeholder_unresolved','placeholder_ambiguous']) {
    readiness=missing;
    const result=await run();
    assert.equal(result.status,missing);
    assert.equal(result.actions_completed,0);
    assert.ok(!JSON.stringify(result).includes('fixture-must-not-leave-bridge'));
    assert.equal(await readFile(trace,'utf8'),'');
  }
  assert.deepEqual(calls.map(call=>call.op),['check-replay-destination','deliver-credential',
    'check-replay-destination','deliver-credential','check-replay-destination',
    'check-replay-destination','check-replay-destination']);
  assert.ok(calls.every(call=>call.token===token && call.params.vmId===vmId));
});
