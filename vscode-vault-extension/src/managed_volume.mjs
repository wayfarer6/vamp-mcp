import { randomBytes } from 'node:crypto';
import { link, lstat, mkdtemp, realpath, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createManagedVolume(cli, { file, volume, name, sizeBytes, databasePassword, format = 'container' }) {
  if (!path.isAbsolute(volume) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error('Use an absolute volume path and a simple credential name.');
  }
  if (format === 'guest-vhd' && (cli.platform !== 'win32' || !/^[a-z]:[\\/]/i.test(volume) || !/\.vhd$/i.test(volume))) {
    throw new Error('Guest VHD creation requires a local Windows .vhd path and configured WSL.');
  }
  const parent = await realpath(path.dirname(volume));
  const destination = path.join(parent, path.basename(volume));
  const entry = `VeraCrypt/${name}`;
  const existing = await lstat(destination).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) throw new Error('A file already exists at the selected volume path.');
  const listing = await cli.listEntries({ file, databasePassword });
  if (listing.entries.some(item => item.path === entry)) throw new Error('The selected volume credential already exists.');
  const temporary = await mkdtemp(path.join(parent, '.vamp-veracrypt-'));
  let stored = false;
  try {
    const container = path.join(temporary, 'volume.hc');
    const staged = format === 'guest-vhd' ? path.join(temporary, 'volume.vhd') : container;
    const password = randomBytes(32).toString('base64url');
    const result = await cli.createVolume({ file: container, password, sizeBytes, headless: true });
    if (!result.created || !(await stat(container)).isFile()) throw new Error('VeraCrypt did not confirm creation.');
    if (format === 'guest-vhd') await cli.wrapGuestVolumeViaWsl(container, staged, sizeBytes);
    await cli.addEntry({
      file, group: 'VeraCrypt', entry: name, secret: password, databasePassword,
      url: pathToFileURL(destination).href,
      ...(format === 'guest-vhd' ? { notes: 'VAMP format: guest-vhd' } : {}),
    });
    stored = true;
    // A concurrent creator must never be overwritten.
    await link(staged, destination);
    return { status: 'created', volume: destination, entry, ...(format === 'guest-vhd' ? { format } : {}) };
  } catch (error) {
    if (stored) throw new Error(`Publishing the volume failed. The vault entry "${entry}" was retained for review.`);
    if (error.message === 'VeraCrypt did not confirm creation.' || error.code === 'guest_vhd_failed') throw error;
    throw new Error('Could not create and register the volume. Inspect the selected vault and VeraCrypt setup.');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

async function volumeMounts(cli, volume, identity, wsl) {
  const listing = await cli.listVolumes({ probeNative: wsl });
  if (!listing.available || listing.mounted.some(item => !item.volume)) {
    throw new Error('VeraCrypt could not verify the mounted volume paths.');
  }
  const mounted = [...listing.mounted];
  if (wsl) {
    const target = await cli.windowsVolumePathInWsl(volume);
    for (const item of await cli.listWslVolumes()) {
      const translated = item.volume === target ? volume
        : (await cli.wslCommand(['/usr/bin/wslpath','-w',item.volume])).stdout.trim();
      if (!path.isAbsolute(translated)) throw new Error('Could not verify a WSL volume backing path.');
      mounted.push({ ...item, volume: translated });
    }
  }
  const matches = [];
  for (const item of mounted) {
    const current = await stat(item.volume, { bigint: true }).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (item.volume === volume || (current && sameFile(current, identity))) matches.push(item);
  }
  return matches;
}

export async function deleteManagedVolume(cli, { file, volume, entry, databasePassword, wsl = false }) {
  if (!path.isAbsolute(volume) || !/^VeraCrypt\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry)) {
    throw new Error('Use an absolute volume path and a managed VeraCrypt credential.');
  }
  const destination = path.join(await realpath(path.dirname(volume)), path.basename(volume));
  const identity = await lstat(destination, { bigint: true });
  if (!identity.isFile() || identity.nlink !== 1n) throw new Error('Expected an ordinary volume file with one link.');
  if (sameFile(identity, await stat(file, { bigint: true }))) throw new Error('The vault database cannot be removed as a volume.');
  const credentials = { file, entry, databasePassword };
  const listing = await cli.listEntries(credentials);
  if (listing.entries.filter(item => item.path === entry).length !== 1) {
    throw new Error('Choose one unique volume credential.');
  }
  const record = await cli.showEntry({ ...credentials, showProtected: false });
  if (record.url !== pathToFileURL(destination).href) throw new Error('The vault entry is not bound to this encrypted volume.');
  const mounts = await volumeMounts(cli, destination, identity, wsl);
  if (mounts.length > 1 || (mounts.length === 1 && !mounts[0].mount_point)) {
    throw new Error('VeraCrypt could not identify one mount point to unmount.');
  }
  if (mounts.length) {
    const mountPoint = mounts[0].mount_point;
    const result = wsl ? await cli.unmountVolumeViaWsl(mountPoint) : await cli.unmountVolume({ mountPoint });
    if (!result.unmounted || (await volumeMounts(cli, destination, identity, wsl)).length) {
      throw new Error('The volume is still mounted. Close any applications using it and retry.');
    }
  }
  const quarantine = await mkdtemp(path.join(path.dirname(destination), '.vamp-delete-'));
  const staged = path.join(quarantine, path.basename(destination));
  let retained = false;
  let credentialDeleted = false;
  try {
    await rename(destination, staged);
    retained = true;
    const current = await lstat(staged, { bigint: true });
    if (!sameFile(current, identity) || current.nlink !== 1n || (await volumeMounts(cli, destination, identity, wsl)).length) {
      throw new Error('The volume changed or was mounted during removal.');
    }
    const result = await cli.deleteEntry(credentials);
    if (!result.deleted) throw new Error('The vault did not confirm credential removal.');
    credentialDeleted = true;
    await unlink(staged);
    retained = false;
    return { status: 'deleted', volume: destination, entry, credential_removed: true };
  } catch (error) {
    if (!retained) throw error;
    // Keep the encrypted bytes if either side of the operation fails.
    return { status: 'recovery_required', volume: destination, recovery_path: staged, entry,
      credential_removed: credentialDeleted, hint: 'Review the vault and the quarantined file before retrying.' };
  } finally {
    if (!retained) await rmdir(quarantine).catch(() => {});
  }
}
