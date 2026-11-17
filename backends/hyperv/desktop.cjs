// Windows-only local lifecycle adapter. No Linux tools or host GUI input.
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {requireBackendHost}=require('../common/host-support.cjs');
/** @returns {import('../common/desktop-interface').DesktopAdapter} */
function createHyperVAdapter(context,{runtime,execute=promisify(execFile),platform=process.platform}){
  requireBackendHost('hyperv',platform);
  const storage=path.join(context.globalStorageUri.fsPath,'desktops/hyperv');
  async function call(action,data={}){
    const request=Buffer.from(JSON.stringify({action,...data})).toString('base64');
    const result=await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(runtime,'backends/hyperv/scripts/Manage-Desktop.ps1'),'-RequestBase64',request,'-StoragePath',storage],{timeout:180000,maxBuffer:4*1024**2});
    return JSON.parse(result.stdout);
  }
  return {check:async()=>{await call('check');return 'Hyper-V ready';},list:async()=>(await call('list')).vms,
    create:values=>call('create',values),start:id=>call('start',{id}),stop:id=>call('stop',{id}),remove:id=>call('delete',{id})};
}
module.exports={createHyperVAdapter};
