import test from 'node:test';
import assert from 'node:assert/strict';
import {once,EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import http from 'node:http';
import WebSocket from 'ws';
import {createContainerViewerBridge} from '../src/container-viewer-bridge.mjs';
let id=0;
const containerId=()=> (++id).toString(16).padStart(64,'0');
const origin='https://test-panel.vscode-webview.net';
const tick=()=>new Promise(r=>setTimeout(r,20));
function fake(){const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();let closed=0;child.kill=()=>{closed++;};return {child,viewOnly:true,close:()=>{closed++;},get closed(){return closed;}};}
async function denied(url,headers){return new Promise((resolve,reject)=>{const ws=new WebSocket(url,{headers});ws.on('error',()=>{});ws.on('open',()=>{ws.terminate();reject(Error('unexpected connection'));});ws.on('unexpected-response',(_req,res)=>{res.resume();ws.terminate();resolve(res.statusCode);});});}
test('unknown/null origins fail closed without opening adapters',async()=>{
  for(const allowedOrigin of [undefined,'null','*','https://evil.example','https://a.vscode-webview.net/path'])
    await assert.rejects(createContainerViewerBridge({containerId:containerId(),allowedOrigin,openScreenStream:()=>assert.fail()}));
});
test('HTTP, wrong token, cross-origin and Host are denied before adapter',async()=>{
  let calls=0;const b=await createContainerViewerBridge({containerId:containerId(),allowedOrigin:origin,openScreenStream:()=>{calls++;return fake();}});
  try{
    assert.equal(await denied(b.url,{Origin:'https://evil.example'}),403);
    assert.equal(await denied(b.url,{Origin:origin,Host:'evil.example'}),403);
    assert.equal(await denied(b.url+'?extra=1',{Origin:origin}),403);
    const status=await new Promise(r=>http.get(b.url.replace('ws:','http:'),res=>{res.resume();r(res.statusCode);}));
    assert.equal(status,403);assert.equal(calls,0);
  }finally{b.dispose();}
});
test('authenticated binary stdio, single client, child cleanup',async()=>{
  const handle=fake();let calls=0;
  const b=await createContainerViewerBridge({containerId:containerId(),allowedOrigin:origin,openScreenStream:()=>{calls++;return handle;}});
  const ws=new WebSocket(b.url,{headers:{Origin:origin}});ws.on('error',()=>{});
  try{
    await once(ws,'open');await tick();
    const incoming=once(ws,'message');handle.child.stdout.write(Buffer.from('RFB 003.008\n'));
    assert.equal((await incoming)[0].toString(),'RFB 003.008\n');
    const input=once(handle.child.stdin,'data');ws.send(Buffer.from([1,2]));assert.deepEqual((await input)[0],Buffer.from([1,2]));
    assert.equal(await denied(b.url,{Origin:origin}),403);assert.equal(calls,1);
    ws.close();await once(ws,'close');await tick();assert.ok(handle.closed>0);
  }finally{ws.terminate();b.dispose();}
});
test('abort during asynchronous adapter creation closes late child',async()=>{
  let resolve;const pending=new Promise(r=>{resolve=r;});const controller=new AbortController();
  const b=await createContainerViewerBridge({containerId:containerId(),allowedOrigin:origin,signal:controller.signal,openScreenStream:()=>pending});
  const ws=new WebSocket(b.url,{headers:{Origin:origin}});ws.on('error',()=>{});await once(ws,'open');
  controller.abort();const handle=fake();resolve(handle);await tick();assert.ok(handle.closed>0);b.dispose();
});
test('text and oversized payloads close view-only transport',async()=>{
  for(const payload of ['text',Buffer.alloc(1024*1024+1)]){
    const handle=fake();const b=await createContainerViewerBridge({containerId:containerId(),allowedOrigin:origin,openScreenStream:()=>handle});
    const ws=new WebSocket(b.url,{headers:{Origin:origin}});ws.on('error',()=>{});
    await once(ws,'open');await tick();const closed=once(ws,'close');ws.send(payload);await closed;await tick();assert.ok(handle.closed>0);b.dispose();
  }
});

test('atomic consecutive port allocation skips occupied ports and frees on close',async()=>{
  const occupied=http.createServer();await new Promise((resolve,reject)=>{occupied.once('error',reject);occupied.listen(6080,'127.0.0.1',resolve);});
  const options={allowedOrigin:origin,openScreenStream:()=>fake()};
  const one=await createContainerViewerBridge({containerId:containerId(),...options});
  const two=await createContainerViewerBridge({containerId:containerId(),...options});
  try {assert.equal(one.port,6081);assert.equal(two.port,6082);} finally {one.dispose();two.dispose();await new Promise(r=>occupied.close(r));}
});
test('full identity required and duplicate same-container panel rejected',async()=>{
  const cid=containerId(), options={allowedOrigin:origin,openScreenStream:()=>fake()};
  await assert.rejects(createContainerViewerBridge({containerId:'short',...options}));
  const b=await createContainerViewerBridge({containerId:cid,...options});
  try {await assert.rejects(createContainerViewerBridge({containerId:cid,...options}),/already open/);} finally {b.dispose();}
});
test('TTL closes exact child and unverified view-only adapters are refused',async()=>{
  for(const verified of [true,false]){
    const h=fake();h.viewOnly=verified;
    const b=await createContainerViewerBridge({containerId:containerId(),allowedOrigin:origin,openScreenStream:()=>h,ttlMs:100});
    const ws=new WebSocket(b.url,{headers:{Origin:origin}});ws.on('error',()=>{});
    const closed=once(ws,'close');await once(ws,'open');await closed;assert.ok(h.closed>0);b.dispose();
  }
});
