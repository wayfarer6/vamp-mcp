const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const {createScriptServer,SCRIPT_SERVER_PORT}=require(path.join(root,'script-server'));

function fakeRuntime(status='running'){
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'vamp-script-server-test-'));
  fs.mkdirSync(path.join(runtime,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(runtime,'scripts','script_server.py'),`
import json, sys
command = sys.argv[1]
print(json.dumps({'status': 'stopped' if command == 'stop' else '${status}', 'port': 8421, 'argv': sys.argv[1:], 'guest_urls': {'virtualbox_nat': 'http://10.0.2.2:8421'}}))
`);
  return runtime;
}

test('the guest setup server is fixed to port 8421',()=>{
  assert.equal(SCRIPT_SERVER_PORT,8421);
});

test('start and status pass port 8421 to scripts/script_server.py',async()=>{
  const runtime=fakeRuntime();
  const server=createScriptServer({runtime,python:'python3'});
  assert.equal(server.available(),true);
  assert.equal(server.script,path.join(runtime,'scripts','script_server.py'));
  const started=await server.start({ttlSeconds:900});
  assert.equal(started.status,'running');
  assert.equal(started.port,8421);
  assert.equal(started.argv[0],'start');
  assert.ok(started.argv.includes('8421'));
  assert.ok(started.argv.includes('900'));
  const status=await server.status();
  assert.equal(status.argv[0],'status');
  const stopped=await server.stop();
  assert.equal(stopped.status,'stopped');
});

test('ensure reuses a running server instead of starting a second one',async()=>{
  const server=createScriptServer({runtime:fakeRuntime(),python:'python3'});
  const ensured=await server.ensure();
  assert.equal(ensured.status,'running');
  assert.equal(ensured.argv[0],'start');
});

test('a missing runtime script is reported instead of silently skipped',()=>{
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'vamp-script-server-missing-'));
  const server=createScriptServer({runtime,python:'python3'});
  assert.equal(server.available(),false);
});

test('a failing python process surfaces stderr',async()=>{
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'vamp-script-server-fail-'));
  fs.mkdirSync(path.join(runtime,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(runtime,'scripts','script_server.py'),"import sys\nsys.stderr.write('server exploded\\n')\nsys.exit(2)\n");
  const server=createScriptServer({runtime,python:'python3'});
  await assert.rejects(()=>server.status(),/server exploded/);
});


test('closing an editor leaves the leased shared server alone; Stop remains explicit',async()=>{
  const runtime=fakeRuntime();
  const script=path.join(runtime,'scripts','script_server.py');
  fs.appendFileSync(script,`\nfrom pathlib import Path\nPath(__file__).with_name('last-command').write_text(command)\n`);
  const server=createScriptServer({runtime,python:'python3'});
  await server.start();
  await server.dispose();
  assert.equal(fs.readFileSync(path.join(runtime,'scripts','last-command'),'utf8'),'start');
  await server.stop();
  assert.equal(fs.readFileSync(path.join(runtime,'scripts','last-command'),'utf8'),'stop');
});
