'use strict';
const path=require('node:path');
async function createDebianEngine(vscode,{prepareDebianHost,platform=process.platform,isActive=()=>true}){
 if(!['win32','linux'].includes(platform))throw Error('Debian engine builds are available on Windows or Linux hosts only.');
 const providers=[{label:'VirtualBox',provider:'virtualbox',description:'Headless Debian Podman engine'}];
 if(platform==='linux')providers.push({label:'KVM / libvirt',provider:'kvm',description:'Linux host only'});
 const provider=await vscode.window.showQuickPick(providers,{title:'Create Debian VM · engine provider',ignoreFocusOut:true});
 if(!provider||!isActive())return {status:'cancelled'};
 if(!providers.some(p=>p.provider===provider.provider))throw Error('Unsupported engine provider');
 const selected=await vscode.window.showOpenDialog({title:'Select an official Debian amd64 installer ISO',canSelectFiles:true,canSelectFolders:false,canSelectMany:false,filters:{'Debian ISO':['iso']}});
 if(!selected?.length||!isActive())return {status:'cancelled'};
 const iso=selected[0];if(iso.scheme!=='file'||!path.isAbsolute(iso.fsPath)||!/\.iso$/i.test(iso.fsPath))throw Error('Select one local Debian installer ISO.');
 const checksum=await vscode.window.showInputBox({title:'Trusted Debian ISO SHA-256',prompt:'Paste the 64-character SHA-256 from independently verified Debian release checksums. Computing this file’s hash alone does not establish trust.',ignoreFocusOut:true,validateInput:value=>/^[a-fA-F0-9]{64}$/.test(value.trim())?undefined:'Enter exactly 64 hexadecimal characters.'});
 if(checksum===undefined||!isActive())return {status:'cancelled'};
 const isoSha256=checksum.trim().toLowerCase();if(!/^[a-f0-9]{64}$/.test(isoSha256))throw Error('A trusted Debian SHA-256 is required.');
 const approved=await vscode.window.showWarningMessage('Build a new headless Debian engine VM?',{modal:true,detail:'Provider: '+provider.label+'\nLocal ISO: '+iso.fsPath+'\nTrusted SHA-256: '+isoSha256+'\n\nReserve at least 64 GB free space: the guest disk expands to 32 GB, with a separate box/deployment copy. Guest RAM is 4 GB. This authorizes a dedicated Packer build and Vagrant deployment after the box is ready. Required packages/plugins may be downloaded. Build files, separate per-job SSH keys and a private provider-specific box persist. Do not publish this user-specific box. The Debian guest has no GNOME desktop. Existing VMs and Podman defaults are not changed. A started VM does not verify SSH or Podman. No WSL or Hyper-V settings are changed.'},'Build Debian Engine');
 if(approved!=='Build Debian Engine'||!isActive())return {status:'cancelled'};
 return prepareDebianHost({provider:provider.provider,isoPath:iso.fsPath,isoSha256});
}
module.exports={createDebianEngine};
