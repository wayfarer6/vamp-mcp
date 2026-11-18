import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {EventEmitter,once} from 'node:events';import {PassThrough} from 'node:stream';import WebSocket from '../../vscode-extension/node_modules/ws/wrapper.mjs';import {createBrowserViewer} from './browser-viewer.mjs';
let seq=0;const opts=()=>({containerId:(++seq).toString(16).padStart(64,'0'),noVncModule:'export default class RFB {}',openScreenStream:()=>{throw Error('unexpected');}});
const origin=b=>new URL(b.url).origin;
function request(url,{method='GET',headers={},body=''}={}){return new Promise((resolve,reject)=>{const req=http.request(url,{method,headers},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);req.end(body);});}
const claim=(b,token=new URL(b.url).hash.slice(1),o=origin(b))=>request(origin(b)+'/claim',{method:'POST',headers:{Origin:o,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token}).toString()});
async function deny(b,headers){return new Promise((resolve,reject)=>{const ws=new WebSocket(origin(b).replace('http:','ws:')+'/stream',{headers});ws.on('error',()=>{});ws.on('open',()=>{ws.terminate();reject(Error('unexpected open'));});ws.on('unexpected-response',(_req,res)=>{res.resume();ws.terminate();resolve(res.statusCode);});});}
test('fragment capability, no plain-port access, exact Origin and Host',async()=>{const b=await createBrowserViewer(opts());try{
 assert.match(b.url,/^http:\/\/127\.0\.0\.1:60\d\d\/#([a-f0-9]{64})$/);
 assert.equal((await request(origin(b)+'/novnc.js')).status,404);assert.equal(await deny(b,{Origin:origin(b)}),403);
 assert.equal((await claim(b,'wrong')).status,403);assert.equal((await claim(b,undefined,'http://evil.example')).status,403);
 assert.equal((await request(origin(b),{headers:{Host:'evil.example'}})).status,403);
 const page=await request(origin(b));assert.ok(page.body.includes('history.replaceState'));assert.ok(!page.body.includes(new URL(b.url).hash.slice(1)));assert.ok(!page.body.includes('password'));
 }finally{b.dispose();}});
test('same capability reusable within session; cookie required with exact WS origin',async()=>{const b=await createBrowserViewer(opts());try{
 const a=await claim(b),r=await claim(b);assert.equal(a.status,204);assert.equal(r.status,204);
 const cookie=r.headers['set-cookie'][0].split(';')[0];assert.match(r.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/);
 assert.equal((await request(origin(b)+'/novnc.js',{headers:{Cookie:cookie}})).status,200);
 assert.equal(await deny(b,{Origin:'http://evil.example',Cookie:cookie}),403);
 }finally{b.dispose();}});
test('human control reconnects sequentially; concurrent connection denied and exact children cleaned',async()=>{let calls=0,closed=0;const handles=[];
 const b=await createBrowserViewer({...opts(),mode:'control',openScreenStream:()=>{calls++;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>closed++;const h={child,viewOnly:false,close:()=>closed++};handles.push(h);return h;}});
 try{const r=await claim(b);assert.equal(calls,0);const cookie=r.headers['set-cookie'][0].split(';')[0];
 for(let i=0;i<2;i++){const ws=new WebSocket(origin(b).replace('http:','ws:')+'/stream',{headers:{Origin:origin(b),Cookie:cookie}});ws.on('error',()=>{});await once(ws,'open');assert.equal(calls,i+1);
 assert.equal(await deny(b,{Origin:origin(b),Cookie:cookie}),403);
 const msg=once(ws,'message');handles[i].child.stdout.write(Buffer.from('RFB 003.008\n'));assert.equal((await msg)[0].toString(),'RFB 003.008\n');ws.close();await once(ws,'close');assert.ok(closed>0);}
 }finally{b.dispose();}});
test('bounded failed claims and distinct simultaneous ports/cookies',async()=>{const a=await createBrowserViewer(opts()),b=await createBrowserViewer(opts());try{
 assert.equal(b.port,a.port+1);const x=await claim(a),y=await claim(b);assert.notEqual(x.headers['set-cookie'][0].split('=')[0],y.headers['set-cookie'][0].split('=')[0]);
 for(let i=0;i<5;i++)assert.equal((await claim(b,'wrong')).status,403);assert.equal((await claim(b)).status,403);
 }finally{a.dispose();b.dispose();}});
test('hard session expiry removes listener and capability',async()=>{const b=await createBrowserViewer({...opts(),ttlMs:100});await claim(b);await new Promise(r=>setTimeout(r,140));await assert.rejects(request(origin(b)));b.dispose();});
