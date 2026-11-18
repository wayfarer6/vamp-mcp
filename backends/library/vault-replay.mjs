import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BridgeClient } from '../../vscode-vault-extension/src/bridge_client.mjs';

export async function runWithVault(python,script,request,{ socketPath,token,timeoutMs=610000 }={}) {
  const unavailable={status:'approval_required',message:'The approved Vault replay bridge is unavailable.'};
  if (!socketPath || !token) return unavailable;
  let bridge;
  try { bridge=await BridgeClient.connect({socketPath,token}); }
  catch { return unavailable; }
  const childEnv=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^VAULT_/i.test(name)));
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
        let ready=false;
        try { ready=(await bridge.request('check-replay-destination',{...target,references})).status==='ready'; }
        catch {}
        send({ok:ready});
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
