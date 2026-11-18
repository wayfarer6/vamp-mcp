'use strict';
// No network, scripts, persistent files or input controls in the capture viewer.
function captureHTML(result){
  const png=result?.png;
  if(!Buffer.isBuffer(png)||png.length<33||png.length>16*1024*1024||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||png.toString('ascii',12,16)!=='IHDR'||png.readUInt32BE(16)!==1920||png.readUInt32BE(20)!==1080)throw Error('Invalid desktop capture. Expected a bounded 1920×1080 PNG.');
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:;"><title>Container desktop capture</title></head><body><h1>Desktop capture · 1920×1080</h1><p>View only. This is a snapshot, not a live connection. Screen data may contain sensitive information. No screenshot file was saved.</p><img alt="Container desktop screenshot" width="1920" height="1080" src="data:image/png;base64,'+png.toString('base64')+'"></body></html>';
}
function showCapture(vscode,result){
  const html=captureHTML(result);
  const panel=vscode.window.createWebviewPanel('vamp.containerCapture','VAMP · Desktop capture',vscode.ViewColumn.Active,{enableScripts:false,localResourceRoots:[],retainContextWhenHidden:false});
  panel.webview.html=html;return panel;
}
module.exports={captureHTML,showCapture};
