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
import clickSettings from './click-settings.cjs';
import audit from '../common/audit.cjs';
import cliCatalogModule from './cli-catalog.cjs';
import cliRunsModule from './cli-runs.cjs';
import visionPreload from '../common/vision-preload.cjs';
import packerModule from '../common/packer.cjs';
import {runWithVault} from './vault-replay.mjs';
const runtime=fileURLToPath(new URL('../../',import.meta.url));
const runGit=promisify(execFile);
const root=process.env.VAMP_RPA_REGISTRY;
const pythonJsonEnv={...process.env,PYTHONIOENCODING:'utf-8'};
export const libraryInstructions = 'For command-line and Playwright tasks, call rpa_search with execution_kind=cli_based, then rpa_details. Select a reviewed workspace, preview the declared inputs using cli_based_run_saved and obtain authorization. Submit the same revision and workspace with a fresh request_id. Poll cli_based_run_status for checks and artifact references. Reuse the same request_id when retrying the same request. The default search returns GUI recordings. ' +
'RPA-FIRST WORKFLOW: Before using repeated CUA, screenshots, OCR, YOLO or multimodal reasoning, search saved skills with rpa_search using the task goal keywords. Match title, description, when_to_use, backend and input names. Read rpa_details for a likely match. Prefer a reviewed reusable RPA when it satisfies the user task and authorization. Run it with rpa_run_saved only with an explicit VM UUID, exact declared inputs and confirmed=true after authorization. Never run unreviewed or changed source. Read the compact result first; no screenshot is emitted automatically. Token efficiency: run reusable RPA and outcome checks locally; on success return compact status, verification and evidence paths. Do not forward full OCR text, YOLO arrays, unchanged screenshots, base64 images, full logs or source into the model context by default. For failure, ambiguity, UI changes or requested inspection, read only a targeted region/query/page first. Local OCR/YOLO reduces model tokens only when outputs stay local or compact; do not claim a measured saving without a comparable benchmark. When authoring or repairing GUI RPAs, include task-specific local OCR/YOLO verification in Python and assert its result in Robot by default; add artifact checks when available. Input dispatch or an arbitrary detection alone is not success. completed_unverified means actions completed, not proof of application success. Use the expected result to verify, and fall back to targeted CUA/multimodal only when no suitable RPA exists, execution fails or verification needs it. Do not force a mismatched workflow just to save tokens. When a saved RPA fails and the user authorizes repair, use rpa_revision read-source and validate with expected_commit. For a configured VirtualBox scratch guest, use test-and-commit to verify a new OCR outcome, absence of the configured YOLO blocking modal, and the output file before committing. If those checks fail or the scratch guest is unavailable, report the result and leave the repair for review. Use update for a static-only commit only when the operator explicitly asks for that workflow. Never overwrite uncommitted user edits. Repairs require user review before another run. If a click is blocked, report the reason, score and threshold. Ask the user whether to fix the target, change the threshold or disable verification. Only change settings on explicit user request. Hyper-V desktop replay is unsupported.';
export function registerLibraryTools(server){
const cliCatalog=()=>cliCatalogModule.catalog(root);
const cliId=cliCatalogModule.uuid, runs=cliRunsModule.runs;
const cliResult=async fn=>{try{return result(await fn());}catch(e){return result({status:e.status||'library_error'});}};
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const identifier=z.string().uuid();
const store=()=>audit.ledger();
server.tool('audit_search','Search the local SQLite audit log. Combine timezone-qualified from (inclusive), to (exclusive), exact script name or UUID and agent ID. Default: last 24 hours.',audit.querySchema(z),{readOnlyHint:true},async filters=>result(await audit.search(store(),filters,root)));
server.tool('audit_run_details','Read events for one audit run or operation.',{run_id:identifier,before:z.number().int().positive().optional()},{readOnlyHint:true},async f=>result(store().search(f,true)));
server.tool('audit_coverage','Read local profile, retained event count and first and last observation.',{},{readOnlyHint:true},async(_,extra)=>result({...store().coverage(),current_agent:audit.identity(extra)}));
async function definition(id){if(!root)throw Error('Open VAMP RPA Library in VS Code first.');const item=JSON.parse(await readFile(path.join(root,id,'rpa.json'),'utf8'));if(item.id!==id||item.format!=='vamp-saved-rpa')throw Error('Unknown saved RPA');return item;}
async function definitions(){if(!root)return [];let names;try{names=await readdir(root);}catch(error){if(error.code==='ENOENT')return [];throw error;}const rows=[];for(const id of names.slice(0,2000)){if(!/^[a-f0-9-]{36}$/i.test(id))continue;try{rows.push(await definition(id));}catch{}}return rows;}
const summary=i=>({id:i.id,title:i.name,description:i.description.slice(0,500),when_to_use:i.when_to_use.slice(0,250),tags:i.tags,backend:i.backend,inputs:i.inputs,reviewed:i.reviewed});
server.tool('rpa_search','Find reusable saved RPA skills by title, description, use case and tags before spending tokens on CUA or multimodal screen analysis.',{query:z.string().max(500).default(''),execution_kind:z.enum(['cli_based','gui_recording']).optional(),backend:z.enum(['virtualbox','kvm']).optional(),limit:z.number().int().min(1).max(10).default(5)},{readOnlyHint:true,destructiveHint:false},async({query,backend,limit,execution_kind})=>{
 if(execution_kind==='cli_based')return cliResult(async()=>{
   if(backend)return {status:'invalid_filter'};
   if(!root)return {status:'observed',total_matches:0,rpas:[]};
   const repo=cliCatalog(),matches=[],terms=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
   const names=await readdir(root).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
   for(const id of names.filter(id=>cliId.test(id)).slice(0,2000)){
     const s=await repo.snapshot(id);if(!s)continue;
     const {name,description,when_to_use,tags}=s.pkg;
     const text=[name,description,when_to_use,...tags].join(' ').toLowerCase();
     const score=terms.filter(term=>text.includes(term)).length;
     if(!terms.length||score)matches.push({s,score});
   }
   matches.sort((a,b)=>b.score-a.score||a.s.pkg.name.localeCompare(b.s.pkg.name));
   return {status:'observed',total_matches:matches.length,rpas:await Promise.all(matches.slice(0,limit).map(row=>repo.details(row.s)))};
 });
 const terms=query.toLowerCase().split(/\s+/).filter(Boolean);let rows=(await definitions()).filter(i=>!backend||i.backend===backend).map(i=>({item:i,score:terms.reduce((score,term)=>score+(i.name.toLowerCase().includes(term)?4:0)+(i.description.toLowerCase().includes(term)?2:0)+(i.tags.join(' ').toLowerCase().includes(term)?3:0)+(i.when_to_use.toLowerCase().includes(term)?1:0),0)})).filter(row=>!terms.length||row.score>0).sort((a,b)=>b.score-a.score);
 return result({status:'observed',total_matches:rows.length,rpas:rows.slice(0,limit).map(row=>summary(row.item)),next_step:'Read rpa_details for the best match; use reviewed RPA skills before repeated CUA.'});
});
server.tool('rpa_click_settings','Read the catalog click verification percentage, or save a new default only when explicitly requested by the user. Zero turns verification off. For a single run use rpa_run_saved instead.',{minimum_percent:z.number().int().min(0).max(100).optional(),user_requested:z.boolean().optional()},async({minimum_percent,user_requested})=>{
 if(minimum_percent!==undefined && !user_requested)return result({status:'ask_user',message:'Ask whether to change the default for this catalog.'});
 const percent=minimum_percent===undefined?await clickSettings.read(root):await clickSettings.save(root,minimum_percent);
 return result({status:minimum_percent===undefined?'observed':'saved',minimum_percent:percent,enabled:percent>0,scope:'catalog'});
});
server.tool('rpa_details','Read a saved skill’s purpose, input contract, guest resolution, review state and expected result. Does not return source or recorded text.',{id:identifier},{readOnlyHint:true,destructiveHint:false},async({id})=>{if(root){const repo=cliCatalog(),s=await repo.snapshot(id);if(s)return result(await repo.details(s));}const i=await definition(id);return result({...summary(i),description:i.description,when_to_use:i.when_to_use,expected_result:i.expected_result,start_screen_check:Boolean(i.start_text),resolution:i.resolution,action_count:i.action_count,execution_status:'not_requested'});});
server.tool('cli_based_run_saved','Preview or run a reviewed CLI workflow in its bound VM workspace. Authorize the exact inputs before confirming.',{
 id:identifier,expected_revision:z.string().regex(/^[a-f0-9]{40}$/),workspace_id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
 inputs:z.record(z.string().max(10000)),mode:z.enum(['preview','run']).default('preview'),confirmed:z.boolean().default(false),request_id:identifier.optional()
},{readOnlyHint:false,destructiveHint:true},async (a,extra)=>cliResult(()=>runs(cliCatalog(),undefined,{actor:audit.identity(extra)}).start(a)));
server.tool('cli_based_run_status','Read the local status, verification checks and artifact references for one accepted run.',
 {run_id:identifier},{readOnlyHint:true},async a=>cliResult(()=>runs(cliCatalog()).status(a.run_id)));
server.tool('rpa_run_saved','Replay a reviewed saved skill. Enable pause_on_uac for Windows runs on VirtualBox or KVM with local VNC to check the guest screen between actions and hand off to the operator on a UAC prompt. With uac_wait_seconds and uac_resume_text, wait for the operator and resume only on the expected post-approval screen. Use dry_run to inspect Vault references without guest input or secret reads.',{id:identifier,vm_id:identifier,click_minimum_percent:z.number().int().min(0).max(100).optional().describe('User-requested override for this run only. 0 disables click verification.'),click_setting_user_requested:z.boolean().optional(),inputs:z.record(z.string()).default({}),expected_source_sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),confirmed:z.boolean().default(false),dry_run:z.boolean().default(false),pause_on_uac:z.boolean().default(false),uac_wait_seconds:z.number().int().min(0).max(120).default(0),uac_resume_text:z.string().trim().min(1).max(240).optional(),vault_destination:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).optional()},{readOnlyHint:false,destructiveHint:true},async (request,extra)=>audit.observe(store(),{category:'gui',action:request.dry_run?'preview':'replay',source:'mcp',script_id:request.id,...audit.identity(extra)},async runId=>{
 const respond=value=>result({...value,audit_run_id:runId});
 const metadata=await definition(request.id);if(!metadata.reviewed||(!request.confirmed&&!request.dry_run))return respond({status:'needs_review_or_confirmation',message:'Review and approve this definition in the VAMP RPA Library, then explicitly authorize execution.'});
 if(request.pause_on_uac&&!['virtualbox','kvm'].includes(metadata.backend))return respond({status:'unsupported',message:'Guest UAC handoff is available for Windows replay on VirtualBox or KVM with local VNC.'});
 const python=metadata.backend==='virtualbox'?(process.env.RPA_REPLAY_PYTHON||process.env.RPA_HOST_PYTHON):process.env.RPA_HOST_PYTHON;
 if(!python)return respond({status:'needs_setup',message:'Run VAMP Python setup in VS Code first.'});
 const script=await packerModule.resolveRuntimeAsset(runtime,'backends/library/replay.py');
 if(request.click_minimum_percent!==undefined&&!request.click_setting_user_requested)return respond({status:'ask_user',message:'Ask the user before changing click verification for this run.'});
 const click_minimum_percent=await clickSettings.forRun(root,request.click_minimum_percent,request.click_setting_user_requested);
 const payload={...request,click_minimum_percent,registry:root,libvirt_uri:process.env.VAMP_LIBVIRT_URI||'qemu:///session'};
 if(request.vault_destination&&!request.dry_run)return respond(await runWithVault(python,script,payload,{
  socketPath:process.env.VAULT_RPA_BRIDGE_SOCKET,token:process.env.VAULT_RPA_BRIDGE_TOKEN,auditContext:audit.correlation(),
 }));
 return respond(await new Promise(resolve=>{
  const child=execFile(python,[script],{env:pythonJsonEnv,windowsHide:true,timeout:610000,maxBuffer:1024*1024},(error,stdout,stderr)=>{try{resolve(JSON.parse(stdout));}catch{resolve({status:'error',message:error?String(stderr||error.message).slice(0,500):'Invalid replay result'});}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
 }));
}));
server.tool('rpa_revision','Inspect or validate an RPA repair. test checks the outcome screen in an isolated VirtualBox guest. test-and-commit requires a new OCR outcome, a passing configured YOLO modal check, and a verified output file before committing. update commits after static validation only. Every committed repair requires review.',{
 id:identifier,action:z.enum(['status','read-source','validate','test','test-and-commit','update']).default('status'),source:z.string().max(64000).optional(),expected_commit:z.string().regex(/^[a-f0-9]{40}$/).optional(),commit_message:z.string().max(200).optional(),confirmed:z.boolean().default(false),
 scratch_vm:identifier.optional(),outcome_text:z.string().trim().min(1).max(240).optional(),
 start_text:z.string().trim().min(1).max(240).optional(),
 test_inputs:z.record(z.string().max(10000)).optional(),
},{readOnlyHint:false,destructiveHint:true},async (request,extra)=>{
 const execute=async()=>{
 const item=await definition(request.id),folder=path.join(root,request.id);
 const latest=(await runGit('git',['-C',folder,'rev-parse','HEAD'],{timeout:15000})).stdout.trim();
 if(request.action==='status'){
  const history=(await runGit('git',['-C',folder,'log','-5','--format=%h %s'],{timeout:15000})).stdout.trim();
  return result({id:item.id,version:item.version,latest_commit:latest,history:history.split('\n')});
 }
 if(request.action==='read-source')return result({id:item.id,version:item.version,commit:latest,source:(await runGit('git',['-C',folder,'show','HEAD:source.py'],{timeout:15000,maxBuffer:5*1024*1024})).stdout,requires_review:true});
 const promote=request.action==='test-and-commit';
 const testing=request.action==='test'||promote;
 if(((request.action==='update'||testing)&&!request.confirmed)||!request.source||!request.expected_commit)return result({status:'needs_authorized_revision',message:'Provide source and expected_commit. Testing or committing requires confirmed:true.'});
 if(testing&&(item.backend!=='virtualbox'||!request.scratch_vm||!request.outcome_text))return result({status:'needs_scratch_setup',message:'Provide the configured VirtualBox scratch VM UUID and exact expected outcome text.'});
 const python=testing ? process.env.RPA_REPLAY_PYTHON||process.env.RPA_HOST_PYTHON : process.env.RPA_HOST_PYTHON||'python3';
 if(!python)return result({status:'needs_setup',message:'Configure the VirtualBox replay Python first.'});
 if(latest!==request.expected_commit)return result({status:'revision_conflict',message:'Read the new latest revision before editing.'});
 if((await runGit('git',['-C',folder,'status','--porcelain','--untracked-files=no'],{timeout:15000})).stdout.trim())return result({status:'uncommitted_changes',message:'Preserve or commit the user’s working changes before an AI repair.'});
 const temporary=await mkdtemp(path.join(os.tmpdir(),'vamp-repair-'));
 try{
  const source=path.join(temporary,'source.py');await writeFile(source,request.source,{mode:0o600});
  const payload={registry:root,id:item.id,source_path:source,title:item.name,description:item.description,when_to_use:item.when_to_use,expected_result:item.expected_result,start_text:request.start_text??item.start_text??'',tags:item.tags,inputs:item.inputs,backend:item.backend,width:item.resolution[0],height:item.resolution[1],reviewed:false,expected_commit:request.expected_commit,commit_message:request.commit_message||'AI repair: '+item.name,validate_only:request.action==='validate'};
  if(testing)Object.assign(payload,{test_only:true,commit_after_test:promote,scratch_vm:request.scratch_vm,outcome_text:request.outcome_text,test_inputs:request.test_inputs});
  const script=await packerModule.resolveRuntimeAsset(runtime,'backends/library/registry.py');
  const repaired=await new Promise(resolve=>{const child=execFile(python,[script],{env:pythonJsonEnv,windowsHide:true,timeout:testing?620000:45000,maxBuffer:1024*1024},(error,stdout,stderr)=>{try{resolve(JSON.parse(stdout));}catch{resolve({status:'error',message:String(stderr||error?.message||'Invalid repair response').slice(0,500)});}});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));});
  return result(repaired.status==='registered'?{status:'committed_needs_review',id:item.id,version:repaired.definition.version,commit:repaired.commit,reviewed:false}:repaired);
 }finally{await rm(temporary,{recursive:true,force:true});}
 };
 if(['test','test-and-commit'].includes(request.action))return audit.observe(store(),{category:'gui',action:'revision_test',script_id:request.id,revision:request.expected_commit,source:'mcp',...audit.identity(extra)},execute);
 return execute();
});
return server;
}
if(path.basename(path.dirname(process.argv[1]||''))==='library'&&process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
const {default:windowsAdmin}=await import('../common/windows-admin.cjs');
try { await windowsAdmin.requireAdministrator(); }
catch (error) { console.error(error.message); process.exit(1); }
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
