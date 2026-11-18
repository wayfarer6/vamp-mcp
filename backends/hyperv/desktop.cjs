// Windows-only local lifecycle adapter. No Linux tools or host GUI input.
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {requireBackendHost}=require('../common/host-support.cjs');
const ERROR_MESSAGES=Object.freeze({
  hyperv_module_missing:'Hyper-V PowerShell module is not installed. Ask your Windows administrator to check Hyper-V management tools; VAMP has not changed Windows features.',
  hyperv_service_missing:'Hyper-V Virtual Machine Management service is unavailable. Ask your Windows administrator to check the Hyper-V host feature; VAMP has not enabled it.',
  hyperv_service_stopped:'Hyper-V Virtual Machine Management service is not running. Ask your Windows administrator to check it; VAMP has not started services.',
  hyperv_access_denied:'Hyper-V access denied. Ask your Windows administrator to verify this account has Hyper-V management permission. VAMP has not elevated privileges or changed account membership.',
  hyperv_policy_blocked:'Windows PowerShell blocked the Hyper-V management script. Ask your Windows administrator to review the execution policy and script trust. VAMP has not changed or bypassed policy.',
  hyperv_operation_failed:'Hyper-V operation failed. Verify Hyper-V host availability and this account’s management permission. No raw system error is displayed.',
});
function safeFailure(error){
  let code;
  try { const result=JSON.parse(error.stdout); if(result.status==='error')code=result.code; } catch {}
  // This fallback also covers policy failures before the script can emit JSON.
  if(!Object.hasOwn(ERROR_MESSAGES,code)){
    const text=String(error.stderr||'');
    code=/PSSecurityException|about_Execution_Policies/.test(text)?'hyperv_policy_blocked':'hyperv_operation_failed';
  }
  const failure=new Error(ERROR_MESSAGES[code]); failure.code=code; return failure;
}
/** @returns {import('../common/desktop-interface').DesktopAdapter} */
function createHyperVAdapter(context,{runtime,execute=promisify(execFile),platform=process.platform}){
  requireBackendHost('hyperv',platform);
  const storage=path.join(process.env.VAMP_HOME||path.join(require('node:os').homedir(),'.vamp'),'vms/hyperv');
  async function call(action,data={}){
    const request=Buffer.from(JSON.stringify({action,...data})).toString('base64');
    let result;
    try { result=await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(runtime,'backends/hyperv/scripts/Manage-Desktop.ps1'),'-RequestBase64',request,'-StoragePath',storage,'-LegacyStoragePath',path.join(context.globalStorageUri.fsPath,'desktops/hyperv')],{timeout:180000,maxBuffer:4*1024**2,encoding:'utf8'}); } catch(error) { throw safeFailure(error); }
    let value;
    try { value=JSON.parse(result.stdout); } catch { throw safeFailure({}); }
    if(value.status==='error')throw safeFailure({stdout:result.stdout});
    if(action==='check' && value.status!=='ready')throw safeFailure({});
    return value;
  }
  return {check:async()=>{await call('check');return 'Hyper-V ready';},list:async()=>(await call('list')).vms,
    create:values=>require('../common/packer.cjs').packer({runtime})('create',{backend:'hyperv',...values}),start:id=>call('start',{id}),stop:id=>call('stop',{id}),remove:id=>call('delete',{id})};
}
module.exports={createHyperVAdapter};
