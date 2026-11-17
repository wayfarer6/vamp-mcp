const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {ensureVisionServices,enabled,entrypoint}=require('../../backends/common/vision-preload.cjs');

function runtime_tree(withService=true){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vamp-vision-'));
  fs.mkdirSync(path.join(root,'scripts'),{recursive:true});
  if(withService)fs.writeFileSync(path.join(root,'scripts','model_service.py'),'');
  return root;
}

test('preloading is on by default and can be switched off',()=>{
  assert.equal(enabled({}),true);
  assert.equal(enabled({VAMP_PRELOAD_MODELS:''}),true);
  assert.equal(enabled({VAMP_PRELOAD_MODELS:'0'}),false);
  assert.equal(enabled({VAMP_PRELOAD_MODELS:'false'}),false);
  assert.equal(enabled({VAMP_PRELOAD_MODELS:'1'}),true);
});

test('the service script is preferred over the module fallback',()=>{
  const root=runtime_tree();
  try{
    assert.deepEqual(entrypoint(root),{script:path.join(root,'scripts','model_service.py'),args:['start','--no-wait'],cwd:root});
    fs.rmSync(path.join(root,'scripts','model_service.py'));
    fs.writeFileSync(path.join(root,'model_daemon.py'),'');
    assert.deepEqual(entrypoint(root),{module:path.join(root,'model_daemon.py'),cwd:root});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('starting the workers is detached and never waits for a model load',()=>{
  const root=runtime_tree();
  try{
    const calls=[];
    const spawnProcess=(exe,args,options)=>{calls.push({exe,args,options});return {pid:4242,on(){},unref(){}};};
    const report=ensureVisionServices({runtime:root,env:{RPA_HOST_PYTHON:'/opt/python3'},platform:'linux',spawnProcess});
    assert.equal(report.status,'started');assert.equal(report.pid,4242);
    assert.equal(calls.length,1);
    assert.equal(calls[0].exe,'/opt/python3');
    assert.deepEqual(calls[0].args,[path.join(root,'scripts','model_service.py'),'start','--no-wait']);
    assert.equal(calls[0].options.detached,true);
    assert.equal(calls[0].options.stdio,'ignore');
    assert.equal(calls[0].options.cwd,root);
    assert.equal(calls[0].options.env.VAMP_PRELOAD_MODELS,'1');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a host without the model environment, or on Windows, is skipped quietly',()=>{
  const root=runtime_tree(false);
  try{
    let spawns=0;
    const spawnProcess=()=>{spawns++;return {on(){},unref(){}};};
    assert.deepEqual(ensureVisionServices({runtime:root,env:{},platform:'linux',spawnProcess}),{status:'unavailable',reason:'model_daemon_not_packaged',command:null,pid:null});
    assert.equal(ensureVisionServices({runtime:root,env:{VAMP_PRELOAD_MODELS:'0'},platform:'linux',spawnProcess}).reason,'disabled_by_VAMP_PRELOAD_MODELS');
    assert.equal(ensureVisionServices({runtime:root,env:{},platform:'win32',spawnProcess}).reason,'unsupported_platform');
    assert.equal(spawns,0);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a failing interpreter reports unavailable instead of throwing into the server',()=>{
  const root=runtime_tree();
  try{
    const messages=[];
    const spawnProcess=()=>{throw new Error('spawn python3 ENOENT');};
    const report=ensureVisionServices({runtime:root,env:{},platform:'linux',spawnProcess,logger:message=>messages.push(message)});
    assert.equal(report.status,'unavailable');assert.match(report.reason,/ENOENT/);
    // An asynchronous spawn error is logged, not raised.
    const late=ensureVisionServices({runtime:root,env:{},platform:'linux',spawnProcess:()=>({pid:1,on(event,handler){if(event==='error')handler(new Error('late failure'));},unref(){}}),logger:message=>messages.push(message)});
    assert.equal(late.status,'started');assert.ok(messages.some(message=>/late failure/.test(message)));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
