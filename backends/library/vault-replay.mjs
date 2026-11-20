import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { BridgeClient } from '../../vscode-vault-extension/src/bridge_client.mjs';

export async function remoteReplayEndpoint(directory = `/run/user/${process.getuid?.()}`) {
  if (process.platform!=='linux') return null;
  const uid=process.getuid();
  try {
    const directoryInfo=await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.uid!==uid || (directoryInfo.mode&0o777)!==0o700) return null;
    const file=await open(path.join(directory,'vamp-vault-replay.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let endpoint;
    try {
      const info=await file.stat();
      if (!info.isFile() || info.uid!==uid || (info.mode&0o777)!==0o600 || info.nlink!==1 || info.size>1024) return null;
      endpoint=JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
    const {socketPath,token}=endpoint;
    if (typeof socketPath!=='string' || !path.isAbsolute(socketPath) || !/^[a-f0-9]{64}$/.test(token)) return null;
    const socket=await lstat(socketPath);
    if (!socket.isSocket() || socket.uid!==uid || (socket.mode&0o777)!==0o600) return null;
    return {socketPath,token};
  } catch { return null; }
}

export async function runWithVault(python,script,request,{ socketPath,token,timeoutMs=610000 }={}) {
  const unavailable={status:'approval_required',message:'The approved Vault replay bridge is unavailable.'};
  if (!socketPath || !token) return unavailable;
  let bridge;
  try { bridge=await BridgeClient.connect({socketPath,token}); }
  catch { return unavailable; }
  const childEnv=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^VAULT_/i.test(name)));
  childEnv.PYTHONIOENCODING='utf-8';
  const child=spawn(python,[script,'--vault-dialogue'],{stdio:['pipe','pipe','ignore'],windowsHide:true,env:childEnv});
  child.stdin.on('error',()=>{});
  child.on('error',()=>{});
  const lines=createInterface({input:child.stdout});
  const timer=setTimeout(()=>{child.kill();bridge.close();},timeoutMs);
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  const target={destination:request.vault_destination,vmId:request.vm_id};
  let references;
  let next=0;
  try {
    send(request);
    for await(const line of lines) {
      const message=JSON.parse(line);
      if (message.vault==='preflight' && !references) {
        references=message.references;
        let status;
        try { status=(await bridge.request('check-replay-destination',{...target,references})).status; }
        catch {}
        if(status==='placeholder_unresolved'||status==='placeholder_ambiguous') {
          return {status,actions_completed:0,message:'Check the Vault references before retrying.'};
        }
        send({ok:status==='ready'});
      } else if (message.vault==='deliver' && references) {
        const expected=references[next];
        let delivered=false;
        if (expected && expected.action_index===message.action_index && expected.entry===message.entry && expected.field===message.field) {
          try {
            delivered=(await bridge.request('deliver-credential',{...target,entry:expected.entry,field:expected.field})).status==='delivered';
          } catch {}
        }
        if(delivered)next++;
        send({ok:delivered});
      } else if (typeof message.status==='string') {
        if (references && message.status==='completed_unverified' && next!==references.length) return unavailable;
        return message;
      } else {
        return unavailable;
      }
    }
    return unavailable;
  } catch {
    return unavailable;
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    if(child.exitCode===null)child.kill();
    bridge.close();
  }
}
