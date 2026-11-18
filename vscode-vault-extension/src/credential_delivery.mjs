import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const vmIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const receiver = '/usr/local/bin/vamp-vault-receive';

export async function remoteProcessTarget(name) {
  if (process.platform !== 'linux') throw new Error('Remote process delivery requires a Linux Vault host.');
  const directory = path.join(os.homedir(), '.vamp', 'vault');
  const owner = process.getuid();
  for (const parent of [path.dirname(directory), directory]) {
    const info = await lstat(parent).catch(() => null);
    if (!info?.isDirectory() || info.uid !== owner || (info.mode & 0o022)) throw new Error('The remote delivery directory must be owner-controlled.');
  }
  const file = await open(path.join(directory, 'credential-delivery.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => { throw new Error('Remote credential delivery is not configured.'); });
  let data;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== owner || (info.mode & 0o077) || info.size > 65536) throw new Error('The remote delivery file must be private.');
    data = JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
  if (!data || typeof data !== 'object' || !Object.hasOwn(data, name)) throw new Error('Choose a configured remote credential destination.');
  const {executable, args, entry, field} = data[name] ?? {};
  if (typeof entry !== 'string' || !entry || !['username','password','totp'].includes(field)) throw new Error('Bind the remote destination to a single vault entry and field.');
  const target = deliveryTarget(name, { [name]: { executable, args } });
  return { target, entry, field, directory };
}

export async function auditRemoteDelivery(directory, audit) {
  const file = await open(path.join(directory,'credential-delivery.jsonl'),
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('The remote audit file must be private.');
    await file.writeFile(JSON.stringify({at:new Date().toISOString(),...audit})+'\n');
  } finally { await file.close(); }
}

export function deliveryTarget(name, targets, expectedVmId) {
  if (typeof name !== 'string' || !namePattern.test(name) || !Object.hasOwn(targets, name)) {
    throw new Error('Select a configured credential destination.');
  }
  const configured=targets[name] || {};
  if (Object.hasOwn(configured,'executable')) {
    const {executable,args=[]}=configured;
    if (expectedVmId!==undefined) throw new Error('A local program cannot be used as a VM destination.');
    if (Object.keys(configured).some(key=>!['executable','args'].includes(key)) ||
        typeof executable!=='string'||!path.isAbsolute(executable)||/[\x00-\x1f]/.test(executable)||
        !Array.isArray(args)||args.length>32||args.some(arg=>typeof arg!=='string'||arg.length>4096||/[\x00-\x1f]/.test(arg))) {
      throw new Error('Configure an absolute local executable and fixed arguments.');
    }
    return Object.freeze({name,executable,args:Object.freeze([...args])});
  }
  const { host, user, port = 22, identityFile, knownHostsFile, containerId, vmId, guestVolume } = configured;
  if (typeof host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host) ||
      typeof user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || user === 'root' ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      [identityFile, knownHostsFile].some(file => typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f"]/.test(file)) ||
      (containerId !== undefined && (typeof containerId !== 'string' || !/^[a-f0-9]{64}$/.test(containerId))) ||
      (vmId !== undefined && (containerId !== undefined || typeof vmId !== 'string' || !vmIdPattern.test(vmId)))) {
    throw new Error('Invalid destination. Configure a non-root SSH user, verified host keys, and the full container ID if applicable.');
  }
  const boundVmId=vmId?.toLowerCase();
  if (expectedVmId !== undefined && (typeof expectedVmId !== 'string' || !vmIdPattern.test(expectedVmId)
      || expectedVmId.toLowerCase() !== boundVmId)) {
    throw new Error('The configured credential destination does not match the requested VM UUID.');
  }
  let volume;
  if (guestVolume !== undefined) {
    if (!boundVmId || containerId || !guestVolume || typeof guestVolume !== 'object' ||
        Object.keys(guestVolume).some(key => !['entry','device','mountPoint'].includes(key))) {
      throw new Error('Configure the guest volume for one VM destination.');
    }
    const {entry, device, mountPoint} = guestVolume;
    if (typeof entry !== 'string' || !/^VeraCrypt\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(entry) ||
        typeof device !== 'string' || !/^\/dev\/disk\/by-path\/[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,254}$/.test(device) || /-part\d+$/.test(device) ||
        typeof mountPoint !== 'string' || !/^\/mnt\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(mountPoint)) {
      throw new Error('Configure the managed entry, whole disk by-path and dedicated directory under /mnt.');
    }
    volume = Object.freeze({entry, device, mountPoint});
  }
  return Object.freeze({ name, host, user, port, identityFile, knownHostsFile, containerId,vmId:boundVmId,guestVolume:volume });
}

export function validateCredentialField(record, field) {
  const value = record[field];
  if (!['username','password','totp'].includes(field) || typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)
      || (field === 'totp' && !/^\d{6,8}$/.test(value))) {
    throw new Error('The selected field is empty or cannot be typed safely.');
  }
  return value;
}

export async function deliverCredential(target, value, field, signal) {
  signal?.throwIfAborted();
  if (target.executable) return deliverToProcess(target,value,signal);
  try {
    const files = await Promise.all([stat(target.identityFile), stat(target.knownHostsFile)]);
    if (files.some(file => !file.isFile())) throw new Error();
  } catch {
    throw new Error('The destination SSH identity or verified known-hosts file is unavailable.');
  }
  if (target.guestVolume && field !== 'password') throw new Error('Guest VeraCrypt unlock requires the volume password.');
  const data = Buffer.from(target.guestVolume ? value+'\n' : JSON.stringify({ field, value }));
  if (data.length > 65536) {
    data.fill(0);
    throw new Error('The credential is too large for delivery.');
  }
  const command = target.guestVolume
    ? `/usr/bin/sudo -n /usr/bin/veracrypt --text --non-interactive --stdin --pim=0 --keyfiles= --protect-hidden=no ${target.guestVolume.device} ${target.guestVolume.mountPoint}`
    : target.containerId
    ? `/usr/bin/podman --remote=false exec -i ${target.containerId} ${receiver}`
    : receiver;
  const ssh = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
    : '/usr/bin/ssh';
  try {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const child = spawn(ssh, ['-F', 'none', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile="${target.knownHostsFile}"`,
        '-o', 'GlobalKnownHostsFile=none', '-o', 'ConnectTimeout=8', '-i', target.identityFile,
        '-p', String(target.port), `${target.user}@${target.host}`, command], {
        stdio: ['pipe', target.guestVolume ? 'ignore' : 'pipe', 'ignore'], windowsHide: true, signal,
      });
      let receipt = '';
      let inputFailed = false;
      const fail = () => reject(new Error(target.guestVolume ? 'The guest VeraCrypt command did not complete successfully.'
        : 'Delivery did not return a receipt. Check the destination and its waiting receiver.'));
      const timer = setTimeout(() => { child.kill(); fail(); }, target.guestVolume ? 120000 : 15000);
      child.stdout?.setEncoding('utf8').on('data', chunk => {
        if (receipt.length + chunk.length > 32) { child.kill(); fail(); } else { receipt += chunk; }
      });
      child.stdin.on('error', () => { inputFailed = true; });
      child.once('error', () => { clearTimeout(timer); fail(); });
      child.once('close', code => {
        clearTimeout(timer);
        if (code === 0 && !inputFailed && (target.guestVolume || receipt === 'VAMP_RECEIVED\n')) resolve();
        else fail();
      });
      child.stdin.end(data);
    });
  } finally {
    data.fill(0);
  }
  return { status: 'delivered', destination: target.name };
}

async function deliverToProcess(target,value,signal) {
  const info=await stat(target.executable).catch(()=>null);
  if(!info?.isFile())throw new Error('The configured local executable is unavailable.');
  const data=Buffer.from(value+'\n');
  try {
    signal?.throwIfAborted();
    if(data.length>65536)throw new Error('The credential is too large for delivery.');
    await new Promise((resolve,reject)=>{
      const env=process.platform==='win32' ? {SystemRoot:process.env.SystemRoot || 'C:\\Windows'} : {};
      const child=spawn(target.executable,target.args,{stdio:['pipe','ignore','ignore'],windowsHide:true,shell:false,env,signal});
      const fail=()=>reject(new Error('The configured program did not accept the credential.'));
      const timer=setTimeout(()=>{child.kill();fail();},15000);
      let inputFailed=false;
      child.stdin.on('error',()=>{inputFailed=true;});
      child.once('error',()=>{clearTimeout(timer);fail();});
      child.once('close',code=>{
        clearTimeout(timer);
        if(code===0&&!inputFailed)resolve();else fail();
      });
      child.stdin.end(data);
    });
    return {status:'delivered',destination:target.name};
  } finally {
    data.fill(0);
  }
}
