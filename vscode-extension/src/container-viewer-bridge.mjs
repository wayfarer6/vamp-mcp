// Dedicated loopback WebSocket -> fixed, view-only adapter stdio transport.
// No TCP RFB endpoint, commands, paths, authentication logs, or transport input.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
const activeContainers = new Set();
import { WebSocketServer, createWebSocketStream } from 'ws';

export async function createContainerViewerBridge({containerId, allowedOrigin, openScreenStream, signal, ttlMs = 300000} = {}) {
  // Obtain this exact origin from a trusted VS Code webview API, not messages.
  // Opaque/null origins cannot be safely authenticated and are not supported.
  if (typeof allowedOrigin !== 'string' || !/^https:\/\/[a-z0-9-]+\.vscode-webview\.net$/.test(allowedOrigin))
    throw new Error('A verified exact VS Code webview origin is required');
  if (typeof openScreenStream !== 'function') throw new Error('Fixed screen adapter required');
  if (!Number.isInteger(ttlMs) || ttlMs < 100 || ttlMs > 600000) throw new Error('Invalid viewer lifetime');
  if (signal?.aborted) throw new Error('Viewer cancelled');
  if (typeof containerId !== 'string' || !/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Full container identity required');
  if (activeContainers.has(containerId)) throw new Error('Container viewer already open');
  activeContainers.add(containerId);
  const token = randomBytes(32).toString('hex');
  const sockets = new Set();
  let consumed = false, disposed = false, child, handle, ws, stream, timer;
  const server = http.createServer((_req,res) => {res.writeHead(403, {'Connection':'close'});res.end();});
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.on('connection', socket => {sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  const wss = new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});
  function closeChild(value) {
    try { value?.stdin?.destroy(); } catch {}
    try { value?.stdout?.destroy(); } catch {}
    try { value?.dispose?.(); } catch {}
    try { value?.kill?.(); } catch {}
  }
  function dispose() {
    if (disposed) return;
    disposed = true; activeContainers.delete(containerId); clearTimeout(timer); signal?.removeEventListener('abort', dispose);
    try { handle?.close?.(); } catch {}
    closeChild(child); stream?.destroy(); ws?.terminate();
    for (const socket of sockets) socket.destroy();
    wss.close(); server.close();
  }
  signal?.addEventListener('abort', dispose, {once:true});
  let bound = false;
  try {
    // Binding is the reservation: no race-prone preliminary port scan.
    for (let port = 6080; port <= 6111; port++) {
      if (disposed) break;
      try {
        await new Promise((resolve,reject) => {
          const failed = error => {server.removeListener('listening', ready);reject(error);};
          const ready = () => {server.removeListener('error', failed);resolve();};
          server.once('error',failed);server.once('listening',ready);
          server.listen({port,host:'127.0.0.1',exclusive:true});
        });
        bound = true; break;
      } catch (error) {if (error.code !== 'EADDRINUSE') throw error;}
    }
    if (!bound) throw new Error('No viewer port available');
  } catch {dispose();throw new Error('Viewer loopback listener unavailable');}
  server.on('error', dispose);
  if (disposed || signal?.aborted) {dispose();throw new Error('Viewer cancelled');}
  const authority = `127.0.0.1:${server.address().port}`;
  server.on('upgrade',(request,socket,head)=>{
    const reject = () => {socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');};
    if (disposed || consumed || request.method !== 'GET' || request.url !== `/${token}` ||
        request.headers.host !== authority || request.headers.origin !== allowedOrigin ||
        socket.remoteAddress !== '127.0.0.1' || request.headers['sec-websocket-protocol']) {reject();return;}
    consumed = true;
    try {
      wss.handleUpgrade(request,socket,head, async connection => {
        ws = connection;
        ws.on('error',dispose);ws.on('close',dispose);
        // Binary RFB only; reject text frames rather than treating text as input.
        ws.on('message',(_data,binary)=>{if (!binary) dispose();});
        stream = createWebSocketStream(ws,{highWaterMark:64*1024});
        stream.on('error',dispose);
        try {
          const opened = await openScreenStream();
          if (disposed) {try { opened?.close?.(); } catch {} closeChild(opened?.child);return;}
          handle = opened;
          child = opened?.child;
          // This assertion is supplied by the trusted fixed adapter, not UI.
          // Its RFB server must enforce view-only; a browser flag is insufficient.
          if (handle?.viewOnly !== true || !child.stdin?.write || !child.stdout?.pipe ||
              (typeof child.dispose !== 'function' && typeof child.kill !== 'function')) {dispose();return;}
          child.on?.('error',dispose);child.on?.('exit',dispose);
          child.stdout.on('error',dispose);child.stdin.on('error',dispose);
          child.stdout.on('end',dispose);
          child.stdout.pipe(stream).pipe(child.stdin);
        } catch {dispose();}
      });
    } catch {dispose();}
  });
  timer = setTimeout(dispose, ttlMs);timer.unref?.();
  return Object.freeze({url:`ws://${authority}/${token}`, port:server.address().port, dispose});
}
