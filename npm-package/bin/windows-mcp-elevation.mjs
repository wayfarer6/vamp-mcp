import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import windows from '../runtime/backends/common/windows-admin.cjs';

const helper = fileURLToPath(import.meta.url);
const cli = fileURLToPath(new URL('./vamp-mcp.mjs', import.meta.url));
const psLiteral = value => "'" + value.replaceAll("'", "''") + "'";
const proof = (token, name, side) => createHmac('sha256',token).update(name+'|'+side).digest();
const settings = [
  'VAMP_HOME', 'VAMP_ASSETS_DIR', 'VAMP_HYPERV_DEBIAN_CONFIG', 'VAMP_PACKER_BOOTSTRAP_HOST', 'VAGRANT_PATH',
  'VAMP_PRELOAD_MODELS', 'VAMP_OCR_PYTHON', 'VAMP_OCR_DEVICE', 'VAMP_YOLO_PYTHON', 'VAMP_YOLO_DEVICE', 'VAMP_YOLO_MODEL',
  'VAMP_RPA_REGISTRY', 'RPA_HOST_PYTHON', 'RPA_REPLAY_PYTHON', 'PYTHON_PATH', 'VBOXMANAGE_PATH',
  'VAMP_REMOTE_REPO', 'VAMP_REMOTE_PYTHON', 'VAMP_LIBVIRT_URI',
];

async function endpoint(name, token) {
  let accepted, peer;
  const expected = proof(token,name,'worker');
  const server = createServer({ allowHalfOpen: true }, socket => {
    const timeout = setTimeout(() => socket.destroy(), 5000);
    let bytes = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('close', () => clearTimeout(timeout));
    function authenticate(chunk) {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < expected.length) return;
      clearTimeout(timeout);
      if (!timingSafeEqual(bytes.subarray(0, expected.length), expected)) return socket.destroy();
      socket.pause();
      socket.removeListener('data', authenticate);
      if (bytes.length > expected.length) socket.unshift(bytes.subarray(expected.length));
      server.close();
      socket.write(proof(token,name,'parent'));
      peer = socket;
      accepted(socket);
    }
    socket.on('data', authenticate);
  });
  const connection = new Promise(resolve => { accepted = resolve; });
  server.listen(name);
  await once(server, 'listening');
  return { connection, close() { server.close(); peer?.destroy(); } };
}

export async function elevateMcp(args, { input = process.stdin, stdout = process.stdout,
  stderr = process.stderr, launchWorker = launchAdministrator } = {}) {
  const token = randomBytes(32);
  const base = '\\\\.\\pipe\\vamp-mcp-' + randomBytes(20).toString('hex');
  const names = [base, base + '-stderr'];
  const endpoints = [];
  let launch, streams, timeout;
  try {
    for (const name of names) endpoints.push(await endpoint(name, token));
    const environment = Object.fromEntries(settings.filter(key=>process.env[key]!==undefined)
      .map(key=>[key,process.env[key]]));
    const request = Buffer.from(JSON.stringify({ names, token: token.toString('hex'), args, environment })).toString('base64url');
    launch = launchWorker(request);
    const exited = once(launch, 'exit').then(([code]) => code ?? 1);
    const expired = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Timed out waiting for the Windows administrator approval.')), 120000);
    });
    streams = await Promise.race([
      Promise.all(endpoints.map(item => item.connection)),
      exited.then(() => { throw new Error('The elevated MCP server did not connect.'); }),
      expired,
    ]);
    clearTimeout(timeout);
    const [stdio, diagnostic] = streams;
    const forward = async (source, destination) => {
      const ended = once(source, 'end');
      source.pipe(destination, { end: false });
      await ended;
    };
    const output = Promise.all([forward(stdio,stdout), forward(diagnostic,stderr)]);
    input.pipe(stdio);
    const [code] = await Promise.all([exited, output]);
    return code;
  } finally {
    clearTimeout(timeout);
    if (streams) {
      input.unpipe(streams[0]);
      input.pause();
      for (const socket of streams) socket.destroy();
    }
    for (const item of endpoints) item.close();
    if (launch && launch.exitCode === null) launch.kill();
  }
}

function launchAdministrator(request) {
  const parameters = '"'+helper+'" '+request;
  const command = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; try {" +
    `$p=Start-Process -FilePath ${psLiteral(process.execPath)} -ArgumentList ${psLiteral(parameters)} ` +
    `-WorkingDirectory ${psLiteral(process.cwd())} -Verb RunAs -WindowStyle Hidden -PassThru; $p.WaitForExit(); exit $p.ExitCode` +
    '} catch { [Console]::Error.WriteLine("Administrator launch cancelled or unavailable."); exit 1 }';
  return spawn(windows.powershell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore','ignore','inherit'] });
}

async function elevatedWorker(request) {
  if (!await windows.isAdministrator()) throw new Error('Windows did not grant administrator privileges.');
  const { names, token, args, environment } = JSON.parse(Buffer.from(request, 'base64url').toString('utf8'));
  const streams = names.map(name => createConnection({path:name, allowHalfOpen:true}));
  try {
    await Promise.all(streams.map(stream => once(stream,'connect')));
    await Promise.all(streams.map(async (stream,index) => {
      const key = Buffer.from(token,'hex');
      const expected = proof(key,names[index],'parent');
      const timeout = setTimeout(() => stream.destroy(new Error('MCP relay authentication timed out.')),5000);
      let bytes = Buffer.alloc(0);
      const authenticated = new Promise((resolve,reject) => {
        const closed = () => reject(new Error('MCP relay disconnected before authentication.'));
        stream.once('close', closed);
        stream.on('data', function authenticate(chunk) {
          bytes = Buffer.concat([bytes,chunk]);
          if (bytes.length < expected.length) return;
          stream.pause();
          stream.removeListener('data',authenticate);
          stream.removeListener('close',closed);
          if (!timingSafeEqual(bytes.subarray(0,expected.length),expected)) {
            reject(new Error('Invalid MCP relay authentication.'));
            return;
          }
          if (bytes.length > expected.length) stream.unshift(bytes.subarray(expected.length));
          resolve();
        });
      });
      stream.on('error',()=>{});
      stream.write(proof(key,names[index],'worker'));
      try { await authenticated; } finally { clearTimeout(timeout); }
    }));
    const [stdio, stderr] = streams;
    const env = {...process.env};
    for (const key of settings) {
      if (typeof environment?.[key] === 'string') env[key] = environment[key];
    }
    const child = spawn(process.execPath, [cli,...args], {windowsHide:true,stdio:'pipe',env});
    const disconnected = () => { if (child.exitCode === null) child.kill(); };
    stdio.once('close',disconnected);
    child.stdin.on('error', () => {});
    stdio.pipe(child.stdin);
    child.stdout.pipe(stdio,{end:false});
    child.stderr.pipe(stderr,{end:false});
    const [code] = await once(child,'close');
    await Promise.all(streams.map(stream => new Promise(resolve => stream.end(resolve))));
    return code ?? 1;
  } finally {
    for (const socket of streams) socket.destroy();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { process.exitCode = await elevatedWorker(process.argv[2]); }
  catch (error) { console.error('vamp-mcp elevation:',error.message); process.exitCode=1; }
}
