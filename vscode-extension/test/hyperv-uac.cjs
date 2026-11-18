const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHyperVUac}=require('../../backends/hyperv/uac.cjs');
test('only explicit confirmed Windows action launches',async()=>{
 let calls=0;const execute=async()=>{calls++;return {stdout:'{"status":"diagnosis_window_opened"}'}};
 const service=createHyperVUac({platform:'win32',execute});
 assert.equal((await service.request()).status,'needs_confirmation');
 for(const value of [{confirmed:true,command:'bad'},{confirmed:'true'},null,[]])await assert.rejects(service.request(value));
 assert.equal((await createHyperVUac({platform:'linux',execute}).request({confirmed:true})).status,'unsupported_host');
 assert.equal(calls,0);
 assert.equal((await service.request({confirmed:true})).verified,false);assert.equal(calls,1);
});
test('fixed read-only command and trusted executable, no policy or arbitrary file',async()=>{
 const service=createHyperVUac({platform:'win32',execute:async(exe,args,options)=>{
  assert.equal(exe,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(args.slice(0,3),['-NoProfile','-NonInteractive','-Command']);
  for(const required of ['Get-AuthenticodeSignature','Get-VMHost','Get-VMSwitch','-Verb RunAs','Start-Sleep -Seconds 60'])assert.ok(args[3].includes(required));
  assert.ok(!/Set-ExecutionPolicy|ExecutionPolicy|EncodedCommand|-NoExit|New-VM|Start-VM|Add-LocalGroupMember|Invoke-Expression/.test(args[3]));
  assert.equal(options.timeout,45000);return {stdout:'{"status":"diagnosis_window_opened"}'};
 }});assert.equal((await service.request({confirmed:true})).status,'diagnosis_window_opened');
});
test('inflight duplicate blocked, timeout does not report success or retry',async()=>{
 let release,calls=0;const service=createHyperVUac({platform:'win32',execute:()=>{calls++;return new Promise((resolve,reject)=>{release=()=>reject(Error('secret raw command'))})}});
 const first=service.request({confirmed:true});assert.equal((await service.request({confirmed:true})).status,'already_pending');release();
 const result=await first;assert.equal(result.status,'launch_unverified');assert.equal(result.verified,false);assert.ok(!JSON.stringify(result).includes('secret'));assert.equal(calls,1);
});
