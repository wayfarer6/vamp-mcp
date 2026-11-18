'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createWorkspacePolicy}=require('../src/workspace-policy.cjs');
const request={workloadId:'workload-1',volumeId:'volume-1'};
function fixture(change={},approvalChange={}){
 const state={...request,observedAt:1000,directory:'/mounted/dedicated-work',access:'rw',mounted:true,engineVisible:true,rootless:true,directoryVerified:true,noSensitiveFiles:true,usageComplete:true,activeWorkloads:[],requiresRecreate:false,requiresRestart:false,...change};
 const approval={...request,directory:state.directory,access:'rw',expiresAt:5000,...approvalChange};
 return createWorkspacePolicy({readTrustedState:async()=>state,readTrustedApproval:async()=>approval,now:()=>2000});
}
test('no trusted sources: fails closed, rejects caller evidence',async()=>{
 const p=createWorkspacePolicy();assert.equal((await p.status(request)).state,'unverified');assert.equal((await p.canDismount({volumeId:'volume-1'})).blocked,true);
 assert.equal((await p.status({...request,verified:true})).reason,'invalid_request');
});
test('matching scope returns read-only status, never grants access or exposes directory',async()=>{
 const r=await fixture().status(request);assert.equal(r.state,'ready');assert.equal(r.accessGranted,false);assert.equal(r.readOnlyObservation,true);assert.ok(!JSON.stringify(r).includes('/mounted'));
});
test('approval binds workload, volume, exact directory, rw and expiration',async()=>{
 for(const change of [{workloadId:'other'},{volumeId:'other'},{directory:'/other'},{access:'ro'},{expiresAt:2000}])
  assert.equal((await fixture({},change).status(request)).state,'approval_required');
});
test('stale/future/mismatched observations fail closed',async()=>{
 for(const change of [{observedAt:-4000},{observedAt:3000},{workloadId:'other'},{volumeId:'other'}])assert.equal((await fixture(change).status(request)).state,'unverified');
});
test('mount and engine visibility are separate states',async()=>{
 assert.equal((await fixture({mounted:false}).status(request)).state,'locked');assert.equal((await fixture({engineVisible:false}).status(request)).state,'engine_not_visible');
});
test('unverified boundary/rootless/secret exclusion rejected',async()=>{
 for(const change of [{rootless:false},{directoryVerified:false},{noSensitiveFiles:false},{directory:'/'},{directory:'/a/../b'},{directory:'C:\\mount'},{directory:'/a\nsecret'},{access:'ro'}])assert.equal((await fixture(change).status(request)).state,'unverified');
});
test('unknown usage or another writer denied; target writer allowed',async()=>{
 assert.equal((await fixture({usageComplete:false}).status(request)).state,'unverified');assert.equal((await fixture({activeWorkloads:['other']}).status(request)).state,'busy');assert.equal((await fixture({activeWorkloads:['workload-1']}).status(request)).state,'ready');
});
test('restart distinct from recreate, unknown state denied',async()=>{
 assert.equal((await fixture({requiresRecreate:true}).status(request)).state,'recreate_required');assert.equal((await fixture({requiresRestart:true}).status(request)).state,'restart_required');assert.equal((await fixture({requiresRestart:undefined}).status(request)).state,'unverified');
});
test('dismount active and unknown blocked; idle is not authorization',async()=>{
 assert.equal((await fixture({activeWorkloads:['workload-1']}).canDismount({volumeId:'volume-1'})).blocked,true);
 assert.equal((await fixture({usageComplete:false}).canDismount({volumeId:'volume-1'})).blocked,true);
 assert.deepEqual(await fixture().canDismount({volumeId:'volume-1'}),{blocked:false,reason:'no_active_workloads_observed',authorized:false,requiresAtomicRecheck:true});
});
test('source errors never leak diagnostic/credential values',async()=>{
 const p=createWorkspacePolicy({readTrustedState:async()=>{throw Error('SECRET');},readTrustedApproval:async()=>null});
 assert.ok(!JSON.stringify(await p.status(request)).includes('SECRET'));assert.ok(!JSON.stringify(await p.canDismount({volumeId:'volume-1'})).includes('SECRET'));
});
