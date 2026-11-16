// Binary RFB stream bridge. No screenshot API, polling, image files or recording.
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, createWebSocketStream } from 'ws';

export async function startBridge({host,port,onError=()=>{},resolveTarget,onTarget=()=>{}}) {
  if(!['127.0.0.1','::1','localhost'].includes(host) || !Number.isInteger(port) || port<1 || port>65535) {
    throw new Error('Viewer bridge requires a loopback VNC TCP endpoint');
  }
  const token=randomBytes(24).toString('hex');
  const sockets=new Set();
  const stats={connections:0,active:0,receivedBytes:0,sentBytes:0};
  const server=http.createServer((request,response)=>{response.writeHead(404);response.end();});
  const wsServer=new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});
  server.on('upgrade',async(request,socket,head)=>{
    if(request.url!=='/'+token) {socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    let target={host,port};
    try {
      if(resolveTarget)target=await resolveTarget();
      if(!['127.0.0.1','::1','localhost'].includes(target.host) || !Number.isInteger(target.port) || target.port<1 || target.port>65535)throw new Error('Invalid VM endpoint');
    } catch(error){onError(error.message);socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');return;}
    onTarget(target);
    wsServer.handleUpgrade(request,socket,head,ws=>wsServer.emit('connection',ws,target));
  });
  wsServer.on('connection',(ws,target)=>{
    const tcp=net.createConnection(target);
    const stream=createWebSocketStream(ws,{highWaterMark:64*1024});
    stats.connections++;stats.active++;sockets.add(tcp);sockets.add(ws);
    let closed=false;
    const close=()=>{
      if(closed)return;closed=true;stats.active--;sockets.delete(tcp);sockets.delete(ws);
      tcp.destroy();stream.destroy();ws.terminate();
    };
    tcp.on('data',chunk=>{stats.receivedBytes+=chunk.length;});
    stream.on('data',chunk=>{stats.sentBytes+=chunk.length;});
    tcp.on('error',error=>{onError(error.message);close();});
    stream.on('error',error=>{onError(error.message);close();});
    ws.on('error',error=>{onError(error.message);close();});
    tcp.on('close',close);ws.on('close',close);
    tcp.pipe(stream).pipe(tcp);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();
  return {url:`ws://127.0.0.1:${address.port}/${token}`,port:address.port,stats,
    dispose(){for(const socket of sockets){if(socket.terminate)socket.terminate();else socket.destroy();}sockets.clear();wsServer.close();server.close();}};
}

const html=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function viewerHTML({scriptUri,wsUrl,cspSource,name,host,port}) {
  if(!['127.0.0.1','localhost','::1'].includes(host) || !Number.isInteger(port))throw new Error('Invalid public VNC endpoint');
  const nonce=randomBytes(18).toString('hex');const endpoint=new URL(wsUrl);
  if(endpoint.hostname!=='127.0.0.1' || endpoint.protocol!=='ws:')throw new Error('Invalid viewer WebSocket endpoint');
  return `<!doctype html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src ${html(endpoint.origin)};">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${nonce}">html,body{height:100%;margin:0;background:var(--vscode-editor-background,#141820);color:var(--vscode-editor-foreground,#ddd);font:13px system-ui}body{display:flex;flex-direction:column}header{display:flex;align-items:center;gap:14px;padding:10px 14px;border-bottom:1px solid #555}strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#status{flex:1}button{padding:5px 12px;color:var(--vscode-button-foreground,white);background:var(--vscode-button-background,#087bc1);border:0;cursor:pointer}#screen{flex:1;min-height:0;overflow:hidden}footer{padding:10px 14px;border-top:1px solid #555}table{table-layout:fixed;overflow-wrap:anywhere;width:100%;border-collapse:collapse;text-align:left}th,td{padding:5px 10px;border-bottom:1px solid #444}th{font-weight:500;opacity:.8}code{font-family:var(--vscode-editor-font-family,monospace)}footer p{margin:6px 0 0;opacity:.75;font-size:12px}</style></head><body>
<header><strong>${html(name)}</strong><span id="status" role="status">Connecting…</span><button id="reconnect">Reconnect</button></header>
<div id="screen" data-ws-url="${html(wsUrl)}"></div>
<footer><details><summary>Connection details</summary><table aria-label="External VNC connection"><thead><tr><th>VM name</th><th>Host</th><th>VNC port</th><th>Address</th></tr></thead><tbody><tr><td>${html(name)}</td><td id="vnc-host">${html(host)}</td><td id="vnc-port">${port}</td><td><code id="vnc-address">${html(host)}:${port}</code> <button id="copy-address">Copy address</button></td></tr></tbody></table><p>Use this localhost address with an external VNC viewer on the same host.</p></details></footer><script type="module" nonce="${nonce}" src="${html(scriptUri)}"></script></body></html>`;
}
