'use strict';
// Optional OCR/YOLO worker warmup when an MCP server starts.
//
// The model workers use private local IPC, so starting them here never touches stdio and never fails a
// server: every problem comes back as a status the caller may log and ignore.
// The workers stay for later calls and are reused across server restarts.

const fs=require('node:fs');
const os=require('node:os');
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
  runtime=env.VAMP_PROVISIONING_ASSETS||runtime;
  const downloader=runtime&&path.join(runtime,'scripts/download_models.py');
  const canDownload=downloader&&!env.VAMP_YOLO_MODEL&&fs.existsSync(downloader)&&fs.existsSync(path.join(runtime,'models/manifest.json'));
  const lean=runtime&&fs.existsSync(path.join(runtime,'provisioning-assets.json'));
  if(lean&&!canDownload){
    report.reason='deferred_until_assets_are_used';return report;
  }
  const entry=entrypoint(runtime);
  if(!entry&&!lean){report.status='unavailable';report.reason='model_daemon_not_packaged';return report;}
  if(!canDownload&&(platform==='win32'||platform==='darwin') && !env.VAMP_OCR_PYTHON && !env.VAMP_YOLO_PYTHON){
    const nativePython=platform==='win32'?'Scripts/python.exe':'bin/python';
    const hostHome=env.VAMP_HOME||path.join(os.homedir(),'.vamp');
    if(!['.venv','.venv-ocr'].some(folder=>fs.existsSync(path.join(runtime,folder,nativePython))) &&
       !['ocr-python','yolo-python'].some(folder=>fs.existsSync(path.join(hostHome,folder,nativePython))) &&
       !fs.existsSync(path.join(hostHome,'vision-environment.json'))){
      report.reason='host_model_environment_missing';return report;
    }
  }
  const python=python_for(env,platform);
  const args=lean?[downloader,'--cache']:entry.script?[entry.script,...entry.args]:['-c','import model_daemon;model_daemon.ensure_services(wait=False)'];
  const command=[python,...args];
  try{
    const child=spawnProcess(python,args,{cwd:runtime,detached:true,stdio:'ignore',windowsHide:true,env:{...env,VAMP_PRELOAD_MODELS:'1'}});
    child.on?.('error',error=>{if(logger)logger(`Vision preload unavailable: ${error.message}`);});
    child.unref?.();
    report.status='started';report.command=command;report.pid=child.pid??null;
  }catch(error){
    report.status='unavailable';report.reason=String(error?.message||error);
  }
  return report;
}

module.exports={ensureVisionServices,enabled,entrypoint};
