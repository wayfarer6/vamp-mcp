// VAMP Vault — thin, auditable wrapper around keepassxc-cli and veracrypt.
//
// Only this module talks to the two CLI programs. Passwords reach them over
// stdin (never argv), so they do not appear in a process list, and every
// method returns plain data instead of printing anything.
import path from 'node:path';
import { access, mkdir, stat } from 'node:fs/promises';
import { cleanError, run } from './downloader.mjs';

/** keepassxc-cli wants one password per line on stdin. */
const lines = values => values.filter(value => value !== undefined && value !== null).map(value => `${value}\n`).join('');

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

export function parseShowAll(text) {
  const record = { attributes: {} };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^([^:]+):\s?(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2];
    switch (key) {
      case 'Title': record.title = value; break;
      case 'UserName': record.username = value; break;
      case 'Password': record.password = value === 'PROTECTED' ? null : value; break;
      case 'URL': record.url = value; break;
      case 'Notes': record.notes = value; break;
      case 'Uuid': record.uuid = value; break;
      case 'Tags': record.tags = value ? value.split(',').map(tag => tag.trim()).filter(Boolean) : []; break;
      default: record.attributes[key] = value;
    }
  }
  return record;
}

/** `ls -R -f` prints one path per line, groups end with a slash. */
export function parseEntryList(text) {
  const entries = [];
  const groups = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.endsWith('/')) groups.push(line.replace(/\/$/, ''));
    else entries.push({ path: line, group: path.posix.dirname(line) === '.' ? '/' : path.posix.dirname(line), title: path.posix.basename(line) });
  }
  return { entries, groups };
}

/** veraCrypt --list prints "1: <volume> <virtual device> <mount point>". */
export function parseMountList(text) {
  const mounted = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /no volumes mounted/i.test(line) || /^slot/i.test(line)) continue;
    const match = line.match(/^(\d+):\s+(\S+)\s+(\S+)\s+(\S.*)$/);
    if (match) mounted.push({ slot: Number(match[1]), volume: match[2], device: match[3], mount_point: match[4].trim() });
  }
  return mounted;
}

export class VaultCli {
  constructor({ keepassxcCli = null, veracryptCli = null, kdbxPath, volumePath, mountPoint, platform = process.platform, env = process.env, timeoutMs = 120000 } = {}) {
    Object.assign(this, { keepassxcCli, veracryptCli, kdbxPath, volumePath, mountPoint, platform, env, timeoutMs });
  }

  get hasKeepass() { return Boolean(this.keepassxcCli); }
  get hasVeracrypt() { return Boolean(this.veracryptCli); }

  requireKeepass() {
    if (!this.keepassxcCli) {
      const error = new Error('keepassxc-cli is not available. Run "VAMP Vault: Set Up KeePassXC & VeraCrypt CLI" in VS Code.');
      error.code = 'keepassxc_missing';
      throw error;
    }
    return this.keepassxcCli;
  }

  requireVeracrypt() {
    if (!this.veracryptCli) {
      const error = new Error('The VeraCrypt command line binary is not available. Run "VAMP Vault: Set Up KeePassXC & VeraCrypt CLI" in VS Code.');
      error.code = 'veracrypt_missing';
      throw error;
    }
    return this.veracryptCli;
  }

  /** Run keepassxc-cli with the database password (and any follow-up prompts) on stdin. */
  async keepass(args, { databasePassword, prompts = [], noPassword = false, keyFile, timeout = this.timeoutMs } = {}) {
    const cli = this.requireKeepass();
    const prefix = [];
    if (keyFile) prefix.push('-k', keyFile);
    if (noPassword) prefix.push('--no-password');
    const result = await run(cli, [...prefix, ...args], {
      timeout,
      env: this.env,
      input: noPassword ? lines(prompts) : lines([databasePassword, ...prompts]),
    });
    return result.stdout;
  }

  async version(tool) {
    const cli = tool === 'veracrypt' ? this.veracryptCli : this.keepassxcCli;
    if (!cli) return null;
    try {
      const result = await run(cli, ['--version'], { timeout: 20000, env: this.env, allowFailure: true });
      return `${result.stdout} ${result.stderr}`.split('\n').map(line => line.trim()).find(detail => /\d+\.\d+/.test(detail)) ?? null;
    } catch { return null; }
  }

  // ------------------------------------------------------------- KeePassXC

  async createDatabase({ file = this.kdbxPath, password, keyFile, overwrite = false } = {}) {
    if (!file) throw new Error('No database path was given and no default .kdbx is configured.');
    if (!password) throw new Error('A master password is required to create a KeePassXC database.');
    if (!overwrite && (await exists(file))) {
      const error = new Error(`A database already exists at ${file}. Refusing to overwrite it.`);
      error.code = 'already_exists';
      throw error;
    }
    await mkdir(path.dirname(file), { recursive: true });
    const args = ['db-create', '-p'];
    if (keyFile) args.push('--set-key-file', keyFile);
    args.push(file);
    const output = await this.keepass(args, { databasePassword: password, prompts: [password], timeout: 180000 });
    return { file, created: true, key_file: keyFile ?? null, output: cleanError(output) || 'Successfully created new database.' };
  }

  async listEntries({ file = this.kdbxPath, group = '/', recursive = true, databasePassword, noPassword = false, keyFile } = {}) {
    const args = ['ls'];
    if (recursive) args.push('-R');
    args.push('-f', file, group || '/');
    const output = await this.keepass(args, { databasePassword, noPassword, keyFile });
    return parseEntryList(output);
  }

  async showEntry({ file = this.kdbxPath, entry, databasePassword, noPassword = false, keyFile, showProtected = true } = {}) {
    if (!entry) throw new Error('An entry path is required.');
    const args = ['show'];
    if (showProtected) args.push('-s');
    args.push('--all', file, entry);
    let output;
    try {
      output = await this.keepass(args, { databasePassword, noPassword, keyFile });
    } catch (error) {
      if (/could not find entry|no such entry/i.test(error.message)) {
        const missing = new Error(`Entry "${entry}" was not found in ${file}.`);
        missing.code = 'entry_not_found';
        throw missing;
      }
      if (/invalid credentials|failed to open|wrong password|hmac mismatch/i.test(error.message)) {
        const locked = new Error(`Could not open ${file}: the master password was rejected.`);
        locked.code = 'vault_unlock_failed';
        throw locked;
      }
      throw error;
    }
    const record = parseShowAll(output);
    if (!record.title) {
      const error = new Error(`Entry "${entry}" was not found in ${file}.`);
      error.code = 'entry_not_found';
      throw error;
    }
    record.path = entry;
    return record;
  }

  async totp({ file = this.kdbxPath, entry, databasePassword, noPassword = false, keyFile } = {}) {
    const args = ['show', '-t', file, entry];
    const result = await run(this.requireKeepass(), [...(keyFile ? ['-k', keyFile] : []), ...(noPassword ? ['--no-password'] : []), ...args], {
      timeout: 60000,
      env: this.env,
      input: noPassword ? '' : lines([databasePassword]),
      allowFailure: true,
    });
    if (result.code !== 0) {
      if (/no TOTP/i.test(`${result.stdout}${result.stderr}`)) return { available: false, code: null };
      throw new Error(cleanError(result.stderr || result.stdout) || 'Could not read TOTP.');
    }
    const code = String(result.stdout).split(/\r?\n/).map(line => line.trim()).find(line => /^\d{6,8}$/.test(line));
    return { available: Boolean(code), code: code ?? null };
  }

  async ensureGroup({ file, group, databasePassword, noPassword = false, keyFile }) {
    if (!group || group === '/') return;
    const parts = group.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const args = ['mkdir', file, current];
      const result = await run(this.requireKeepass(), [...(keyFile ? ['-k', keyFile] : []), ...(noPassword ? ['--no-password'] : []), ...args], {
        timeout: 60000,
        env: this.env,
        input: noPassword ? '' : lines([databasePassword]),
        allowFailure: true,
      });
      if (result.code !== 0 && !/already exists/i.test(`${result.stderr}${result.stdout}`)) {
        throw new Error(cleanError(result.stderr || result.stdout) || `Could not create group ${current}.`);
      }
    }
  }

  async addEntry({ file = this.kdbxPath, entry, username, secret, url, notes, group, databasePassword, noPassword = false, keyFile } = {}) {
    if (!entry) throw new Error('An entry title is required.');
    const entryPath = group && group !== '/' ? `${group.replace(/\/+$/, '')}/${entry}` : entry;
    await this.ensureGroup({ file, group, databasePassword, noPassword, keyFile });
    const args = ['add'];
    if (username !== undefined) args.push('-u', username);
    if (url) args.push('--url', url);
    if (notes) args.push('--notes', notes);
    if (secret !== undefined) args.push('-p');
    args.push(file, entryPath);
    // Prompt order for `add -p`: database password, then the new entry password.
    const prompts = secret !== undefined ? [secret] : [];
    await this.keepass(args, { databasePassword, prompts, noPassword, keyFile });
    return { path: entryPath, created: true };
  }

  async updateEntry({ file = this.kdbxPath, entry, username, secret, url, notes, databasePassword, noPassword = false, keyFile } = {}) {
    if (!entry) throw new Error('An entry path is required.');
    const args = ['edit'];
    let changed = false;
    if (username !== undefined) { args.push('-u', username); changed = true; }
    if (url !== undefined) { args.push('--url', url); changed = true; }
    if (notes !== undefined) { args.push('--notes', notes); changed = true; }
    if (secret !== undefined) { args.push('-p'); changed = true; }
    if (!changed) throw new Error('Nothing to update: give at least one of username, password, url or notes.');
    args.push(file, entry);
    const prompts = secret !== undefined ? [secret] : [];
    await this.keepass(args, { databasePassword, prompts, noPassword, keyFile });
    return { path: entry, updated: true, fields: Object.keys({ username, password: secret, url, notes }).filter(key => ({ username, password: secret, url, notes })[key] !== undefined) };
  }

  async deleteEntry({ file = this.kdbxPath, entry, databasePassword, noPassword = false, keyFile } = {}) {
    if (!entry) throw new Error('An entry path is required.');
    if (!file) throw new Error('No database path is configured.');
    const output = await this.keepass(['rm', file, entry], { databasePassword, noPassword, keyFile });
    return { path: entry, deleted: true, recyclable: /recycled/i.test(output), output: cleanError(output) || 'Entry moved to the recycle bin.' };
  }

  async databaseInfo({ file = this.kdbxPath, databasePassword, noPassword = false, keyFile } = {}) {
    const output = await this.keepass(['db-info', file], { databasePassword, noPassword, keyFile });
    const info = {};
    for (const raw of output.split(/\r?\n/)) {
      const match = raw.trim().match(/^([^:]+):\s?(.*)$/);
      if (match) info[match[1].trim()] = match[2];
    }
    return info;
  }

  // -------------------------------------------------------------- VeraCrypt

  async veracrypt(args, { password, timeout = 300000, allowFailure = false } = {}) {
    const cli = this.requireVeracrypt();
    const base = ['--text', '--non-interactive'];
    if (password !== undefined) base.push('--stdin');
    const result = await run(cli, [...base, ...args], { timeout, env: this.env, input: password !== undefined ? lines([password]) : '', allowFailure });
    return result;
  }

  async veracryptVersion() { return this.version('veracrypt'); }

  async createVolume({ file = this.volumePath, password, sizeBytes = 512 * 1024 * 1024, filesystem = 'fat', encryption = 'AES', hash = 'SHA-512', quick = true, pim, overwrite = false } = {}) {
    if (!file) throw new Error('No volume path was given and no default volume is configured.');
    if (!password) throw new Error('A password is required to create a VeraCrypt volume.');
    if (!overwrite && (await exists(file))) {
      const error = new Error(`A volume already exists at ${file}. Refusing to overwrite it.`);
      error.code = 'already_exists';
      throw error;
    }
    if (sizeBytes < 1024 * 1024) throw new Error('Volume size must be at least 1 MiB.');
    await mkdir(path.dirname(file), { recursive: true });
    const args = ['--create', file, `--size=${Math.round(sizeBytes)}`, `--encryption=${encryption}`, `--hash=${hash}`, `--filesystem=${filesystem}`, '--volume-type=normal'];
    if (quick) args.push('--quick');
    if (pim) args.push(`--pim=${pim}`);
    if (overwrite) args.push('--force');
    const result = await this.veracrypt(args, { password, timeout: 900000 });
    const text = `${result.stdout}${result.stderr}`;
    return {
      file,
      created: /successfully created/i.test(text),
      size_bytes: Math.round(sizeBytes),
      filesystem,
      encryption,
      hash,
      quick_format: Boolean(quick),
      pim: pim ?? null,
      quick_format_warning: quick ? 'Quick format skips randomising free space; disable it for plausible deniability.' : null,
    };
  }

  async mountVolume({ file = this.volumePath, mountPoint = this.mountPoint, password, pim, keyFiles, mountOptions, readOnly = false, confirm = false, slot } = {}) {
    if (!file) throw new Error('No volume path was given and no default volume is configured.');
    if (!mountPoint) throw new Error('No mount point is configured.');
    if (!password) throw new Error('A password is required to mount the volume.');
    await mkdir(mountPoint, { recursive: true }).catch(() => {});
    const args = ['--mount', file, mountPoint];
    if (pim) args.push(`--pim=${pim}`);
    if (keyFiles?.length) args.push(`--keyfiles=${keyFiles.join(',')}`);
    if (slot) args.push(`--slot=${slot}`);
    const options = [mountOptions, readOnly ? 'ro' : null].filter(Boolean).join(',');
    if (options) args.push(`-m=${options}`);
    if (confirm) args.push('--force');
    // A refused mount (missing driver, FUSE, permission) is a normal outcome to
    // report, not an exception: the caller needs the reason to help the user.
    const result = await this.veracrypt(args, { password, timeout: 300000, allowFailure: true });
    const text = `${result.stdout}${result.stderr}`;
    const mounted = result.code === 0 && /mounted/i.test(text) && !/failed|error/i.test(text);
    return {
      mounted,
      file,
      mount_point: mountPoint,
      read_only: Boolean(readOnly),
      pim: pim ?? null,
      message: cleanError(text) || null,
      hint: mounted ? null : 'Mounting needs the VeraCrypt driver (Windows/macOS: install the official package, macFUSE on macOS) or FUSE plus permission to mount as this user (Linux).',
    };
  }

  async unmountVolume({ mountPoint = this.mountPoint, all = false } = {}) {
    const args = all || !mountPoint ? ['-u'] : ['-u', mountPoint];
    const result = await this.veracrypt(args, { timeout: 120000, allowFailure: true });
    const text = `${result.stdout}${result.stderr}`;
    return {
      unmounted: result.code === 0 && !/error|failed/i.test(text),
      mount_point: all || !mountPoint ? null : mountPoint,
      message: cleanError(text) || (result.code === 0 ? 'Volume unmounted.' : 'Unmount failed.'),
    };
  }

  async listVolumes() {
    if (!this.veracryptCli) return { available: false, mounted: [], slots: [] };
    const result = await this.veracrypt(['-l', '-v'], { timeout: 60000, allowFailure: true });
    const text = `${result.stdout}${result.stderr}`;
    if (/no volumes mounted/i.test(text)) return { available: true, mounted: [], slots: [] };
    const mounted = parseMountList(text);
    return { available: true, mounted, slots: mounted.map(item => item.slot) };
  }

  async volumeProperties({ file = this.volumePath, password, pim } = {}) {
    const args = ['--volume-properties', file];
    if (pim) args.push(`--pim=${pim}`);
    const result = await this.veracrypt(args, { password, timeout: 180000 });
    const properties = {};
    for (const raw of `${result.stdout}`.split(/\r?\n/)) {
      const match = raw.trim().match(/^([^:]+):\s?(.*)$/);
      if (match) properties[match[1].trim()] = match[2];
    }
    return properties;
  }

  async databaseExists(file = this.kdbxPath) {
    if (!file) return false;
    try { await access(file); return true; } catch { return false; }
  }
}
