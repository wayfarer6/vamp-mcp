import {McpServer} from '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import {StdioServerTransport} from '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import {z} from '../../third_party/mcp-virtualbox/node_modules/zod/index.js';
import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import visionPreload from '../common/vision-preload.cjs';
import packerModule from '../common/packer.cjs';
import {runWithVault} from './vault-replay.mjs';
const runtime=fileURLToPath(new URL('../../',import.meta.url));
const runGit=promisify(execFile);
const root=process.env.VAMP_RPA_REGISTRY;
export const libraryInstructions = 'RPA-FIRST WORKFLOW: Before using repeated CUA, screenshots, OCR, YOLO or multimodal reasoning, search saved skills with rpa_search using the task goal keywords. Match title, description, when_to_use, backend and input names. Read rpa_details for a likely match. Prefer a reviewed reusable RPA when it satisfies the user task and authorization. Run it with rpa_run_saved only with an explicit VM UUID, exact declared inputs and confirmed=true after authorization. Never run unreviewed or changed source. Read the compact result first; no screenshot is emitted automatically. Token efficiency: run reusable RPA and outcome checks locally; on success return compact status, verification and evidence paths. Do not forward full OCR text, YOLO arrays, unchanged screenshots, base64 images, full logs or source into the model context by default. For failure, ambiguity, UI changes or requested inspection, read only a targeted region/query/page first. Local OCR/YOLO reduces model tokens only when outputs stay local or compact; do not claim a measured saving without a comparable benchmark. When authoring or repairing GUI RPAs, include task-specific local OCR/YOLO verification in Python and assert its result in Robot by default; add artifact checks when available. Input dispatch or an arbitrary detection alone is not success. completed_unverified means actions completed, not proof of application success. Use the expected result to verify, and fall back to targeted CUA/multimodal only when no suitable RPA exists, execution fails or verification needs it. Do not force a mismatched workflow just to save tokens. When a saved RPA fails and the user authorizes repair, use rpa_revision to inspect its latest source and commit a validated update with an expected commit. Never overwrite uncommitted user edits. Repairs require user review before another run. Hyper-V desktop replay is unsupported.';
export function registerLibraryTools(server){
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const identifier=z.string().uuid();
async function definition(id){if(!root)throw Error('Open VAMP RPA Library in VS Code first.');const item=JSON.parse(await readFile(path.join(root,id,'rpa.json'),'utf8'));if(item.id!==id||item.format!=='vamp-saved-rpa')throw Error('Unknown saved RPA');return item;}
async function definitions(){if(!root)return [];let names;try{names=await readdir(root);}catch(error){if(error.code==='ENOENT')return [];throw error;}const rows=[];for(const id of names.slice(0,2000)){if(!/^[a-f0-9-]{36}$/i.test(id))continue;try{rows.push(await definition(id));}catch{}}return rows;}
const summary=i=>({id:i.id,title:i.name,description:i.description.slice(0,500),when_to_use:i.when_to_use.slice(0,250),tags:i.tags,backend:i.backend,inputs:i.inputs,reviewed:i.reviewed});
server.tool('rpa_search','Find reusable saved RPA skills by title, description, use case and tags before spending tokens on CUA or multimodal screen analysis.',{query:z.string().max(500).default(''),backend:z.enum(['virtualbox','kvm']).optional(),limit:z.number().int().min(1).max(10).default(5)},{readOnlyHint:true,destructiveHint:false},async({query,backend,limit})=>{
 const terms=query.toLowerCase().split(/\s+/).filter(Boolean);let rows=(await definitions()).filter(i=>!backend||i.backend===backend).map(i=>({item:i,score:terms.reduce((score,term)=>score+(i.name.toLowerCase().includes(term)?4:0)+(i.description.toLowerCase().includes(term)?2:0)+(i.tags.join(' ').toLowerCase().includes(term)?3:0)+(i.when_to_use.toLowerCase().includes(term)?1:0),0)})).filter(row=>!terms.length||row.score>0).sort((a,b)=>b.score-a.score);
 return result({status:'observed',total_matches:rows.length,rpas:rows.slice(0,limit).map(row=>summary(row.item)),next_step:'Read rpa_details for the best match; use reviewed RPA skills before repeated CUA.'});
});
server.tool('rpa_details','Read a saved skill’s purpose, input contract, guest resolution, review state and expected result. Does not return source or recorded text.',{id:identifier},{readOnlyHint:true,destructiveHint:false},async({id})=>{const i=await definition(id);return result({...summary(i),description:i.description,when_to_use:i.when_to_use,expected_result:i.expected_result,start_screen_check:Boolean(i.start_text),resolution:i.resolution,action_count:i.action_count,execution_status:'not_requested'});});
server.tool('rpa_run_saved','Replay one reviewed saved skill on guest devices. Explicit authorization and target VM UUID required for execution. Use dry_run to inspect reviewed Vault references without guest input or secret reads. An authenticated Vault replay bridge is required to use vault_destination.',{id:identifier,vm_id:identifier,inputs:z.record(z.string()).default({}),confirmed:z.boolean().default(false),dry_run:z.boolean().default(false),vault_destination:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).optional()},{readOnlyHint:false,destructiveHint:true},async request=>{
 const metadata=await definition(request.id);if(!metadata.reviewed||(!request.confirmed&&!request.dry_run))return result({status:'needs_review_or_confirmation',message:'Review and approve this definition in the VAMP RPA Library, then explicitly authorize execution.'});
 const python=metadata.backend==='virtualbox'?(process.env.RPA_REPLAY_PYTHON||process.env.RPA_HOST_PYTHON):process.env.RPA_HOST_PYTHON;
 if(!python)return result({status:'needs_setup',message:'Run VAMP Python setup in VS Code first.'});
 const script=await packerModule.resolveRuntimeAsset(runtime,'backends/library/replay.py');
 const payload={...request,registry:root,libvirt_uri:process.env.VAMP_LIBVIRT_URI||'qemu:///session'};
 if(request.vault_destination&&!request.dry_run)return result(await runWithVault(python,script,payload,{
  socketPath:process.env.VAULT_RPA_BRIDGE_SOCKET,token:process.env.VAULT_RPA_BRIDGE_TOKEN,
 }));
 return result(await new Promise(resolve=>{
  const child=execFile(python,[script],{windowsHide:true,timeout:610000,maxBuffer:1024*1024},(error,stdout,stderr)=>{try{resolve(JSON.parse(stdout));}catch{resolve({status:'error',message:error?String(stderr||error.message).slice(0,500):'Invalid replay result'});}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
 }));
});
server.tool('rpa_revision','Inspect, statically validate, test in a configured VirtualBox scratch guest, or commit an authorized RPA repair. Scratch tests check the resulting screen and leave the saved revision unchanged. Committed repairs require review.',{
 id:identifier,action:z.enum(['status','read-source','validate','test','update']).default('status'),source:z.string().max(64000).optional(),expected_commit:z.string().regex(/^[a-f0-9]{40}$/).optional(),commit_message:z.string().max(200).optional(),confirmed:z.boolean().default(false),
 scratch_vm:identifier.optional(),outcome_text:z.string().trim().min(1).max(240).optional(),
 test_inputs:z.record(z.string().max(10000)).optional(),
},{readOnlyHint:false,destructiveHint:true},async request=>{
 const item=await definition(request.id),folder=path.join(root,request.id);
 const latest=(await runGit('git',['-C',folder,'rev-parse','HEAD'],{timeout:15000})).stdout.trim();
 if(request.action==='status'){
  const history=(await runGit('git',['-C',folder,'log','-5','--format=%h %s'],{timeout:15000})).stdout.trim();
  return result({id:item.id,version:item.version,latest_commit:latest,history:history.split('\n')});
 }
 if(request.action==='read-source')return result({id:item.id,version:item.version,commit:latest,source:(await runGit('git',['-C',folder,'show','HEAD:source.py'],{timeout:15000,maxBuffer:5*1024*1024})).stdout,requires_review:true});
 const testing=request.action==='test';
 if(((request.action==='update'||testing)&&!request.confirmed)||!request.source||!request.expected_commit)return result({status:'needs_authorized_revision',message:'Provide source and expected_commit. Testing or committing requires confirmed:true.'});
 if(testing&&(item.backend!=='virtualbox'||!request.scratch_vm||!request.outcome_text))return result({status:'needs_scratch_setup',message:'Provide the configured VirtualBox scratch VM UUID and exact expected outcome text.'});
 const python=testing ? process.env.RPA_REPLAY_PYTHON||process.env.RPA_HOST_PYTHON : process.env.RPA_HOST_PYTHON||'python3';
 if(!python)return result({status:'needs_setup',message:'Configure the VirtualBox replay Python first.'});
 if(latest!==request.expected_commit)return result({status:'revision_conflict',message:'Read the new latest revision before editing.'});
 if((await runGit('git',['-C',folder,'status','--porcelain','--untracked-files=no'],{timeout:15000})).stdout.trim())return result({status:'uncommitted_changes',message:'Preserve or commit the user’s working changes before an AI repair.'});
 const temporary=await mkdtemp(path.join(os.tmpdir(),'vamp-repair-'));
 try{
  const source=path.join(temporary,'source.py');await writeFile(source,request.source,{mode:0o600});
  const payload={registry:root,id:item.id,source_path:source,title:item.name,description:item.description,when_to_use:item.when_to_use,expected_result:item.expected_result,start_text:item.start_text||'',tags:item.tags,inputs:item.inputs,backend:item.backend,width:item.resolution[0],height:item.resolution[1],reviewed:false,expected_commit:request.expected_commit,commit_message:request.commit_message||'AI repair: '+item.name,validate_only:request.action==='validate'};
  if(testing)Object.assign(payload,{test_only:true,scratch_vm:request.scratch_vm,outcome_text:request.outcome_text,test_inputs:request.test_inputs});
  const script=await packerModule.resolveRuntimeAsset(runtime,'backends/library/registry.py');
  const repaired=await new Promise(resolve=>{const child=execFile(python,[script],{windowsHide:true,timeout:testing?620000:45000,maxBuffer:1024*1024},(error,stdout,stderr)=>{try{resolve(JSON.parse(stdout));}catch{resolve({status:'error',message:String(stderr||error?.message||'Invalid repair response').slice(0,500)});}});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));});
  return result(repaired.status==='registered'?{status:'committed_needs_review',id:item.id,version:repaired.definition.version,commit:repaired.commit,reviewed:false}:repaired);
 }finally{await rm(temporary,{recursive:true,force:true});}
});
return server;
}
if(path.basename(path.dirname(process.argv[1]||''))==='library'&&process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
const server=new McpServer({name:'VAMP library',version:'0.3.0'},{instructions:libraryInstructions});
registerLibraryTools(server);
// Warm the local OCR/YOLO workers so the first verification does not pay the
// model load. Detached from this process; a missing model environment is fine.
{
  const vision = visionPreload.ensureVisionServices({runtime: fileURLToPath(new URL('../../',import.meta.url)),logger:message=>console.error(message)});
  if (vision.status === 'started') console.error(`Vision workers starting (pid ${vision.pid})`);
  else if (vision.status === 'unavailable') console.error(`Vision workers unavailable: ${vision.reason}`);
}
await server.connect(new StdioServerTransport());
}
