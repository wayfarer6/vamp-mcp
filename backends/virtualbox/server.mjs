import path from 'node:path';
import os from 'node:os';
import packerModule from '../common/packer.cjs';
import hyperVUacModule from '../hyperv/uac.cjs';
// First-party MIT integration; upstream files remain unmodified.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerDisplayTools } from '../../third_party/mcp-virtualbox/dist/tools/display.js';
import { registerInputTools } from '../../third_party/mcp-virtualbox/dist/tools/input.js';
import guestBootstrap from '../common/guest-bootstrap.cjs';
import visionPreload from '../common/vision-preload.cjs';
import { registerScriptServerTools, startScriptServer } from '../../third_party/mcp-virtualbox/dist/tools/script-server.js';
import { vboxManage, parseVMList, parseMachineReadable } from '../../third_party/mcp-virtualbox/dist/vbox.js';
import { McpServer } from '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { StdioServerTransport } from '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import { z } from '../../third_party/mcp-virtualbox/node_modules/zod/index.js';
import { config as vboxConfig } from '../../third_party/mcp-virtualbox/dist/types.js';
const runtime=fileURLToPath(new URL('../../',import.meta.url));
const resolveVmScript=name=>packerModule.resolveRuntimeAsset(runtime,'backends/virtualbox/'+name);
const mouseHelper=()=>process.env.MOUSE_HELPER_PATH || resolveVmScript('mouse_click.py');
vboxConfig.pythonPath=process.env.PYTHON_PATH || process.env.RPA_HOST_PYTHON || (process.platform==='win32'?'python':'python3');
export const virtualBoxInstructions = 'Before recording or coordinate-based guest automation, verify the actual guest framebuffer is 1920x1080 with 100% guest scaling. If different, adjust the guest display using the authorized backend and verify fresh evidence before continuing; respect user pauses. A resized viewer is not proof. If the guest display drifts, use the guest-local reset shortcut: Windows Desktop Set-Resolution-1920x1080.cmd or Debian home ~/set-resolution-1920x1080.sh. Do not run guest commands on the host. Read skills/vamp-rpa-ui-checks/references/display.md in the packaged runtime (or .agents/skills/vamp-rpa-ui-checks/references/display.md in the repository) for Linux and Windows guidance. Before repeated CUA or multimodal analysis, use VAMP RPA Library rpa_search/rpa_details to find suitable reviewed skills. Prefer an authorized compatible skill; read its compact result before requesting screenshots, and verify application outcomes. Token efficiency: run reusable RPA and outcome checks locally; on success return compact status, verification and evidence paths. Do not forward full OCR text, YOLO arrays, unchanged screenshots, base64 images, full logs or source into the model context by default. For failure, ambiguity, UI changes or requested inspection, read only a targeted region/query/page first. Local OCR/YOLO reduces model tokens only when outputs stay local or compact; do not claim a measured saving without a comparable benchmark. When authoring or repairing GUI RPAs, include task-specific local OCR/YOLO verification in Python and assert its result in Robot by default; add artifact checks when available. Input dispatch or an arbitrary detection alone is not success. Fall back to targeted CUA when needed. For first-time setup call vamp_setup. Ask whether to set up the VM environment and obtain a host ISO path. Ask once each session whether to take a snapshot, explain space use, and never assume consent. Debian is default; ask explicitly before Windows and disclose licensing and public sandbox credentials. Do not create a VM merely on server startup. Guest setup scripts are served over HTTP from the host Python script server on port 8421; guests install them with wget/curl (vm_script_server_start/status/stop). New VM installations use HashiCorp Packer and official hypervisor plugins. Windows guest setup runs as administrator with Unrestricted process execution policy, installs VirtualBox Guest Additions or KVM virtio-win guest drivers and resumes after the driver reboot before reporting completion. Explain the CLI/plugin downloads, large golden images plus separate live disks, public sandbox autologin, and the 60-second post-reboot setup wait. Windows answer media is generated with an isolated pycdlib helper; original ISOs are not rewritten.';
export function registerVirtualBoxTools(server){
const result = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
async function displayAction(action,values) {
  const python=process.env.RPA_HOST_PYTHON || 'python';
  const script=await resolveVmScript('display.py');
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
  const script=await resolveVmScript('history.py');
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
  const script=await resolveVmScript('shares.py');
  const args=action==='prepare'?{vm,action}:{vm,action,filename,offset,limit};
  const output=await new Promise((resolve,reject)=>{
    const child=execFile(python,[script],{timeout:90000},(error,stdout,stderr)=>{
      if(error)reject(new Error(stdout || stderr || error.message));else resolve(stdout);
    });child.stdin.end(JSON.stringify(args));
  });return result(JSON.parse(output));
});
async function transferAction(action,values) {
  const script=await resolveVmScript('transfers.py');
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
  const script=await resolveVmScript('recordings.py');
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
  const script=await resolveVmScript('snapshots.py');
  const output=await new Promise((resolve,reject)=>{
    const child=execFile(python,[script],{timeout:330000},(error,stdout,stderr)=>{
      if(error) reject(new Error(stdout || stderr || error.message)); else resolve(stdout);
    });child.stdin.end(JSON.stringify(args));
  });return result(JSON.parse(output));
});
async function vncAction(values) {
  const script=await resolveVmScript('vnc.py');
  const output=await new Promise((resolve,reject)=>{
    const child=execFile(process.env.RPA_HOST_PYTHON || 'python',[script],{timeout:180000,maxBuffer:1024*1024},(error,stdout,stderr)=>{
      if(error && !stdout)reject(new Error(stderr || error.message));else resolve(stdout);
    });child.stdin.end(JSON.stringify(values));
  });return JSON.parse(output);
}
const initialVncProbe=()=>vncAction(process.env.VAMP_VBOX_VNC_EXTPACK ?
  {action:'setup',extpack_path:process.env.VAMP_VBOX_VNC_EXTPACK,sha256:process.env.VAMP_VBOX_VNC_SHA256,allow_install:true} :
  {action:'probe'}).catch(error=>({status:'error',error_summary:error.message}));
server.tool('vm_vnc_setup','Inspect the open-source VNC module or install a user-selected matching package with a verified SHA-256, then configure loopback VNC for one powered-off VM. Does not install Oracle paid VRDP.',{
  vm:z.string().min(1).optional(),extpack_path:z.string().optional(),sha256:z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),allow_install:z.boolean().default(false),port:z.number().int().min(1024).max(65535).default(5901),
},async args=>result(await vncAction({action:'setup',...args})));
server.tool('vamp_setup','First-run setup: check VirtualBox, show current resource profiles and ask about Debian default or optional Windows; no installation/VM mutation.',{},async()=>{
  let installed=false,version='';
  try { version=(await vboxManage('--version')).trim(); installed=true; } catch {}
  const {readFile}=await import('node:fs/promises');
  const profiles=JSON.parse(await readFile(new URL('../virtualbox/profiles.json',import.meta.url),'utf8'));
  return result({status:'needs_user_input',virtualbox_installed:installed,virtualbox_version:version,
    installation_engine:'HashiCorp Packer',packer_notice:'Preparation downloads the managed Packer CLI and official VirtualBox plugin. Builds create large golden images and separate live disks, and wait 60 seconds after first reboot for post-install setup. Debian uses public sandbox autologin.',default_guest:'debian',profiles:profiles.profiles,vnc:await initialVncProbe(),
    questions:['At this session, take a snapshot before changes? It uses additional disk space and only preserves the captured point in time.','Set up the VM environment now?','Provide the host OS installation ISO path. Debian is the default.','Create a Windows VM too? Recommend it when your certificate workflow needs Windows-only security software.'],
    windows_notice:'Windows requires a valid license. Activate it yourself after installation. No license is included.',
    public_credentials:{username:'vboxuser',password:'password123!'},
    install_guide:'https://www.virtualbox.org/wiki/Downloads',
    next_action:installed?'After setup consent call vm_packer_prepare, then confirm ISO/specs and call vm_create once. Use vm_golden_images for build completion and storage paths.':'Guide the user to install VirtualBox for the host OS, or use an authorized host-install workflow. Recheck --version before VM creation.',
    vm_created:false});
});
server.tool('vm_list', 'List registered VirtualBox VMs without starting them', {}, async () =>
  result(parseVMList(await vboxManage('list', 'vms'))));
server.tool('vm_info', 'Read VM configuration/state', {vm: z.string().min(1)}, async ({vm}) =>
  result(parseMachineReadable(await vboxManage('showvminfo', vm, '--machinereadable'))));
async function prepareShareOnStart(vm) {
  const script=await resolveVmScript('shares.py');
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
  if(process.platform==='linux'){
    for(const uri of ['qemu:///session','qemu:///system']){
      let active='';try{active=(await promisify(execFile)('virsh',['-c',uri,'list','--name'],{timeout:10000})).stdout;}catch{}
      if(active.trim())throw new Error('A KVM VM is active. Shut it down before starting VirtualBox (VERR_SVM_IN_USE).');
    }
  }
  await vboxManage('startvm',vm,'--type',type);
  const started=parseMachineReadable(await vboxManage('showvminfo',vm,'--machinereadable')).VMState;
  if(started!=='running')throw new Error('VM did not reach Running state: '+started);
  return result({status:'start_requested',vm,type,display,recording_share,guest_ready_verified:false});
});
registerDisplayTools(server);
registerInputTools(server,mouseHelper);
server.tool('vm_guest_bootstrap','Run guest setup with the same bootstrap as VSIX. Windows opens administrator PowerShell via Ctrl+Shift+Enter, approves UAC with Left/Enter and sets Unrestricted execution policy for the process. Delivery is not proof of setup completion.',{
  vm:z.string().min(1),os:z.enum(['windows11','debian']).default('windows11'),command:z.string().optional(),
  bootWaitSec:z.number().min(0).default(30),clickX:z.number().default(960),clickY:z.number().default(540),
  dryRun:z.boolean().default(false),focusClick:z.boolean().default(true),openTerminal:z.boolean().default(false),username:z.string().optional(),password:z.string().optional(),
  chunkSize:z.number().int().min(1).max(100).default(50),keyDelayMs:z.number().min(0).default(30),serveScripts:z.boolean().default(true),scriptServerUrl:z.string().optional(),
},async args=>{
  if(!args.dryRun){
    const state=parseMachineReadable(await vboxManage('showvminfo',args.vm,'--machinereadable')).VMState;
    if(!['running','paused'].includes(state))throw Error('Start the guest before injecting setup.');
    if(args.serveScripts)await startScriptServer();
  }
  const report=await guestBootstrap.runGuestBootstrap(args,{
    vbox:argv=>vboxManage(...argv),
    click:async(x,y)=>{const helper=await mouseHelper();return new Promise((resolve,reject)=>execFile(vboxConfig.pythonPath,[helper,args.vm,String(x),String(y),'left'],{windowsHide:true,timeout:30000},error=>error?reject(error):resolve()));},
  });
  return {...result(report),isError:report.status==='failed'};
});
registerScriptServerTools(server);
const hyperVUac=hyperVUacModule.createHyperVUac();
server.tool('hyperv_permission_diagnosis','Windows-only, fixed read-only Hyper-V permission check. With explicit user authorization and confirmed:true, opens one native UAC dialog. The user must approve it personally and read the separate console. Does not start a VM, elevate the MCP server or prove the non-elevated builder has access.',{
  confirmed:z.boolean().default(false)
}, {readOnlyHint:false,destructiveHint:false,openWorldHint:false}, async args=>result(await hyperVUac.request(args)));

server.tool('vm_create', 'Create a NEW VM through HashiCorp Packer: install CLI and official plugin, build OS and post-install scripts, wait 60s after reboot, export a golden image and deploy a separate live disk. Returns queued; use vm_golden_images for status/paths. Hyper-V Debian uses a local answer ISO and a fixed-address Vagrant SSH profile. Other Debian sandbox builds use public autologin vboxuser/password123!.', {
  backend:z.enum(['virtualbox','hyperv','kvm']).default('virtualbox'),switch_name:z.string().min(1).optional(),bootstrap_host:z.ipv4().optional().describe('Optional guest-reachable IPv4 for Packer bootstrap on Hyper-V or KVM. Hyper-V requires an address on the selected virtual switch; default KVM uses QEMU user-mode NAT.'),libvirt_uri:z.enum(['qemu:///session','qemu:///system']).optional(),
  name:z.string().min(1).optional(), iso_path:z.string().min(1),
  memory_mb:z.number().int().optional(), cpus:z.number().int().optional(),
  disk_mb:z.number().int().optional(), basedir:z.string().optional(),
  image_index:z.number().int().default(1), product_key:z.string().default(''),
  hyperv_debian:z.object({switch:z.string().min(1),guest_ip:z.string().min(1),gateway:z.ipv4(),dns:z.ipv4(),
    dvd_sha256:z.string().regex(/^[a-fA-F0-9]{64}$/),ssh_private_key:z.string().min(1),
    hyperv_daemons_deb:z.string().min(1),hyperv_daemons_sha256:z.string().regex(/^[a-fA-F0-9]{64}$/)})
    .strict().optional().describe('DHCP-free Debian Hyper-V deployment profile. Uses an internal switch and a reserved static guest IPv4. Omit to read VAMP_HYPERV_DEBIAN_CONFIG.'),
  guest_os:z.enum(['debian','windows11']).default('debian'), allow_manual_install:z.boolean().default(true), installation_mode:z.enum(['auto']).default('auto'), windows_confirmed:z.boolean().default(false), preflight_only:z.boolean().default(false),
  serve_scripts:z.boolean().default(true).describe('Start the host Python HTTP script server on port 8421 so the guest installs the recorder with wget/curl'),
}, async (args) => {
  const output=await packerCall('create',args);
  return result(output);
});
const packerCall=packerModule.packer({runtime:fileURLToPath(new URL('../../',import.meta.url))});
server.tool('vm_packer_prepare','Download checksum-pinned HashiCorp Packer CLI for this host and install the selected official hypervisor plugin. Does not create a VM.',{backend:z.enum(['virtualbox','hyperv','kvm']).default('virtualbox')},async args=>result(await packerCall('prepare',args)));
server.tool('vm_golden_images','List Packer build status, golden image IDs, absolute file paths, byte sizes and log paths. Live VM disks are stored separately.',{},async()=>result(await packerCall('images')));
server.tool('vm_golden_image_import','Create a stopped VirtualBox VM with its own disk from a completed golden image. Select id using vm_golden_images and choose a unique VM name. Without confirmed, preview the source and destination. Use confirmed:true after user authorization.',{
  id:z.string().regex(/^[a-f0-9]{32}$/),name:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/),confirmed:z.boolean().default(false),
},async args=>result(await packerCall('import-image',args)));
server.tool('vm_golden_image_delete','Permanently delete one VAMP golden image and build logs by ID. Call without confirmed first to inspect its path/size, then obtain explicit user approval. Live VM disks remain separate.',{id:z.string().regex(/^[a-f0-9]{32}$/),confirmed:z.boolean().default(false)},async args=>result(await packerCall('delete-image',args)));
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
  const assets = await globalThis[Symbol.for('vamp.provisioningAssets')]?.();
  const builder = assets ? path.join(assets,'scripts/build_recorder_media.py')
    : fileURLToPath(new URL('../../scripts/build_recorder_media.py',import.meta.url));
  const output = assets ? ['--output',path.join(process.env.VAMP_HOME || path.join(os.homedir(),'.vamp'),'artifacts','recorder-setup.iso')] : [];
  const {stdout} = await promisify(execFile)(python,[builder,...output],{timeout:60000});
  const media = JSON.parse(stdout);
  if (controller) {
    await vboxManage('storageattach',vm,'--storagectl',controller,'--port',String(port),'--device',String(device),
      '--type','dvddrive','--medium',media.iso);
    media.attached_to = vm;
  }
  return result(media);
});
return server;
}
if(path.basename(path.dirname(process.argv[1]||''))==='virtualbox'&&process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
const {default:windowsAdmin}=await import('../common/windows-admin.cjs');
try { await windowsAdmin.requireAdministrator(); }
catch (error) { console.error(error.message); process.exit(1); }
const server=new McpServer({name:'VAMP virtualbox',version:'0.3.9'},{instructions:virtualBoxInstructions});
registerVirtualBoxTools(server);
// Warm the local OCR/YOLO workers in the background. Detached, never blocking
// stdio, and harmless when this host has no model environment.
{
  const vision = visionPreload.ensureVisionServices({runtime: fileURLToPath(new URL('../../',import.meta.url)),logger:message=>console.error(message)});
  if (vision.status === 'started') console.error(`Vision workers starting (pid ${vision.pid})`);
  else if (vision.status === 'unavailable') console.error(`Vision workers unavailable: ${vision.reason}`);
}
await server.connect(new StdioServerTransport());
console.error('VM RPA VirtualBox stdio server ready');
}
