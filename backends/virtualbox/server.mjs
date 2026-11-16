#!/usr/bin/env node
// First-party MIT integration; upstream files remain unmodified.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { registerDisplayTools } from '../../third_party/mcp-virtualbox/dist/tools/display.js';
import { registerInputTools } from '../../third_party/mcp-virtualbox/dist/tools/input.js';
import { vboxManage, parseVMList, parseMachineReadable } from '../../third_party/mcp-virtualbox/dist/vbox.js';
import { McpServer } from '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { StdioServerTransport } from '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import { z } from '../../third_party/mcp-virtualbox/node_modules/zod/index.js';
import { config as vboxConfig } from '../../third_party/mcp-virtualbox/dist/types.js';
vboxConfig.mouseHelperPath=process.env.MOUSE_HELPER_PATH || fileURLToPath(new URL('./mouse_click.py',import.meta.url));
vboxConfig.pythonPath=process.env.PYTHON_PATH || process.env.RPA_HOST_PYTHON || (process.platform==='win32'?'python':'python3');
const server = new McpServer({name: 'VAMP', version: '0.1.2'}, {instructions:'For first-time setup call vamp_setup. Ask whether to set up the VM environment and obtain a host ISO path. Ask once each session whether to take a snapshot, explain space use, and never assume consent. Debian is default; ask explicitly before Windows and disclose licensing and public sandbox credentials. Do not create a VM merely on server startup.'});
const result = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
async function displayAction(action,values) {
  const python=process.env.RPA_HOST_PYTHON || 'python';
  const script=fileURLToPath(new URL('./display.py',import.meta.url));
  const output=await new Promise((resolve,reject)=>{
    const child=execFile(python,[script,action],{timeout:180000},(error,stdout,stderr)=>{
      if(error) reject(new Error(stdout || stderr || error.message)); else resolve(stdout);
    });
    child.stdin.end(JSON.stringify(values));
  });
  return JSON.parse(output);
}
server.tool('vm_configure_display','Request guest-native 1920x1080 and scaled viewer, disable auto-resize; verify via PNG pixels when running.',
  {vm:z.string().min(1)},async args=>result(await displayAction('configure',args)));
server.tool('vm_insert_guest_additions','Insert host Guest Additions ISO for a Windows VM; user installs it and approves UAC manually. Never replace occupied media.',
  {vm:z.string().min(1),iso_path:z.string().optional()},async args=>result(await displayAction('additions',args)));
async function historyAction(args) {
  const python=process.env.RPA_HOST_PYTHON || 'python';
  const script=fileURLToPath(new URL('./history.py',import.meta.url));
  const output=await new Promise((resolve,reject)=>{
    const child=execFile(python,[script],{timeout:120000},(error,stdout,stderr)=>{
      if(error)reject(new Error(stdout || stderr || error.message));else resolve(stdout);
    });child.stdin.end(JSON.stringify(args));
  });return JSON.parse(output);
}
server.tool('vm_run_observation','Begin/end optional low-resolution video and SQLite run evidence, or capture a screenshot. Video is opt-in, 640x360/5fps/180s/20MB, no audio.',{
  action:z.enum(['begin','end','capture']),vm:z.string().optional(),run_id:z.string().optional(),video:z.boolean().default(false),robot_status:z.string().default('completed'),
},async ({action,vm,run_id,video,robot_status})=>{
  if(action==='begin') {if(!vm)throw new Error('vm required');return result(await historyAction({action,vm,video}));}
  if(!run_id)throw new Error('run_id required');
  return result(await historyAction(action==='end'?{action,run_id,robot_status}:{action,run_id}));
});
server.tool('vm_run_history','Read bounded SQLite execution history or one run and its artifact paths.',{
  run_id:z.string().optional(),limit:z.number().int().min(1).max(100).default(20),
},async ({run_id,limit})=>result(await historyAction(run_id?{action:'detail',run_id}:{action:'list',limit})));
server.tool('vm_run_artifact','Inspect an artifact by SQLite id. Screenshot image data is returned only when show_image=true; videos return local paths.',{
  artifact_id:z.number().int().positive(),show_image:z.boolean().default(false),
},async ({artifact_id,show_image})=>{
  const item=await historyAction({action:'artifact',artifact_id});
  if(show_image && item.kind==='screenshot') {
    const {readFile}=await import('node:fs/promises');const bytes=await readFile(item.path);
    if(bytes.length>8*1024*1024)throw new Error('Image too large');
    return {content:[{type:'text',text:JSON.stringify(item)},{type:'image',data:bytes.toString('base64'),mimeType:'image/png'}]};
  }return result(item);
});
server.tool('vm_recording_share','Prepare host recording share (no overwriting existing mappings) or read/list saved recording source without execution. Mounting in the guest must be verified.',{
  vm:z.string().min(1),action:z.enum(['prepare','inspect']).default('prepare'),
  filename:z.string().optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(8000).default(8000),
},async ({vm,action,filename,offset,limit})=>{
  const python=process.env.RPA_HOST_PYTHON || 'python';
  const script=fileURLToPath(new URL('./shares.py',import.meta.url));
  const args=action==='prepare'?{vm,action}:{vm,action,filename,offset,limit};
  const output=await new Promise((resolve,reject)=>{
    const child=execFile(python,[script],{timeout:90000},(error,stdout,stderr)=>{
      if(error)reject(new Error(stdout || stderr || error.message));else resolve(stdout);
    });child.stdin.end(JSON.stringify(args));
  });return result(JSON.parse(output));
});
async function transferAction(action,values) {
  const script=fileURLToPath(new URL('./transfers.py',import.meta.url));
  const output=await new Promise((resolve,reject)=>{
    const child=execFile(process.env.RPA_HOST_PYTHON || 'python',[script],{timeout:180000,maxBuffer:1024*1024},(error,stdout,stderr)=>{
      if(error && !stdout)reject(new Error(stderr || error.message));else resolve(stdout);
    });child.stdin.end(JSON.stringify({action,...values}));
  });return JSON.parse(output);
}
server.tool('vm_exchange_prepare','Configure the VM-scoped VAMPFiles shared folder. Requires Guest Additions; mount verification is separate.',{
  vm:z.string().min(1),
},async args=>result(await transferAction('prepare',args)));
server.tool('vm_file_put','Stage a <=1 GiB host file in the VM shared folder. Returns staged, not proof of a guest mount. Existing files require overwrite=true.',{
  vm:z.string().min(1),local_path:z.string().min(1),guest_path:z.string().min(1),overwrite:z.boolean().default(false),
},async args=>result(await transferAction('put',args)));
server.tool('vm_file_get','Copy a <=1 GiB shared guest file to the host and return size/SHA-256 without file contents.',{
  vm:z.string().min(1),guest_path:z.string().min(1),local_path:z.string().min(1),overwrite:z.boolean().default(false),
},async args=>result(await transferAction('get',args)));
server.tool('vm_import_recording','Copy a user-chosen .py/.handoff.json under guest RPA-Recorder using Guest Additions. Parse without execution; authorized sandbox account only.',{
  vm:z.string().min(1),guest_path:z.string().min(1),username:z.string().default('vboxuser'),
},async args=>{
  const python=process.env.RPA_HOST_PYTHON || 'python';
  const script=fileURLToPath(new URL('./recordings.py',import.meta.url));
  const output=await new Promise((resolve,reject)=>{
    const child=execFile(python,[script],{timeout:100000},(error,stdout,stderr)=>{
      if(error)reject(new Error(stdout || stderr || error.message));else resolve(stdout);
    });child.stdin.end(JSON.stringify(args));
  });return result(JSON.parse(output));
});
server.tool('vm_snapshot','List/take/restore snapshots. Ask about extra disk space at each session; taking is opt-in. Restore discards later active changes and requires exact user confirmation and an already powered-off VM.',{
  vm:z.string().min(1),action:z.enum(['list','take','restore','restore_initial']).default('list'),
  name:z.string().optional(),initial:z.boolean().default(false),confirm_restore:z.boolean().default(false),
},async args=>{
  const python=process.env.RPA_HOST_PYTHON || 'python';
  const script=fileURLToPath(new URL('./snapshots.py',import.meta.url));
  const output=await new Promise((resolve,reject)=>{
    const child=execFile(python,[script],{timeout:330000},(error,stdout,stderr)=>{
      if(error) reject(new Error(stdout || stderr || error.message)); else resolve(stdout);
    });child.stdin.end(JSON.stringify(args));
  });return result(JSON.parse(output));
});
async function vncAction(values) {
  const script=fileURLToPath(new URL('./vnc.py',import.meta.url));
  const output=await new Promise((resolve,reject)=>{
    const child=execFile(process.env.RPA_HOST_PYTHON || 'python',[script],{timeout:180000,maxBuffer:1024*1024},(error,stdout,stderr)=>{
      if(error && !stdout)reject(new Error(stderr || error.message));else resolve(stdout);
    });child.stdin.end(JSON.stringify(values));
  });return JSON.parse(output);
}
const initialVncProbe=vncAction(process.env.VAMP_VBOX_VNC_EXTPACK ?
  {action:'setup',extpack_path:process.env.VAMP_VBOX_VNC_EXTPACK,sha256:process.env.VAMP_VBOX_VNC_SHA256,allow_install:true} :
  {action:'probe'}).catch(error=>({status:'error',error_summary:error.message}));
server.tool('vm_vnc_setup','Inspect the open-source VNC module or install a user-selected matching package with a verified SHA-256, then configure loopback VNC for one powered-off VM. Does not install Oracle paid VRDP.',{
  vm:z.string().min(1).optional(),extpack_path:z.string().optional(),sha256:z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),allow_install:z.boolean().default(false),port:z.number().int().min(1024).max(65535).default(5901),
},async args=>result(await vncAction({action:'setup',...args})));
server.tool('vamp_setup','First-run setup: check VirtualBox, show current resource profiles and ask about Debian default or optional Windows; no installation/VM mutation.',{},async()=>{
  let installed=false,version='';
  try { version=(await vboxManage('--version')).trim(); installed=true; } catch {}
  const {readFile}=await import('node:fs/promises');
  const profiles=JSON.parse(await readFile(new URL('./profiles.json',import.meta.url),'utf8'));
  return result({status:'needs_user_input',virtualbox_installed:installed,virtualbox_version:version,
    default_guest:'debian',profiles:profiles.profiles,vnc:await initialVncProbe,
    questions:['At this session, take a snapshot before changes? It uses additional disk space and only preserves the captured point in time.','Set up the VM environment now?','Provide the host OS installation ISO path. Debian is the default.','Create a Windows VM too? Recommend it when your certificate workflow needs Windows-only security software.'],
    windows_notice:'Windows requires a valid license. Activate it yourself after installation. No license is included.',
    public_credentials:{username:'vboxuser',password:'password123!'},
    install_guide:'https://www.virtualbox.org/wiki/Downloads',
    next_action:installed?'After user setup consent and ISO/spec confirmation, call vm_create once.':'Guide the user to install VirtualBox for the host OS, or use an authorized host-install workflow. Recheck --version before VM creation.',
    vm_created:false});
});
server.tool('vm_list', 'List registered VirtualBox VMs without starting them', {}, async () =>
  result(parseVMList(await vboxManage('list', 'vms'))));
server.tool('vm_info', 'Read VM configuration/state', {vm: z.string().min(1)}, async ({vm}) =>
  result(parseMachineReadable(await vboxManage('showvminfo', vm, '--machinereadable'))));
async function prepareShareOnStart(vm) {
  const script=fileURLToPath(new URL('./shares.py',import.meta.url));
  const output=await new Promise((resolve,reject)=>{
    const child=execFile(process.env.RPA_HOST_PYTHON || 'python',[script],{timeout:90000},(error,stdout,stderr)=>{
      if(error)reject(new Error(stdout || stderr || error.message));else resolve(stdout);
    });child.stdin.end(JSON.stringify({vm,action:'prepare'}));
  });return JSON.parse(output);
}
server.tool('vm_start', 'Explicitly start an existing VM with detachable observation UI by default', {
  vm: z.string().min(1), type: z.enum(['separate','headless','gui']).default('separate'),
}, async ({vm,type}) => {
  const state = parseMachineReadable(await vboxManage('showvminfo',vm,'--machinereadable')).VMState;
  if (state === 'running') return result({status:'already_running',vm,display:await displayAction('configure',{vm})});
  if (!['poweroff','saved','aborted'].includes(state)) throw new Error(`Cannot start VM in state ${state}`);
  const display=await displayAction('configure',{vm});
  const recording_share=state==='saved'?null:await prepareShareOnStart(vm);
  await vboxManage('startvm',vm,'--type',type);
  return result({status:'start_requested',vm,type,display,recording_share,guest_ready_verified:false});
});
registerDisplayTools(server);
registerInputTools(server);
server.tool('vm_create', 'Create a NEW Debian/Windows11 VM from a host ISO, start unattended installation with separate UI. PUBLIC defaults vboxuser/password123!. Returns started, not installed. Recorder setup is scripted.', {
  name:z.string().min(1).optional(), iso_path:z.string().min(1),
  memory_mb:z.number().int().optional(), cpus:z.number().int().optional(),
  disk_mb:z.number().int().optional(), basedir:z.string().optional(),
  image_index:z.number().int().default(1), product_key:z.string().default(''),
  guest_os:z.enum(['debian','windows11','ubuntu']).optional(), windows_confirmed:z.boolean().default(false), preflight_only:z.boolean().default(false),
}, async (args) => {
  const python=process.env.RPA_HOST_PYTHON || 'python';
  const script=fileURLToPath(new URL('./provision.py',import.meta.url));
  const output=await new Promise((resolve,reject)=>{
    const child=execFile(python,[script,'--json-stdin'],{timeout:420000},(error,stdout,stderr)=>{
      if(error) reject(new Error(stdout || stderr || error.message)); else resolve(stdout);
    });
    child.stdin.end(JSON.stringify(args));
  });
  return result(JSON.parse(output));
});
server.tool('vm_prepare_recorder' , 'Build guest recorder ISO; optionally attach to an empty DVD slot of an OFF VM. Does not run installer or record.', {
  vm: z.string().optional(), controller: z.string().optional(),
  port: z.number().int().min(0).default(1), device: z.number().int().min(0).default(0),
}, async ({vm,controller,port,device}) => {
  if (controller && !vm) throw new Error('vm is required when attaching recorder media');
  if (controller) {
    const info = parseMachineReadable(await vboxManage('showvminfo',vm,'--machinereadable'));
    if (info.VMState !== 'poweroff') throw new Error('Attach recorder media during setup with VM powered off');
    if (!Object.entries(info).some(([key,value])=>key.startsWith('storagecontrollername') && value===controller))
      throw new Error('Storage controller does not exist; inspect vm_info first');
    const occupied = info[`${controller}-${port}-${device}`];
    if (occupied && !['none','emptydrive'].includes(occupied)) throw new Error('Refusing to replace occupied storage slot');
  }
  const python = process.env.RPA_HOST_PYTHON || process.env.PYTHON_PATH || 'python';
  const builder = fileURLToPath(new URL('../../scripts/build_recorder_media.py',import.meta.url));
  const {stdout} = await promisify(execFile)(python,[builder],{timeout:60000});
  const media = JSON.parse(stdout);
  if (controller) {
    await vboxManage('storageattach',vm,'--storagectl',controller,'--port',String(port),'--device',String(device),
      '--type','dvddrive','--medium',media.iso);
    media.attached_to = vm;
  }
  return result(media);
});
await server.connect(new StdioServerTransport());
console.error('VM RPA VirtualBox stdio server ready');
