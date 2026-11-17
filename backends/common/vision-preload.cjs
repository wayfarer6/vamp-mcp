'use strict';
// Optional OCR/YOLO worker warmup when an MCP server starts.
//
// The model workers are owner-local detached processes that talk over private
// Unix sockets, so starting them here never touches stdio and never fails a
// server: every problem comes back as a status the caller may log and ignore.
// The workers stay for later calls and are reused across server restarts.

const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');

const DISABLED=/^(0|false|no|off|disabled)$/i;

function enabled(env=process.env){
  const value=env.VAMP_PRELOAD_MODELS;
  if(value===undefined||value==='')return true;
  return !DISABLED.test(String(value).trim());
}

/** Locate the preload entry point inside a runtime tree. */
function entrypoint(runtime){
  if(!runtime)return null;
  const service=path.join(runtime,'scripts/model_service.py');
  if(fs.existsSync(service))return {script:service,args:['start','--no-wait'],cwd:runtime};
  const daemon=path.join(runtime,'model_daemon.py');
  if(fs.existsSync(daemon))return {module:daemon,cwd:runtime};
  return null;
}

function python_for(env,platform){
  const configured=env.RPA_HOST_PYTHON;
  if(typeof configured==='string'&&configured.trim())return configured.trim();
  return platform==='win32'?'python':'python3';
}

/**
 * Start the model workers in the background and return immediately.
 * @returns {{status:string,reason:?string,command:?string[],pid:?number}}
 */
function ensureVisionServices({runtime,env=process.env,platform=process.platform,spawnProcess=spawn,logger}={}){
  const report={status:'skipped',reason:null,command:null,pid:null};
  if(!enabled(env)){report.reason='disabled_by_VAMP_PRELOAD_MODELS';return report;}
  // model_daemon relies on fcntl locks and AF_UNIX sockets, which Windows lacks.
  if(platform==='win32'){report.reason='unsupported_platform';return report;}
  const entry=entrypoint(runtime);
  if(!entry){report.status='unavailable';report.reason='model_daemon_not_packaged';return report;}
  const python=python_for(env,platform);
  const args=entry.script?[entry.script,...entry.args]:['-c','import model_daemon;model_daemon.ensure_services(wait=False)'];
  const command=[python,...args];
  try{
    const child=spawnProcess(python,args,{cwd:entry.cwd,detached:true,stdio:'ignore',windowsHide:true,env:{...env,VAMP_PRELOAD_MODELS:'1'}});
    child.on?.('error',error=>{if(logger)logger(`Vision preload unavailable: ${error.message}`);});
    child.unref?.();
    report.status='started';report.command=command;report.pid=child.pid??null;
  }catch(error){
    report.status='unavailable';report.reason=String(error?.message||error);
  }
  return report;
}

module.exports={ensureVisionServices,enabled,entrypoint};
