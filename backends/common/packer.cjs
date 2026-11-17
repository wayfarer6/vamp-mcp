const path=require('node:path');
const {execFile}=require('node:child_process');
function packer({runtime,python=()=>process.env.RPA_HOST_PYTHON||(process.platform==='win32'?'python':'python3'),spawn=execFile}={}){
 return function call(action,{backend='virtualbox',id,confirmed=false,...request}={}){
  const args=[path.join(runtime,'backends/packer/runner.py'),action,'--backend',backend];
  if(id)args.push('--id',id);if(confirmed)args.push('--confirmed');
  return new Promise((resolve,reject)=>{
   const child=spawn(typeof python==='function'?python():python,args,{windowsHide:true,timeout:600000,maxBuffer:4*1024**2},(error,stdout,stderr)=>{
    let data;try{data=JSON.parse(stdout);}catch{}
    if(error||data?.status==='failed')reject(Error(data?.error||stderr||error?.message||'Packer response was invalid'));else resolve(data);
   });
   child.stdin.on('error',()=>{});child.stdin.end(action==='create'?JSON.stringify({backend,...request}):'');
  });
 };
}
module.exports={packer};
