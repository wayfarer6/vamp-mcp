import RFB from '@novnc/novnc';
const screen=document.getElementById('screen');
const status=document.getElementById('status');
const vscode=typeof acquireVsCodeApi==='function' ? acquireVsCodeApi() : {postMessage(){}};
let current;
function connect() {
  if(current) {const old=current;current=null;old.disconnect();}
  screen.replaceChildren();status.textContent='연결 중…';
  const rfb=new RFB(screen,screen.dataset.wsUrl,{shared:true});current=rfb;
  rfb.viewOnly=true;rfb.scaleViewport=true;rfb.resizeSession=false;
  rfb.clipViewport=false;rfb.showDotCursor=false;
  rfb.addEventListener('connect',()=>{
    if(current!==rfb)return;
    status.textContent='연결됨 · 보기 전용';
    vscode.postMessage({type:'connected',transport:'rfb-websocket',viewOnly:true});
  });
  rfb.addEventListener('disconnect',event=>{
    if(current!==rfb)return;
    status.textContent=event.detail.clean ? '연결 종료 · 재연결을 누르세요' : '연결 끊김 · VM 상태를 확인한 뒤 재연결하세요';
    vscode.postMessage({type:'disconnected',clean:event.detail.clean});
  });
  rfb.addEventListener('credentialsrequired',()=>{
    status.textContent='이 뷰어는 로컬 VAMP 콘솔을 사용합니다. VNC 인증 설정을 확인하세요.';
    rfb.disconnect();
  });
  rfb.addEventListener('securityfailure',()=>{status.textContent='VNC 연결 인증에 실패했습니다.';});
}
document.getElementById('reconnect').addEventListener('click',connect);
document.getElementById('copy-address').addEventListener('click',()=>{vscode.postMessage({type:'copyEndpoint'});});
window.addEventListener('message',event=>{if(event.data?.type==='endpointChanged'){document.getElementById('vnc-host').textContent=event.data.host;document.getElementById('vnc-port').textContent=event.data.port;document.getElementById('vnc-address').textContent=event.data.host+':'+event.data.port;}if(event.data?.type==='endpointCopied'){const button=document.getElementById('copy-address');button.textContent='복사됨';setTimeout(()=>button.textContent='주소 복사',1800);}});
window.addEventListener('beforeunload',()=>{if(current)current.disconnect();});
connect();
