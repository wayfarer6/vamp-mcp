import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const keyFor = volume => createHash('sha256').update(volume).digest('hex') + '.json';

export async function withVmVolumeState(work, { directory = path.join(os.homedir(), '.vamp', 'vault-vm-disks') } = {}) {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077)))) {
    throw new Error('The VM workspace state directory must be private and owner-controlled.');
  }
  const lock = path.join(directory, 'active');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('A workspace disk operation is active or its interrupted lock needs review.');
  }
  try {
    const records = async () => (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    const readRecord = async name => {
      const record=JSON.parse(await readFile(path.join(directory,name),'utf8'));
      if (!record || typeof record.volume!=='string' || typeof record.mountPoint!=='string' || keyFor(record.volume)!==name) {
        throw new Error('A workspace disk record is invalid and needs review.');
      }
      return record;
    };
    return await work({
      async assertDetached({ volume, mountPoint } = {}) {
        for (const record of await records()) {
          const attached = await readRecord(record);
          if ((!volume && !mountPoint) || attached.volume===volume || attached.mountPoint===mountPoint) {
            throw new Error('Detach the VM workspace disk before dismounting or deleting the encrypted volume.');
          }
        }
      },
      async beforeChange(operation, target) {
        const record = keyFor(target.volume);
        if (operation==='attach') {
          try {
            await writeFile(path.join(directory,record),JSON.stringify(target),{flag:'wx',mode:0o600});
          } catch(error) {
            if (error.code!=='EEXIST') throw error;
            throw new Error('This encrypted volume already has a pending or attached VM disk.');
          }
        } else {
          const existing=await readRecord(record).catch(error=>{
            if (error.code==='ENOENT') return null;
            throw error;
          });
          if (existing && JSON.stringify(existing)!==JSON.stringify(target)) {
            throw new Error('The detach request does not match the registered VM disk.');
          }
          return Boolean(existing);
        }
      },
      async detached(volume) {
        await unlink(path.join(directory,keyFor(volume))).catch(error=>{
          if (error.code!=='ENOENT') throw error;
        });
      },
    });
  } finally {
    await rmdir(lock);
  }
}
