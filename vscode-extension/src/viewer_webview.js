import RFB from '@novnc/novnc';
const screen=document.getElementById('screen');
const status=document.getElementById('status');
const vscode=typeof acquireVsCodeApi==='function' ? acquireVsCodeApi() : {postMessage(){}};
let current;
function connect() {
  if(current) {const old=current;current=null;old.disconnect();}
  screen.replaceChildren();status.textContent='Connecting…';
  const rfb=new RFB(screen,screen.dataset.wsUrl,{shared:true});current=rfb;
  rfb.viewOnly=true;rfb.scaleViewport=true;rfb.resizeSession=false;
  rfb.clipViewport=false;rfb.showDotCursor=false;
  rfb.addEventListener('connect',()=>{
    if(current!==rfb)return;
    status.textContent='Connected · view only';
    vscode.postMessage({type:'connected',transport:'rfb-websocket',viewOnly:true});
  });
  rfb.addEventListener('disconnect',event=>{
    if(current!==rfb)return;
    status.textContent=event.detail.clean ? 'Disconnected · click Reconnect' : 'Connection lost · check VM state, then reconnect';
    vscode.postMessage({type:'disconnected',clean:event.detail.clean});
  });
  rfb.addEventListener('credentialsrequired',()=>{
    status.textContent='This viewer uses a localhost VAMP console. Check VNC authentication settings.';
    rfb.disconnect();
  });
  rfb.addEventListener('securityfailure',()=>{status.textContent='VNC authentication failed.';});
}
document.getElementById('reconnect').addEventListener('click',connect);
document.getElementById('copy-address').addEventListener('click',()=>{vscode.postMessage({type:'copyEndpoint'});});
window.addEventListener('message',event=>{if(event.data?.type==='endpointChanged'){document.getElementById('vnc-host').textContent=event.data.host;document.getElementById('vnc-port').textContent=event.data.port;document.getElementById('vnc-address').textContent=event.data.host+':'+event.data.port;}if(event.data?.type==='endpointCopied'){const button=document.getElementById('copy-address');button.textContent='Copied';setTimeout(()=>button.textContent='Copy address',1800);}});
window.addEventListener('beforeunload',()=>{if(current)current.disconnect();});
connect();
