'use strict';
function parseContainerUri(uri){
 if(!['vscode','vscode-insiders'].includes(uri?.scheme)||uri.authority!=='wayfarer6.vamp-mcp-tools'||uri.path!=='/container-view'||uri.fragment)throw Error('Invalid VAMP container link');
 const params=new URLSearchParams(uri.query),keys=[...params.keys()];
 if(keys.length!==2||new Set(keys).size!==2||!keys.includes('connection')||!keys.includes('id'))throw Error('Invalid VAMP container link fields');
 const connection=params.get('connection'),id=params.get('id');
 if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(connection)||!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid container target');
 return {connection,id};
}
function registerContainerUri(vscode,context,{createBackend,openDesktop}){
 let busy=false;
 context.subscriptions.push(vscode.window.registerUriHandler({async handleUri(uri){
  if(busy)return;busy=true;
  try{
   const {connection,id}=parseContainerUri(uri),backend=createBackend();
   const known=await backend.connections();if(!known.some(row=>row.name===connection))throw Error('Podman target is not configured here.');
   const inventory=await backend.list(connection);if(inventory?.connection!==connection||typeof inventory.binding!=='string'||!inventory.containers?.some(row=>row.id===id&&row.state==='running'))throw Error('Running container could not be verified.');
   await backend.screenTarget(connection,id,inventory.binding);
   const choice=await vscode.window.showWarningMessage('Open this container desktop?',{modal:true,detail:'Connection: '+connection+'\nContainer ID: '+id+'\nView only. The trusted image is checked again before streaming. Screen data may contain sensitive information.'},'Open View-only Desktop');
   if(choice!=='Open View-only Desktop')return;
   await openDesktop({containerId:id,openScreenStream:()=>backend.openScreenStream(connection,id,inventory.binding)});
  }catch(error){vscode.window.showErrorMessage('Container desktop: '+error.message);}finally{busy=false;}
 }}));
}
module.exports={parseContainerUri,registerContainerUri};
