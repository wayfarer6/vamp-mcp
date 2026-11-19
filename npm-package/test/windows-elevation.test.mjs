import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createConnection } from 'node:net';
import { createHmac } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { elevateMcp } from '../bin/windows-mcp-elevation.mjs';
import windowsAdmin from '../runtime/backends/common/windows-admin.cjs';

test('Windows local VM server rejects a standard token and Linux skips the check', async () => {
  await assert.rejects(windowsAdmin.requireAdministrator({
    platform: 'win32',
    execute: (_exe, _args, _options, done) => done({code:37}),
  }), /requires Windows administrator/);
  await windowsAdmin.requireAdministrator({platform:'linux',execute:()=>assert.fail('unexpected Windows probe')});
});

test('Windows elevation preserves MCP stdout and diagnostics separately',
  { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
    const input = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    let response = '', diagnostics = '';
    stdout.on('data', data => { response += data; });
    stderr.on('data', data => { diagnostics += data; });
    input.end('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    const result = await elevateMcp(['unified'], {
      input, stdout, stderr,
      launchWorker(encoded) {
        const process = new EventEmitter();
        process.exitCode = null;
        process.kill = () => {};
        void (async () => {
          const {names, token, args} = JSON.parse(Buffer.from(encoded, 'base64url'));
          assert.deepEqual(args, ['unified']);
          const pipes = names.map(path => createConnection({ path, allowHalfOpen: true }));
          await Promise.all(pipes.map(pipe => once(pipe, 'connect')));
          const [stdio, log] = pipes;
          const proof = (name,side) => createHmac('sha256',Buffer.from(token,'hex')).update(name+'|'+side).digest();
          let chunks=Buffer.alloc(0);
          const reached=new Promise(resolve=>stdio.on('data',chunk=>{
            chunks=Buffer.concat([chunks,chunk]);
            if(chunks.length>32 && chunks.at(-1)===10)resolve(chunks);
          }));
          log.resume();
          for (const [index,pipe] of pipes.entries()) pipe.write(proof(names[index],'worker'));
          const data = await reached;
          assert.deepEqual(data.subarray(0,32),proof(names[0],'parent'));
          const message=data.subarray(32);
          assert.equal(JSON.parse(message).method, 'initialize');
          stdio.end('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}\n');
          log.end('diagnostic only\n');
          process.exitCode = 0;
          process.emit('exit', 0);
        })().catch(error => process.emit('error', error));
        return process;
      },
    });
    assert.equal(result, 0);
    assert.equal(JSON.parse(response).id, 1);
    assert.equal(diagnostics, 'diagnostic only\n');
  });

test('a cancelled administrator prompt leaves MCP stdout empty',
  { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
    const stdout = new PassThrough();
    let bytes = 0;
    stdout.on('data', data => { bytes += data.length; });
    await assert.rejects(elevateMcp(['unified'], {
      input: new PassThrough(), stdout,
      launchWorker() {
        const worker = new EventEmitter();
        worker.exitCode = 1;
        setImmediate(() => worker.emit('exit',1));
        return worker;
      },
    }), /did not connect/);
    assert.equal(bytes,0);
  });
