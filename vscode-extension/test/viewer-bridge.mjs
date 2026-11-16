import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import {once} from 'node:events';
import WebSocket from 'ws';
import {startBridge,viewerHTML} from '../src/viewer_bridge.mjs';

test('real binary stream passes in both directions; reconnect works; bad token denied',async()=>{
  const packets=[];
  const tcp=net.createServer(socket=>{socket.write(Buffer.from('RFB 003.008\n'));socket.on('data',data=>{packets.push(data);socket.write(data);});});
  tcp.listen(0,'127.0.0.1');await once(tcp,'listening');
  const bridge=await startBridge({host:'127.0.0.1',port:tcp.address().port});
  try {
    for(let run=0;run<2;run++) {
      const ws=new WebSocket(bridge.url);const greeting=once(ws,'message');await once(ws,'open');
      assert.equal((await greeting)[0].toString(),'RFB 003.008\n');
      const response=once(ws,'message');ws.send(Buffer.from([0,255,13,10,17]));assert.deepEqual((await response)[0],Buffer.from([0,255,13,10,17]));
      ws.close();await once(ws,'close');
    }
    assert.equal(bridge.stats.connections,2);assert.equal(packets.length,2);
    assert.ok(bridge.stats.receivedBytes>=24);assert.ok(bridge.stats.sentBytes>=10);
    const bad=new WebSocket(bridge.url.replace(/[^/]+$/,'invalid'));bad.on('error',()=>{});
    const [response]=await once(bad,'unexpected-response');
  } finally {bridge.dispose();tcp.close();}
});

test('bridge rejects non-loopback destinations and HTML escapes VM names',async()=>{
  await assert.rejects(startBridge({host:'192.168.0.1',port:5900}),/loopback/);
  const result=viewerHTML({scriptUri:'https://example.invalid/viewer.js',wsUrl:'ws://127.0.0.1:1234/token',name:'<img src=x onerror=alert(1)>',host:'127.0.0.1',port:5901});
  assert.ok(!result.includes('<img src=x'));assert.ok(result.includes('127.0.0.1:5901'));
  assert.ok(result.includes('외부 VNC 접속 정보'));assert.ok(result.includes('connect-src ws://127.0.0.1:1234'));
});
