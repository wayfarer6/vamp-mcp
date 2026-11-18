'use strict';
const {execFile}=require('node:child_process');
const path=require('node:path');
function createDebianHost({runtime,python,spawn=execFile}={}){
  const script=path.join(runtime,'backends/packer/podman/host_job.py');
  function call(action,request,id){
    return new Promise((resolve,reject)=>{
      const executable=typeof python==='function'?python():python;
      const options={windowsHide:true,timeout:35000,maxBuffer:128*1024};
      const child=spawn(executable||process.env.RPA_HOST_PYTHON||(process.platform==='win32'?'python':'python3'),[script,action,...(id?[id]:[])],options,(error,stdout)=>{
        let r;try{r=JSON.parse(stdout);}catch{}
        if(error||!r)reject(Error(r?.error||'Debian host build helper is unavailable. Prepare the local Python environment and verify host access.'));
        else resolve(r);
      });
      child.stdin.on('error',()=>{});
      child.stdin.end(request?JSON.stringify(request):'');
    });
  }
  return {prepareDebianHost:request=>call('start',request),debianHostStatus:id=>{
    if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))return Promise.reject(Error('Invalid Debian build ID'));
    return call('status',null,id);
  }};
}
module.exports={createDebianHost};
