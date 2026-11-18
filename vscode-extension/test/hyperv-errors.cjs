const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createHyperVAdapter}=require('../../backends/hyperv/desktop.cjs');
const adapter=execute=>createHyperVAdapter({globalStorageUri:{fsPath:'/private'}},{runtime:'/private',platform:'win32',execute});
for(const code of ['hyperv_module_missing','hyperv_service_missing','hyperv_service_stopped','hyperv_access_denied']){
 test(code+' is sanitized',async()=>{
  await assert.rejects(adapter(async()=>{throw {stdout:JSON.stringify({status:'error',code}),stderr:'secret path RequestBase64 XXXXX'};}).check(),e=>e.code===code&&!/secret|XXXXX|RequestBase64/.test(e.message));
 });
}
test('policy fallback does not echo command, path or garbled stderr',async()=>{
 await assert.rejects(adapter(async()=>{throw {stderr:'� private-path about_Execution_Policies RequestBase64 XXX'};}).check(),e=>e.code==='hyperv_policy_blocked'&&!/private|XXX|�/.test(e.message));
});
test('unknown error remains generic, not falsely module missing',async()=>{
 await assert.rejects(adapter(async()=>{throw {stderr:'VirtualizationException private-path'};}).check(),e=>e.code==='hyperv_operation_failed'&&!/private-path/.test(e.message));
});
test('ready only from explicit machine status and UTF8 requested',async()=>{
 const a=adapter(async(exe,args,options)=>{assert.equal(options.encoding,'utf8');assert.ok(!args.includes('-ExecutionPolicy'));return {stdout:'{"status":"ready"}'};});
 assert.equal(await a.check(),'Hyper-V ready');
 await assert.rejects(adapter(async()=>({stdout:'{}'})).check());
});
test('Windows fallback is label only and requires no privileged query',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../vm-manager.js'),'utf8');
 const part=source.slice(source.indexOf('function unavailableEngineLabel'),source.indexOf('function buildNetworkOptions'));
 const fn=vm.runInNewContext(part+'; unavailableEngineLabel');
 assert.equal(fn('hyperv','win32',()=> '10.0.26100'),'Hyper-V · Windows 10.0.26100');
 assert.equal(fn('hyperv','linux',()=>{throw Error('must not read');}),undefined);
 assert.match(source,/version=undefined;\s*engineLabel=unavailableEngineLabel/);
 assert.match(source,/problem=engineLabel\?undefined:error.message/);
 assert.match(source,/!state.version && !\(state.backend==='hyperv' && state.engineLabel\)/);
 const hypervBranch=source.slice(source.indexOf("} else if(currentBackend==='hyperv')"),source.indexOf('version=currentBackend'));
 assert.ok(!hypervBranch.includes('adapters.check'));
 assert.match(source,/await adapters.check\(backend\)/);
 assert.ok(!source.includes("state.backend==='hyperv'?'Ready."));
});

test('feature guidance only follows positive missing signals and clears for other outcomes',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../vm-manager.js'),'utf8');
 const part=source.slice(source.indexOf('function hyperVFeatureIssue'),source.indexOf('function unavailableEngineLabel'));
 const classify=vm.runInNewContext(part+'; hyperVFeatureIssue');
 assert.match(classify('hyperv_module_missing'),/Windows Features.*Management Tools/);
 assert.match(classify('hyperv_service_missing'),/Windows Features.*Platform/);
 for(const code of ['hyperv_access_denied','hyperv_policy_blocked','hyperv_operation_failed','hyperv_service_stopped',undefined])assert.equal(classify(code),'');
 assert.ok(source.includes("if(backend==='hyperv')hypervFeatureIssue='';"));
 assert.ok(source.includes("hypervFeatureIssue='';backend=message.backend"));
 assert.ok(source.includes("$('host').className=m.hypervFeatureIssue?'error':''"));
 assert.ok(source.includes("m.hypervFeatureIssue?'× '+m.engineLabel"));
 assert.ok(source.includes("(!state.version && !(state.backend==='hyperv' && state.engineLabel))"));
});
