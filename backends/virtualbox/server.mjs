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
const server = new McpServer({name: 'VAMP', version: '1.0.0'});
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
server.tool('vm_list', 'List registered VirtualBox VMs without starting them', {}, async () =>
  result(parseVMList(await vboxManage('list', 'vms'))));
server.tool('vm_info', 'Read VM configuration/state', {vm: z.string().min(1)}, async ({vm}) =>
  result(parseMachineReadable(await vboxManage('showvminfo', vm, '--machinereadable'))));
server.tool('vm_start', 'Explicitly start an existing VM with detachable observation UI by default', {
  vm: z.string().min(1), type: z.enum(['separate','headless','gui']).default('separate'),
}, async ({vm,type}) => {
  const state = parseMachineReadable(await vboxManage('showvminfo',vm,'--machinereadable')).VMState;
  if (state === 'running') return result({status:'already_running',vm,display:await displayAction('configure',{vm})});
  if (!['poweroff','saved','aborted'].includes(state)) throw new Error(`Cannot start VM in state ${state}`);
  const display=await displayAction('configure',{vm});
  await vboxManage('startvm',vm,'--type',type);
  return result({status:'start_requested',vm,type,display,guest_ready_verified:false});
});
registerDisplayTools(server);
registerInputTools(server);
server.tool('vm_create', 'Create a NEW Debian/Windows11 VM from a host ISO, start unattended installation with separate UI. PUBLIC defaults vboxuser/password123!. Returns started, not installed. Recorder setup is scripted.', {
  name:z.string().min(1).optional(), iso_path:z.string().min(1),
  memory_mb:z.number().int().default(4096), cpus:z.number().int().default(2),
  disk_mb:z.number().int().default(65536), basedir:z.string().optional(),
  image_index:z.number().int().default(1), product_key:z.string().default(''),
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
