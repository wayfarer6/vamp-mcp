// VAMP Vault — thin, auditable wrapper around keepassxc-cli and veracrypt.
//
// Only this module talks to the two CLI programs. Passwords reach them over
// stdin (or VeraCrypt's native Windows dialog, never argv), and every
// method returns plain data instead of printing anything.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import { cleanError, probeCli, run } from './downloader.mjs';
import { renameGroupProgram } from './group_rename.mjs';

/** keepassxc-cli wants one password per line on stdin. */
const lines = values => values.filter(value => value !== undefined && value !== null).map(value => `${value}\n`).join('');

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
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
export function parseEntryList(text, emptyMarkers = []) {
  const entries = [];
  const groups = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.endsWith('/')) groups.push(line.replace(/\/$/, ''));
    else {
      const parent = path.posix.dirname(line);
      const entry = { path: line, group: parent === '.' ? '/' : parent, title: path.posix.basename(line) };
      (/^\[(?:empty|비어 있음)\]$/iu.test(entry.title) ? emptyMarkers : entries).push(entry);
    }
  }
  return { entries, groups };
}

/** VeraCrypt lists slots either as a compact line or as named fields. */
export function parseMountList(text) {
  const mounted = [];
  let current;
  const flush = () => {
    if (current?.volume && current.device) mounted.push(current);
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const slot = line.match(/^Slot:\s*(\d+)$/i);
    if (slot) {
      flush();
      current = { slot: Number(slot[1]), mount_point: '' };
      continue;
    }
    if (current) {
      const attribute = line.match(/^(Volume|Virtual Device|Mount Directory|Read-Only):\s*(.*)$/i);
      if (!attribute) continue;
      const key = attribute[1].toLowerCase();
      if (key === 'volume') current.volume = attribute[2];
      else if (key === 'virtual device') current.device = attribute[2];
      else if (key === 'mount directory') current.mount_point = attribute[2];
      else if (/^(yes|no)$/i.test(attribute[2])) current.read_only = /^yes$/i.test(attribute[2]);
      continue;
    }
    if (!line || /no volumes mounted/i.test(line)) continue;
    const match = line.match(/^(\d+):\s+(\S+)\s+(\S+)\s+(\S.*)$/);
    if (match) mounted.push({ slot: Number(match[1]), volume: match[2], device: match[3], mount_point: match[4].trim() });
  }
  flush();
  return mounted;
}

const canonicalPath = file => realpath(file).catch(() => path.resolve(file));

/**
 * Split a title a person typed ("Social/Naver") into a group and an entry name,
 * so "add" can create the group and the database keeps a real path. A leading
 * slash is ignored; a trailing slash leaves no entry name and is reported.
 */
export function splitEntryPath(value) {
  const raw = String(value ?? '').trim().replace(/^\/+/, '');
  const slash = raw.lastIndexOf('/');
  if (slash <= 0) return { raw, group: undefined, entry: raw, path: raw };
  const group = raw.slice(0, slash).replace(/\/+$/, '');
  const entry = raw.slice(slash + 1).trim();
  return { raw, group, entry, path: group ? `${group}/${entry}` : entry };
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
      const result = await probeCli(cli, tool, { platform: this.platform, env: this.env });
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
    const emptyMarkers = [];
    const listing = parseEntryList(output, emptyMarkers);
    // KeePassXC prints a synthetic path for empty folders, but users can
    // also give an actual entry that title. Look up only these ambiguous rows.
    for (const item of emptyMarkers) {
      const prefix = group.replace(/^\/+|\/+$/g, '');
      const entry = prefix ? `${prefix}/${item.path}` : item.path;
      try {
        await this.showEntry({ file, entry, databasePassword, noPassword, keyFile, showProtected: false });
        listing.entries.push(item);
      } catch (error) {
        if (error.code !== 'entry_not_found') throw error;
      }
    }
    return listing;
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
      if (/could not find entry|no such entry|항목을 찾을 수 없습니다/i.test(error.message)) {
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
      if (/no TOTP|TOTP가 설정되지 않았습니다/iu.test(`${result.stdout}${result.stderr}`)) return { available: false, code: null };
      throw new Error(cleanError(result.stderr || result.stdout) || 'Could not read TOTP.');
    }
    const code = String(result.stdout).split(/\r?\n/).map(line => line.trim()).find(line => /^\d{6,8}$/.test(line));
    return { available: Boolean(code), code: code ?? null };
  }

  async placeholderFieldPresent({ file = this.kdbxPath, entry, field, databasePassword }) {
    if (field === 'totp') return (await this.totp({ file, entry, databasePassword })).available;
    const attribute = { username: 'UserName', password: 'Password' }[field];
    if (!attribute) return false;
    const output = await this.keepass(['show', '-q', '-s', '-a', attribute, '--', file, entry], {
      databasePassword, timeout: 5000,
    });
    return output.replace(/\r?\n$/, '').length > 0;
  }

  async requireGroupCommand(command) {
    if (!this.groupCommands) {
      const help = await this.keepass(['help'], {timeout:5000});
      const names = help.split(/\r?\n/u).map(line=>/^\s*([a-z][a-z-]*)\s{2,}\S/u.exec(line)?.[1]).filter(Boolean);
      if (!names.includes('ls') || !names.includes('add')) {
        throw new Error('Could not verify the available KeePassXC CLI commands.');
      }
      this.groupCommands = new Set(names);
    }
    if (!this.groupCommands.has(command)) {
      const error = new Error(`KeePassXC CLI does not provide "${command}". Update KeePassXC and retry this group operation.`);
      error.code = 'cli_too_old';
      throw error;
    }
  }

  async ensureGroup({ file, group, databasePassword, noPassword = false, keyFile }) {
    if (!group || group === '/') return;
    await this.requireGroupCommand('mkdir');
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
      if (result.code !== 0 && !/already exists|이미 존재/i.test(`${result.stderr}${result.stdout}`)) {
        throw new Error(cleanError(result.stderr || result.stdout) || `Could not create group ${current}.`);
      }
    }
  }

  async moveEntry({ file = this.kdbxPath, entry, group, databasePassword }) {
    await this.requireGroupCommand('mv');
    const target = group === '/' ? path.posix.basename(entry) : `${group}/${path.posix.basename(entry)}`;
    const { entries, groups } = await this.listEntries({ file, databasePassword });
    if (entries.filter(item => item.path === entry).length !== 1) throw new Error('Choose one unique entry.');
    if (group !== '/' && groups.filter(item => item === group).length !== 1) throw new Error('Choose an existing unique group.');
    if (entry === target) return target;
    if (entries.some(item => item.path === target)) throw new Error('The destination already contains an entry with that title.');
    await this.keepass(['mv', '--', file, entry, group], { databasePassword });
    return target;
  }

  async recycleGroup({ file = this.kdbxPath, group, recursive = false, databasePassword }) {
    if (!group || group.split('/').some(part => !part.trim() || part === '.' || part === '..' || /[\x00-\x1f\x7f]/u.test(part))) {
      throw new Error('Choose a valid non-root group.');
    }
    await this.requireGroupCommand('rmdir');
    const database = await realpath(file);
    const temporary = await mkdtemp(path.join(path.dirname(database), '.vamp-group-'));
    const staged = path.join(temporary, 'vault.kdbx');
    try {
      await copyFile(database, staged);
      const original = await hashFile(staged);
      const credentials = { file: staged, databasePassword };
      const { entries, groups } = await this.listEntries(credentials);
      if (groups.filter(item => item === group).length !== 1) throw new Error('Choose an existing unique group.');
      const prefix = group + '/';
      if (!recursive && (groups.some(item => item.startsWith(prefix)) || entries.some(item => item.path.startsWith(prefix)))) {
        throw new Error('This group is not empty. Explicit recursive confirmation is required.');
      }
      // rmdir may permanently delete a group if recycling is disabled or the
      // group is already in the recycle bin. Apply it only to a staged copy.
      const result = await this.keepass(['rmdir', '--', staged, group], { databasePassword });
      const recycled = [`Successfully recycled group ${group}.`, `그룹 ${group}을(를) 휴지통으로 이동했습니다.`];
      if (!result.split(/\r?\n/u).some(line => recycled.includes(line.trim()))) {
        throw new Error('KeePassXC did not confirm moving the group to the recycle bin. The original vault was preserved.');
      }
      if (await hashFile(database) !== original) throw new Error('The vault changed during this operation. Review and retry.');
      await rename(staged, database);
      return { status: 'recycled', group };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async renameGroup({ file = this.kdbxPath, group, name, databasePassword }) {
    const plainName=value=>typeof value==='string'&&value.length>0&&value.trim()===value&&
      value!=='.'&&value!=='..'&&!/[/\x00-\x1f\x7f]/u.test(value);
    if(typeof group!=='string'||!group.split('/').every(plainName)||!plainName(name)) {
      throw new Error('Choose a non-root group and one new group name.');
    }
    const database=await realpath(file);
    const temporary=await mkdtemp(path.join(path.dirname(database),'.vamp-group-'));
    const staged=path.join(temporary,'vault.kdbx');
    try{
      await copyFile(database,staged);
      const original=await hashFile(staged);
      const python=this.env.VAULT_KDBX_PYTHON || (this.platform==='win32'?'python':'python3');
      const response=await run(python,['-c',renameGroupProgram],{
        env:this.env,input:JSON.stringify({file:staged,password:databasePassword,group,name}),timeout:30000,
      }).catch(()=>null);
      let status;
      try{status=JSON.parse(response?.stdout).status;}catch{}
      if(status==='dependency_missing'||!response){
        const error=new Error('Group rename requires Python with pykeepass==4.2.0. Configure VAULT_KDBX_PYTHON to use it.');
        error.code='group_editor_unavailable';throw error;
      }
      const separator=group.lastIndexOf('/');
      const renamed=separator<0?name:group.slice(0,separator+1)+name;
      if(status==='unchanged')return {status,path:group};
      if(status==='group_exists')throw new Error('The destination group already exists.');
      if(status==='group_missing_or_ambiguous')throw new Error('Choose an existing unique group.');
      if(status==='recycle_bin')throw new Error('Choose a group outside the recycle bin.');
      if(status!=='renamed')throw new Error('Could not verify an intact renamed vault. The original was preserved.');
      const listing=await this.listEntries({file:staged,databasePassword});
      if(!listing.groups.includes(renamed)||listing.groups.includes(group))throw new Error('KeePassXC could not verify the renamed group.');
      if(this.platform!=='win32')await chmod(staged,(await stat(database)).mode & 0o777);
      if(await hashFile(database)!==original)throw new Error('The vault changed during this operation. Review and retry.');
      await rename(staged,database);
      return {status,path:renamed};
    }finally{await rm(temporary,{recursive:true,force:true});}
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
    return { path: entry, deleted: true, recyclable: /recycled|휴지통으로 이동/i.test(output), output: cleanError(output) || 'Entry moved to the recycle bin.' };
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
    if (this.platform === 'win32') throw new Error('Use the native Windows VeraCrypt operation; Unix console arguments are unsupported.');
    const base = ['--text', '--non-interactive'];
    if (password !== undefined) base.push('--stdin');
    const result = await run(cli, [...base, ...args], { timeout, env: this.env, input: password !== undefined ? lines([password]) : '', allowFailure });
    return result;
  }

  async veracryptVersion() { return this.version('veracrypt'); }

  async createVolume({ file = this.volumePath, password, sizeBytes = 512 * 1024 * 1024, filesystem = 'fat', encryption = 'AES', hash = 'SHA-512', quick = true, pim, overwrite = false, headless = false } = {}) {
    if (!file) throw new Error('No volume path was given and no default volume is configured.');
    if (!password && (this.platform !== 'win32' || headless)) throw new Error('A password is required to create a VeraCrypt volume.');
    if (!overwrite && (await exists(file))) {
      const error = new Error(`A volume already exists at ${file}. Refusing to overwrite it.`);
      error.code = 'already_exists';
      throw error;
    }
    if (sizeBytes < 1024 * 1024) throw new Error('Volume size must be at least 1 MiB.');
    await mkdir(path.dirname(file), { recursive: true });
    if (this.platform === 'win32' && !headless) {
      const wizard = path.join(path.dirname(this.requireVeracrypt()), 'VeraCrypt Format.exe');
      await access(wizard);
      const process = spawn(wizard, [], { env: this.env, stdio: 'ignore', windowsHide: false });
      await new Promise((resolve, reject) => { process.once('spawn', resolve); process.once('error', reject); });
      process.unref();
      return { status: 'interactive_setup_required', created: false, file, size_bytes: sizeBytes,
        wizard_pid: process.pid, hint: 'Complete volume creation in the native VeraCrypt wizard. Enter the volume password there; it is not passed on the command line.' };
    }
    const args = ['--create', file, `--size=${Math.round(sizeBytes)}`, `--encryption=${encryption}`, `--hash=${hash}`, `--filesystem=${filesystem}`, '--volume-type=normal'];
    if (quick) args.push('--quick');
    if (pim) args.push(`--pim=${pim}`);
    if (overwrite) args.push('--force');
    const result = this.platform === 'win32'
      ? await this.createVolumeViaWsl(file, args, password)
      : await this.veracrypt(args, { password, timeout: 900000 });
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

  async createVolumeViaWsl(file, args, password) {
    const target = await this.windowsVolumePathInWsl(file);
    return this.wslVeraCrypt(['--create', target, ...args.slice(2)], { password, timeout: 900000 });
  }

  async wrapGuestVolumeViaWsl(container, vhd, sizeBytes) {
    try {
      const [source, destination] = await Promise.all([container, vhd].map(file => this.windowsVolumePathInWsl(file)));
      await this.wslCommand(['/usr/bin/qemu-img', 'convert', '-f', 'raw', '-O', 'vpc',
        '-o', 'subformat=fixed,force_size=on', source, destination], { timeout: 900000 });
      const { stdout } = await this.wslCommand(['/usr/bin/qemu-img', 'info', '-f', 'vpc', '--output=json', destination]);
      if (JSON.parse(stdout)['virtual-size'] !== sizeBytes || (await stat(vhd)).size !== sizeBytes + 512) {
        throw new Error('Unexpected VHD size');
      }
    } catch {
      const error = new Error('Could not create a fixed guest VHD. Check that /usr/bin/qemu-img is installed in the configured WSL distribution and there is space for both staging files.');
      error.code = 'guest_vhd_failed';
      throw error;
    }
  }

  async wslCommand(args, { root = false, ...options } = {}) {
    const distribution = this.env.VAULT_VERACRYPT_WSL_DISTRO;
    if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,63}$/.test(distribution ?? '')) {
      throw new Error('Configure VAULT_VERACRYPT_WSL_DISTRO with an installed WSL distribution.');
    }
    const wsl = path.win32.join(this.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
    return run(wsl, ['--distribution', distribution, ...(root ? ['--user','root'] : []), '--exec', ...args],
      { env:this.env, timeout:30000, ...options });
  }

  async windowsVolumePathInWsl(file) {
    if (!/^[a-z]:[\\/]/i.test(file)) throw new Error('Use an absolute Windows drive path for the volume.');
    const translated = await this.wslCommand(['/usr/bin/wslpath','-a','-u',file.replace(/\\/g,'/')]);
    const target = translated.stdout.trim();
    if (!target.startsWith('/') || /[\x00-\x1f]/.test(target)) throw new Error('WSL could not translate the Windows volume path.');
    return target;
  }

  async wslVeraCrypt(args, { password, ...options } = {}) {
    const executable = this.env.VAULT_VERACRYPT_WSL_CLI || '/usr/bin/veracrypt';
    if (!/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(executable)) throw new Error('Use an absolute WSL VeraCrypt executable.');
    return this.wslCommand(['/usr/bin/env','LC_ALL=C',executable,'--text','--non-interactive',
      ...(password ? ['--stdin'] : []),...args], { ...options, input:lines([password]) });
  }

  async listWslVolumes() {
    const result = await this.wslVeraCrypt(['--list','--verbose'],{ root:true,allowFailure:true });
    const output = result.stdout + result.stderr;
    if (/no volumes mounted/i.test(output)) return [];
    const mounted = parseMountList(output);
    if (result.code !== 0 || (output.trim() && !mounted.length)) throw new Error('Could not verify WSL VeraCrypt mounts.');
    return mounted;
  }

  async mountVolumeViaWsl({ file,mountPoint,password,readOnly = false }) {
    if (!/^\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+$/.test(mountPoint) || !password) {
      throw new Error('Provide a dedicated absolute WSL mount directory.');
    }
    const canonical = await this.wslCommand(['/usr/bin/realpath','-e','--',mountPoint],{root:true});
    if (canonical.stdout.trim() !== mountPoint) throw new Error('Use the canonical path of the WSL mount directory.');
    const occupied = await this.wslCommand(['/usr/bin/findmnt','--mountpoint',mountPoint],{root:true,allowFailure:true});
    const contents = await this.wslCommand(['/usr/bin/find',mountPoint,'-mindepth','1','-maxdepth','1','-print','-quit'],{root:true});
    if (occupied.code !== 1 || contents.stdout.trim()) throw new Error('The WSL mount directory must be empty and unused.');
    const volume = await this.windowsVolumePathInWsl(file);
    const [uid,gid] = await Promise.all(['-u','-g'].map(async flag =>
      (await this.wslCommand(['/usr/bin/id',flag])).stdout.trim()));
    if (![uid,gid].every(value=>/^\d{1,10}$/.test(value))) throw new Error('Could not verify the default WSL user and group.');
    const result = await this.wslVeraCrypt(['--mount',volume,mountPoint,'--protect-hidden=no','--keyfiles=',
      `--fs-options=uid=${uid},gid=${gid},umask=0077`,
      ...(readOnly ? ['--mount-options=ro'] : [])],{password,root:true,timeout:120000,allowFailure:true});
    const mounted = result.code === 0 && (await this.listWslVolumes()).some(item=>
      item.volume===volume && item.mount_point===mountPoint && (!readOnly || item.read_only===true));
    return {mounted,file,mount_point:mountPoint,read_only:readOnly,backend:'wsl'};
  }

  async unmountVolumeViaWsl(mountPoint) {
    const mounts = await this.listWslVolumes();
    if (mounts.filter(item=>item.mount_point===mountPoint).length !== 1) {
      throw new Error('Choose one mounted VeraCrypt directory inside the configured WSL distribution.');
    }
    const result = await this.wslVeraCrypt(['--unmount',mountPoint],{root:true,timeout:120000,allowFailure:true});
    const unmounted = result.code===0 && !(await this.listWslVolumes()).some(item=>item.mount_point===mountPoint);
    return {unmounted,mount_point:mountPoint,backend:'wsl'};
  }

  async mountVolume({ file = this.volumePath, mountPoint = this.mountPoint, password, pim, keyFiles, mountOptions, readOnly = false, confirm = false, slot } = {}) {
    if (!file) throw new Error('No volume path was given and no default volume is configured.');
    if (!mountPoint) throw new Error('No mount point is configured.');
    if (this.platform === 'win32') {
      const letter = String(mountPoint).match(/^([a-z]):\\?$/i)?.[1]?.toUpperCase();
      if (!letter) throw new Error('Use a Windows drive letter such as V: for the mount point.');
      if (!(await exists(file))) throw new Error('The volume file does not exist.');
      if (await exists(`${letter}:\\`)) throw new Error('The selected drive letter is already in use.');
      const args = ['/q', '/v', file, '/l', letter, '/m', 'rm', '/c', 'n', '/h', 'n'];
      if (readOnly) args.push('/m', 'ro');
      if (pim) args.push('/pim', String(pim));
      for (const key of keyFiles ?? []) args.push('/k', key);
      // The native password dialog keeps the password out of argv and MCP output.
      const result = await run(this.requireVeracrypt(), args, { timeout: 300000, env: this.env, allowFailure: true });
      const mounted = (await this.listVolumes()).mounted.some(item => item.mount_point === `${letter}:`);
      return { mounted, file, mount_point: `${letter}:`, read_only: Boolean(readOnly),
        password_source: 'native_windows_dialog', exit_code: result.code };
    }
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
    const [volumePath, mountPath] = await Promise.all([canonicalPath(file), canonicalPath(mountPoint)]);
    const listed = result.code === 0 ? (await this.listVolumes()).mounted : [];
    const mounted = listed.some(item => item.volume === volumePath && item.mount_point === mountPath &&
      (!readOnly || item.read_only === true));
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
    if (this.platform === 'win32') {
      const letter = String(mountPoint ?? '').match(/^([a-z]):\\?$/i)?.[1]?.toUpperCase();
      if (!all && !letter) throw new Error('Use a Windows drive letter such as V: for the mount point.');
      const result = await run(this.requireVeracrypt(), ['/q', '/u', ...(all ? [] : [letter])], { timeout: 120000, env: this.env, allowFailure: true });
      const remaining = (await this.listVolumes()).mounted;
      return { unmounted: result.code === 0 && (all ? remaining.length === 0 : !remaining.some(item => item.mount_point === `${letter}:`)),
        mount_point: all ? null : `${letter}:`, exit_code: result.code };
    }
    const args = all || !mountPoint ? ['-u'] : ['-u', mountPoint];
    const canonical = mountPoint ? await canonicalPath(mountPoint) : null;
    const result = await this.veracrypt(args, { timeout: 120000, allowFailure: true });
    const text = `${result.stdout}${result.stderr}`;
    const remaining = result.code === 0 ? (await this.listVolumes()).mounted : [];
    const unmounted = result.code === 0 && (all || !canonical ? remaining.length === 0 :
      !remaining.some(item => item.mount_point === canonical));
    return {
      unmounted,
      mount_point: all || !mountPoint ? null : mountPoint,
      message: cleanError(text) || (unmounted ? 'Volume unmounted.' : 'Unmount failed.'),
    };
  }

  async listVolumes({ probeNative = false } = {}) {
    if (!this.veracryptCli && !(probeNative && this.platform === 'win32')) return { available: false, mounted: [], slots: [] };
    if (this.platform === 'win32') {
      const script = `Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class VAMPDrive { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint QueryDosDevice(string name, StringBuilder target, int length); }';
        $items=@(foreach($drive in [IO.DriveInfo]::GetDrives()) { $name=$drive.Name.Substring(0,2); $buffer=[Text.StringBuilder]::new(4096); if([VAMPDrive]::QueryDosDevice($name,$buffer,4096) -and $buffer.ToString() -match '^\\\\Device\\\\(?:VeraCrypt|TrueCrypt)Volume') { @{mount_point=$name;device=$buffer.ToString();volume=$null;slot=[int][char]$name[0]-64} } });
        ConvertTo-Json -InputObject $items -Compress`;
      const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30000, env: this.env });
      const mounted = JSON.parse(result.stdout || '[]');
      return { available: true, mounted, slots: mounted.map(item => item.slot) };
    }
    const result = await this.veracrypt(['-l', '-v'], { timeout: 60000, allowFailure: true });
    const text = `${result.stdout}${result.stderr}`;
    if (/no volumes mounted/i.test(text)) return { available: true, mounted: [], slots: [] };
    const mounted = parseMountList(text);
    if (result.code !== 0 || (text.trim() && mounted.length === 0)) {
      throw new Error('VeraCrypt did not return a valid mounted-volume list.');
    }
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
