import RFB from '@novnc/novnc';
const screen=document.getElementById('screen'),status=document.getElementById('status');
const rfb=new RFB(screen,screen.dataset.url,{shared:true});
rfb.viewOnly=true;rfb.resizeSession=false;rfb.scaleViewport=true;rfb.clipViewport=false;
rfb.addEventListener('connect',()=>{status.textContent='Connected · view only';});
rfb.addEventListener('disconnect',()=>{status.textContent='Disconnected. Close and reopen from Containers.';});
rfb.addEventListener('credentialsrequired',()=>rfb.disconnect());rfb.addEventListener('securityfailure',()=>rfb.disconnect());
window.addEventListener('beforeunload',()=>rfb.disconnect());
