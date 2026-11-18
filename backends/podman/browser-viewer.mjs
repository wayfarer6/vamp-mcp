// Standalone human-only viewer. A session-limited local capability is returned only
// to the requesting client. Never log or publish it. Assets are bundled locally.
import http from 'node:http';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {WebSocketServer,createWebSocketStream} from '../../vscode-extension/node_modules/ws/wrapper.mjs';
const active = new Set();
const digest = value => createHash('sha256').update(value).digest();
const equal = (left,right) => timingSafeEqual(digest(left),digest(right));
export async function createBrowserViewer({containerId,noVncModule,openScreenStream,mode='view_only',ttlMs=300000,signal}={}) {
  if(!['view_only','control'].includes(mode)) throw Error('Invalid viewer mode');
  if(typeof containerId!=='string'||!/^[a-f0-9]{64}$/.test(containerId)||active.has(containerId)) throw Error('Viewer identity unavailable');
  if(typeof noVncModule!=='string'||!noVncModule.length||Buffer.byteLength(noVncModule)>4*1024*1024||typeof openScreenStream!=='function') throw Error('Local viewer assets unavailable');
  if(!Number.isInteger(ttlMs)||ttlMs<100||ttlMs>600000||signal?.aborted) throw Error('Viewer lifetime unavailable');
  active.add(containerId);
  const capability=randomBytes(32).toString('hex');
  const secret=digest(capability);
  const claimExpiresAt=Date.now()+ttlMs;
  // Cookies are not port-scoped: unique names prevent parallel viewers from
  // replacing one another's sessions on the same loopback host.
  const cookieName='vamp_viewer_'+randomBytes(12).toString('hex');
  const cookie=randomBytes(32).toString('hex');
  let authority,origin,attempts=0,opening=0,authenticated=false,consumed=false,disposed=false,timer,ws,stream,handle;
  const sockets=new Set(),closingChildren=new Set();
  const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});
  const bootstrap="import RFB from '/novnc.js';const r=new RFB(document.getElementById('screen'),'ws://'+location.host+'/stream');r.viewOnly="+(mode==='view_only')+";r.scaleViewport=true;r.resizeSession=false;";
  const claimScript="const token=location.hash.slice(1);history.replaceState(null,'','/');if(/^[a-f0-9]{64}$/.test(token)){fetch('/claim',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token}),credentials:'same-origin'}).then(r=>{if(r.ok)location.replace('/');else document.getElementById('status').textContent='Link expired or unavailable.';}).catch(()=>{document.getElementById('status').textContent='Viewer unavailable.';});}else{document.getElementById('status').textContent='Open the private link supplied by your MCP client.';}";
  const claimHash=createHash('sha256').update(claimScript).digest('base64');
  const scriptHash=createHash('sha256').update(bootstrap).digest('base64');
  const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'};
  const send=(res,status,body='',extra={})=>{res.writeHead(status,{...headers,
    'Content-Security-Policy':`default-src 'none'; script-src 'self' 'sha256-${scriptHash}' 'sha256-${claimHash}'; style-src 'unsafe-inline'; connect-src 'self'${authority?' ws://'+authority:''}; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'Content-Type':'text/html; charset=utf-8',...extra});res.end(body);};
  const session=req=>authenticated&&typeof req.headers.cookie==='string'&&req.headers.cookie.split(';').some(part=>equal(part.trim(),`${cookieName}=${cookie}`));
  const trusted=req=>req.socket.remoteAddress==='127.0.0.1'&&req.headers.host===authority;
  const server=http.createServer((req,res)=>{
    if(!trusted(req)||disposed){send(res,403);return;}
    if(req.method==='POST'&&req.url==='/claim'){
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/x-www-form-urlencoded'||attempts>=5||Date.now()>claimExpiresAt){send(res,403);return;}
      let body='',bytes=0;
      req.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024){req.destroy();return;}body+=chunk.toString('utf8');});
      req.on('end',()=>{
        if(bytes>1024||disposed)return;
        const form=new URLSearchParams(body),token=form.get('token');
        if(Date.now()>claimExpiresAt||[...form.keys()].length!==1||typeof token!=='string'||!timingSafeEqual(digest(token),secret)){attempts++;send(res,403,'Link unavailable.');return;}
        authenticated=true;
        send(res,204,'',{'Set-Cookie':`${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs/1000)}`});
      });
      return;
    }
    if(req.method!=='GET'){send(res,405);return;}
    if(req.url==='/'){
      if(!session(req)){
        send(res,200,`<!doctype html><meta charset="utf-8"><title>VAMP local desktop</title><h1>VAMP ${mode==='control'?'keyboard and mouse control':'view-only'} desktop</h1><p id="status">Opening private local link…</p><p>Clipboard and file transfer are disabled.</p><script>${claimScript}</script>`);return;
      }
      send(res,200,`<!doctype html><meta charset="utf-8"><title>VAMP desktop</title><style>html,body,#screen{margin:0;width:100%;height:100%;overflow:hidden}</style><div id="screen"></div><script type="module">${bootstrap}</script>`);return;
    }
    if(req.url==='/novnc.js'&&session(req)){send(res,200,noVncModule,{'Content-Type':'text/javascript; charset=utf-8'});return;}
    send(res,404);
  });
  server.headersTimeout=5000;server.requestTimeout=5000;
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  const closeHandle=value=>{const child=value?.child;if(child?.exitCode===null&&typeof child.once==='function'&&!closingChildren.has(child)){closingChildren.add(child);const ended=()=>closingChildren.delete(child);child.once('exit',ended);child.once('close',ended);}try{value?.close?.();}catch{}try{value?.child?.stdin?.destroy();value?.child?.stdout?.destroy();value?.child?.kill?.();}catch{}};
  function closeConnection(){const current=ws;ws=undefined;consumed=false;const opened=handle;handle=undefined;closeHandle(opened);const currentStream=stream;stream=undefined;currentStream?.destroy();current?.terminate();}
  function dispose(){if(disposed)return;disposed=true;active.delete(containerId);clearTimeout(timer);signal?.removeEventListener('abort',dispose);secret.fill(0);closeConnection();for(const socket of sockets)socket.destroy();wss.close();server.close();}
  signal?.addEventListener('abort',dispose,{once:true});
  try{
    let bound=false;
    for(let port=6080;port<=6111;port++){
      if(disposed)break;
      try{await new Promise((resolve,reject)=>{const failed=e=>{server.removeListener('listening',ready);reject(e);};const ready=()=>{server.removeListener('error',failed);resolve();};server.once('error',failed);server.once('listening',ready);server.listen({host:'127.0.0.1',port,exclusive:true});});bound=true;break;}
      catch(error){if(error.code!=='EADDRINUSE')throw error;}
    }
    if(!bound||disposed)throw Error('unavailable');
  }catch{dispose();throw Error('Viewer loopback listener unavailable');}
  authority=`127.0.0.1:${server.address().port}`;origin=`http://${authority}`;
  server.on('error',dispose);
  server.on('upgrade',(req,socket,head)=>{
    if(!trusted(req)||req.method!=='GET'||req.url!=='/stream'||req.headers.origin!==origin||!session(req)||consumed||opening>0||closingChildren.size>0||disposed||req.headers['sec-websocket-protocol']){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
    consumed=true;
    try{wss.handleUpgrade(req,socket,head,async connection=>{
      ws=connection;const disconnected=()=>{if(ws===connection)closeConnection();};ws.on('error',disconnected);ws.on('close',disconnected);ws.on('message',(_data,binary)=>{if(!binary)disconnected();});
      stream=createWebSocketStream(ws,{highWaterMark:65536});stream.on('error',disconnected);
      try{opening++;const value=await openScreenStream();if(disposed||ws!==connection){closeHandle(value);return;}handle=value;const child=value?.child;
        if(value?.viewOnly!==(mode==='view_only')||typeof value.close!=='function'||!child?.stdin?.write||!child.stdout?.pipe){disconnected();return;}
        child.on?.('exit',disconnected);child.on?.('error',disconnected);child.stdin.on('error',disconnected);child.stdout.on('error',disconnected);child.stdout.on('end',disconnected);child.stdout.pipe(stream).pipe(child.stdin);
      }catch{disconnected();}finally{opening--;}
    });}catch{dispose();}
  });
  timer=setTimeout(dispose,ttlMs);timer.unref?.();
  server.unref?.();
  return Object.freeze({url:origin+'/#'+capability,port:server.address().port,dispose});
}
