'use strict';
const {randomBytes}=require('node:crypto');
const validOrigin=value=>typeof value==='string'&&/^https:\/\/[a-z0-9-]+\.vscode-webview\.net$/.test(value);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function viewerHTML({scriptUri,session,url}){
 const nonce=randomBytes(18).toString('hex');let connect='';
 if(url){const parsed=new URL(url);if(parsed.protocol!=='ws:'||parsed.hostname!=='127.0.0.1'||!/^\/[a-f0-9]{64}$/.test(parsed.pathname))throw Error('Invalid private viewer endpoint');connect=' connect-src '+parsed.origin+';';}
 return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';${connect}"><style nonce="${nonce}">body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:13px var(--vscode-font-family)}header{padding:12px}#screen{height:calc(100vh - 80px)}</style></head><body><header>Container desktop · view only · 1920×1080 <span id="status" role="status">Connecting…</span><p>Screen data may contain sensitive information. No screenshot file is saved.</p></header><div id="screen" data-session="${esc(session)}" data-url="${esc(url||'')}"></div>${url?`<script nonce="${nonce}" type="module" src="${esc(scriptUri)}"></script>`:`<script nonce="${nonce}">acquireVsCodeApi().postMessage({type:'origin',session:${JSON.stringify(session)},origin:location.origin});</script>`}</body></html>`;
}
function openViewer(vscode,context,{containerId,openScreenStream,createBridge}){
 const panel=vscode.window.createWebviewPanel('vamp.containerDesktop','VAMP · Container desktop',vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'dist/webview')]});
 const session=randomBytes(24).toString('hex'),controller=new AbortController();let bridge,claimed=false,closed=false;
 const timer=setTimeout(()=>{if(!claimed)panel.dispose();},15000);timer.unref?.();
 const subscription=panel.webview.onDidReceiveMessage(async m=>{
  if(closed||claimed||m?.type!=='origin'||m.session!==session)return;
  claimed=true;clearTimeout(timer);
  try{
   if(!validOrigin(m.origin))throw Error('This VS Code webview origin is unsupported. Use Capture desktop instead.');
   bridge=await createBridge({containerId,allowedOrigin:m.origin,openScreenStream,signal:controller.signal});
   if(closed){bridge.dispose();return;}
   panel.webview.html=viewerHTML({scriptUri:String(panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'dist/webview/container_viewer.js'))),session,url:bridge.url});
  }catch(error){vscode.window.showErrorMessage('Container desktop: '+error.message);panel.dispose();}
 });
 panel.onDidDispose(()=>{closed=true;clearTimeout(timer);controller.abort();subscription.dispose();bridge?.dispose();});
 panel.webview.html=viewerHTML({session});context.subscriptions.push(panel);return panel;
}
module.exports={openViewer,viewerHTML,validOrigin};
