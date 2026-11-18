'use strict';
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
// Fixed OS location only. Nonstandard Windows installations fail closed.
const POWERSHELL='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const DIAGNOSIS="$ErrorActionPreference='Stop'; $Host.UI.RawUI.WindowTitle='VAMP read-only Hyper-V diagnosis'; Write-Host 'Read-only diagnosis. No VM or Windows settings will change.'; try { Import-Module 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Hyper-V\\Hyper-V.psd1' -ErrorAction Stop; Hyper-V\\Get-VMHost | Out-Null; Write-Host 'Hyper-V host permission: OK'; Hyper-V\\Get-VMSwitch | Select-Object Name,SwitchType | Format-Table } catch { Write-Host 'Hyper-V diagnosis failed. Check Hyper-V installation and account permission.' }; Write-Host 'This does not authorize or enable VM provisioning. Window closes in 60 seconds.'; Start-Sleep -Seconds 60";
// Only constant source text is quoted. No caller data enters this command.
const LAUNCH=`$ErrorActionPreference='Stop'; $exe='${POWERSHELL}'; if((Get-AuthenticodeSignature -LiteralPath $exe).Status -ne 'Valid'){throw 'Untrusted Windows PowerShell'}; $command='${DIAGNOSIS.replaceAll("'","''")}'; try { $p=Start-Process -FilePath $exe -ArgumentList @('-NoProfile','-NonInteractive','-Command',$command) -Verb RunAs -PassThru; @{status='diagnosis_window_opened'} | ConvertTo-Json -Compress } catch { @{status='not_started'} | ConvertTo-Json -Compress }`;
function createHyperVUac({execute=promisify(execFile),platform=process.platform}={}){
 let pending=false;
 return {async request(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='confirmed')||('confirmed'in input&&typeof input.confirmed!=='boolean'))throw Error('Only confirmed: boolean is accepted.');
  if(platform!=='win32')return {status:'unsupported_host',verified:false};
  if(input.confirmed!==true)return {status:'needs_confirmation',verified:false,message:'Open a read-only Hyper-V diagnosis window using Windows UAC? This does not elevate VAMP or enable VM provisioning.'};
  if(pending)return {status:'already_pending',verified:false};
  pending=true;
  try{
   const result=await execute(POWERSHELL,['-NoProfile','-NonInteractive','-Command',LAUNCH],{timeout:45000,maxBuffer:16384,encoding:'utf8',windowsHide:true,cwd:'C:\\Windows\\System32'});
   const data=JSON.parse(result.stdout);
   return {status:data.status==='diagnosis_window_opened'?'diagnosis_window_opened':'not_started',verified:false,message:'Read the diagnosis window. VM provisioning still requires independently authorized host access; no privileged build broker is available.'};
  }catch{return {status:'launch_unverified',verified:false,message:'Permission diagnosis launch could not be verified. This confirmation covers diagnosis only, not VM provisioning. Check the Windows desktop before trying again; no automatic retry was made.'};}
  finally{pending=false;}
 }};
}
module.exports={createHyperVUac};
