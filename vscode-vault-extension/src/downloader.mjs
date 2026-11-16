// VAMP Vault — platform CLI resolver and downloader.
//
// Finds a usable KeePassXC CLI / VeraCrypt CLI on this machine and, when there
// is none, downloads the official portable build for the current OS and CPU
// into the extension's global storage, verifying the publisher checksum first.
//
// Everything here is best-effort by design: every entry point returns a
// structured report instead of throwing, so the MCP server and the extension
// can tell the user what is missing and how to fix it.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const GITHUB_API = 'https://api.github.com';

export const TOOLS = {
  keepassxc: {
    id: 'keepassxc',
    label: 'KeePassXC CLI',
    binaries: { win32: ['keepassxc-cli.exe'], default: ['keepassxc-cli'] },
    repo: 'keepassxreboot/keepassxc',
    versionArgs: ['--version'],
    manual: {
      win32: 'winget install --id Microsoft.VCRedist.2015+.x64 -e; if ($LASTEXITCODE -eq 0) { winget install --id KeePassXCTeam.KeePassXC -e }',
      darwin: 'brew install keepassxc',
      linux: 'sudo apt install keepassxc   # or: flatpak install flathub org.keepassxc.KeePassXC',
    },
  },
  veracrypt: {
    id: 'veracrypt',
    label: 'VeraCrypt CLI',
    binaries: { win32: ['veracrypt.exe', 'VeraCrypt.exe'], default: ['veracrypt'] },
    repo: 'veracrypt/VeraCrypt',
    versionArgs: ['--version'],
    manual: {
      win32: 'winget install --id VeraCrypt.VeraCrypt -e',
      darwin: 'brew install --cask veracrypt   # then install macFUSE when prompted',
      linux: 'sudo apt install veracrypt   # or download the console build for your distribution',
    },
  },
};

const isWindows = platform => platform === 'win32';

export function binaryName(tool, platform = process.platform) {
  const names = TOOLS[tool]?.binaries?.[isWindows(platform) ? 'win32' : 'default'] ?? [];
  return names[0];
}

/** Normalise Node's platform/arch pairs onto the pairs the vendors publish. */
export function detectPlatform(platform = process.platform, arch = process.arch) {
  const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[platform] ?? platform;
  const cpu = { x64: 'x64', arm64: 'arm64', ia32: 'x86', arm: 'arm' }[arch] ?? arch;
  return { platform, arch, os, cpu, supported: os === 'windows' || os === 'macos' || os === 'linux' };
}

function executableNames(tool, platform) {
  return TOOLS[tool]?.binaries?.[isWindows(platform) ? 'win32' : 'default'] ?? [];
}

async function isExecutableFile(candidate) {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    await access(candidate, isWindows() ? 0 : 1); // F_OK on Windows, X_OK elsewhere
    return true;
  } catch {
    return false;
  }
}

/** Scan PATH the way `which`/`where` would, honouring PATHEXT on Windows. */
export async function findOnPath(tool, { platform = process.platform, env = process.env } = {}) {
  const names = executableNames(tool, platform);
  if (!names.length) return null;
  const pathValue = env.PATH ?? env.Path ?? '';
  const separator = isWindows(platform) ? ';' : ':';
  const extensions = isWindows(platform)
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const directory of pathValue.split(separator).filter(Boolean)) {
    for (const name of names) {
      const candidates = name.includes('.') ? [name] : extensions.map(extension => name + extension.toLowerCase());
      for (const candidate of candidates) {
        const full = path.join(directory, candidate);
        if (await isExecutableFile(full)) return full;
      }
    }
  }
  return null;
}

/** Well known install locations, used when the binary is not on PATH. */
export function standardLocations(tool, platform = process.platform, env = process.env) {
  if (tool === 'keepassxc') {
    if (platform === 'win32') {
      return [
        env.ProgramFiles && path.join(env.ProgramFiles, 'KeePassXC', 'keepassxc-cli.exe'),
        env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'KeePassXC', 'keepassxc-cli.exe'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'KeePassXC', 'keepassxc-cli.exe'),
      ];
    }
    if (platform === 'darwin') {
      return [
        '/Applications/KeePassXC.app/Contents/MacOS/keepassxc-cli',
        '/opt/homebrew/bin/keepassxc-cli',
        '/usr/local/bin/keepassxc-cli',
      ];
    }
    return ['/usr/bin/keepassxc-cli', '/usr/local/bin/keepassxc-cli', '/snap/bin/keepassxc-cli', '/var/lib/flatpak/exports/bin/org.keepassxc.KeePassXC'];
  }
  if (platform === 'win32') {
    return [
      env.ProgramFiles && path.join(env.ProgramFiles, 'VeraCrypt', 'VeraCrypt.exe'),
      env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'VeraCrypt', 'VeraCrypt.exe'),
    ];
  }
  if (platform === 'darwin') {
    return ['/Applications/VeraCrypt.app/Contents/MacOS/veracrypt', '/usr/local/bin/veracrypt', '/opt/homebrew/bin/veracrypt'];
  }
  return ['/usr/bin/veracrypt', '/usr/local/bin/veracrypt', '/snap/bin/veracrypt'];
}

export function cliVersionArgs(tool, platform = process.platform) {
  if (tool === 'veracrypt' && platform !== 'win32') return ['--text', '--version'];
  return TOOLS[tool]?.versionArgs ?? ['--version'];
}

/** Windows VeraCrypt is a GUI executable, not the Unix console program. */
export async function probeCli(command, tool, { platform = process.platform, env = process.env } = {}) {
  if (tool === 'veracrypt' && platform === 'win32') {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-Item -LiteralPath $env:VAMP_PROBE_BINARY -ErrorAction Stop).VersionInfo.ProductVersion'],
    { timeout: 20000, env: { ...env, VAMP_PROBE_BINARY: command } });
  }
  return run(command, cliVersionArgs(tool, platform), { timeout: 20000, env, allowFailure: true });
}

export function manualInstructions(tool, platform = process.platform) {
  return TOOLS[tool]?.manual?.[platform] ?? TOOLS[tool]?.manual?.linux ?? '';
}

/** Run a child process without a shell, resolving with captured output. */
export function run(command, args = [], { timeout = 120000, env = process.env, cwd, input, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      return reject(error);
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`${path.basename(command)} timed out after ${Math.round(timeout / 1000)}s`));
    }, timeout);
    child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 || allowFailure) resolve({ code, stdout, stderr });
      else reject(Object.assign(new Error(cleanError(stderr || stdout) || `${path.basename(command)} exited with code ${code}`), { exitCode: code, stdout, stderr }));
    });
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    } else {
      child.stdin?.end();
    }
  });
}

/** Strip prompts and progress noise so errors can be shown to a person. */
export function cleanError(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !/^Enter password|^Repeat password|^Done:|^Speed:|^Left:|password to unlock/i.test(line))
    .join(' ')
    .slice(0, 500);
}

// ---------------------------------------------------------------- resolution

/**
 * Resolve one CLI: explicit setting, then PATH, then standard locations, then
 * the copy this extension downloaded earlier.
 */
export async function resolveCli(tool, { binDir, override, platform = process.platform, env = process.env, verify = true } = {}) {
  const attempted = [];
  const candidates = [];
  if (override) candidates.push({ path: override, source: 'configured' });
  const onPath = await findOnPath(tool, { platform, env });
  if (onPath) candidates.push({ path: onPath, source: 'system_path' });
  for (const location of standardLocations(tool, platform, env)) {
    if (location) candidates.push({ path: location, source: 'system_location' });
  }
  if (binDir) candidates.push({ path: path.join(binDir, binaryName(tool, platform)), source: 'downloaded' });

  for (const candidate of candidates) {
    if (!candidate.path) continue;
    if (!(await isExecutableFile(candidate.path))) {
      // A configured path that does not exist is a user-visible problem.
      if (candidate.source === 'configured') attempted.push({ ...candidate, reason: 'not found or not executable' });
      continue;
    }
    let version = null;
    if (verify) {
      try {
        const result = await probeCli(candidate.path, tool, { platform, env });
        version = `${result.stdout} ${result.stderr}`.split('\n').map(line => line.trim()).find(line => /\d+\.\d+/.test(line)) ?? null;
        if (!version) {
          // A file that exists but cannot answer --version (missing library, wrong
          // architecture, quarantined) is not usable: report it and keep looking.
          attempted.push({ ...candidate, reason: cleanError(result.stderr || result.stdout) || `exited with code ${result.code}` });
          continue;
        }
      } catch (error) {
        attempted.push({ ...candidate, reason: cleanError(error.message) });
        continue;
      }
    }
    return { tool, available: true, path: candidate.path, source: candidate.source, version, attempted };
  }
  return {
    tool,
    available: false,
    path: null,
    source: null,
    version: null,
    attempted,
    manual_install: manualInstructions(tool, platform),
  };
}

// ------------------------------------------------------------------ download

function selectAsset(tool, release, { platform, arch }) {
  const assets = (release.assets ?? []).filter(asset => /\.(zip|AppImage)$/i.test(asset.name) && !/\.DIGEST$/i.test(asset.name));
  const pick = (pattern, rejectPattern) => assets.find(asset => pattern.test(asset.name) && !(rejectPattern && rejectPattern.test(asset.name)));

  if (tool === 'keepassxc') {
    if (platform === 'linux') {
      return arch === 'arm64' ? pick(/aarch64\.AppImage$/) : pick(/x86_64\.AppImage$/);
    }
    if (platform === 'win32') {
      return arch === 'arm64' ? pick(/-ARM64\.zip$/i) : pick(/-x64\.zip$/i);
    }
    return null; // macOS: the .dmg is an app-bundle installer, Homebrew is the honest route.
  }
  if (tool === 'veracrypt') {
    if (platform === 'linux') {
      return arch === 'arm64'
        ? pick(/aarch64\.AppImage$/, /legacy/)
        : pick(/x86_64\.AppImage$/, /legacy/);
    }
    return null; // Windows/macOS need the signed installer plus a kernel driver and admin rights.
  }
  return null;
}

async function fetchJson(url, { token } = {}) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'vamp-vault/0.1.0 (+https://github.com/wayfarer6/vamp-mcp)',
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!response.ok) return null;
  return response.text();
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex').toUpperCase()));
  });
}

async function download(url, destination, { log = () => {}, timeout = 900000 } = {}) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'vamp-vault/0.1.0 (+https://github.com/wayfarer6/vamp-mcp)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  const total = Number(response.headers.get('content-length') ?? 0);
  const chunks = [];
  let received = 0;
  let lastLog = 0;
  for await (const chunk of response.body) {
    chunks.push(Buffer.from(chunk));
    received += chunk.length;
    const now = Date.now();
    if (now - lastLog > 2000) {
      lastLog = now;
      log(total ? `downloading ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB` : `downloading ${(received / 1048576).toFixed(1)} MiB`);
    }
  }
  await writeFile(destination, Buffer.concat(chunks));
  log(`downloaded ${(received / 1048576).toFixed(1)} MiB`);
  return received;
}

/** Look for the publisher's SHA-256 next to the asset. */
async function expectedChecksum(release, asset) {
  const digestAsset = (release.assets ?? []).find(item => item.name === `${asset.name}.DIGEST`);
  if (digestAsset?.browser_download_url) {
    const text = await fetchText(digestAsset.browser_download_url);
    const match = text?.match(/\b([a-fA-F0-9]{64})\b/);
    if (match) return { value: match[1].toUpperCase(), source: digestAsset.name };
  }
  const sumAsset = (release.assets ?? []).find(item => /sha256(sum)?(\.txt)?$/i.test(item.name) && !/\.sig$/i.test(item.name));
  if (sumAsset?.browser_download_url) {
    const text = await fetchText(sumAsset.browser_download_url);
    if (text) {
      const normalise = value => value.toLowerCase().replace(/[^a-z0-9.]/g, '');
      for (const line of text.split(/\r?\n/)) {
        const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
        if (match && normalise(match[2]) === normalise(asset.name)) return { value: match[1].toUpperCase(), source: sumAsset.name };
      }
    }
  }
  return null;
}

async function extractZip(archive, destination, { platform = process.platform } = {}) {
  const attempts = [
    ['tar', ['-xf', archive, '-C', destination]],
    ['unzip', ['-q', '-o', archive, '-d', destination]],
    ['powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`]],
    ['python3', ['-c', `import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, archive, destination]],
  ];
  const errors = [];
  for (const [command, args] of attempts) {
    try {
      await run(command, args, { timeout: 240000 });
      const entries = await readdir(destination);
      if (entries.length) return { ok: true, extractor: command };
    } catch (error) {
      errors.push(`${command}: ${error.message}`);
    }
  }
  throw new Error(`Could not extract ${path.basename(archive)} (${errors.join('; ')})`);
}

async function findFile(root, names) {
  const wanted = names.map(name => name.toLowerCase());
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (wanted.includes(entry.name.toLowerCase())) return full;
    }
  }
  return null;
}

const LAUNCHER = (appDir, binary) => `#!/bin/sh
# Generated by VAMP Vault. Runs the extracted AppImage binary with its bundled libraries.
APPDIR="${appDir}"
if [ -d "$APPDIR/usr/lib" ]; then
  if [ -n "\${LD_LIBRARY_PATH:-}" ]; then export LD_LIBRARY_PATH="$APPDIR/usr/lib:\${LD_LIBRARY_PATH}"; else export LD_LIBRARY_PATH="$APPDIR/usr/lib"; fi
fi
exec "$APPDIR/${binary}" "$@"
`;

/**
 * Install one CLI for this platform.
 * Returns {status, tool, path?, version?, checksum?, ...}. Never throws.
 */
export async function installCli(tool, { binDir, platform = process.platform, arch = process.arch, log = () => {}, token, assetUrl } = {}) {
  const info = TOOLS[tool];
  if (!info) return { status: 'unknown_tool', tool };
  if (!binDir) return { status: 'failed', tool, error: 'no download directory configured' };
  const plan = detectPlatform(platform, arch);

  try {
    await mkdir(binDir, { recursive: true });
    const release = assetUrl ? null : await fetchJson(`${GITHUB_API}/repos/${info.repo}/releases/latest`, { token });
    const asset = assetUrl
      ? { name: path.basename(new URL(assetUrl).pathname), browser_download_url: assetUrl, size: 0 }
      : selectAsset(tool, release, { platform, arch });
    if (!asset) {
      return {
        status: 'manual_install_required',
        tool,
        platform: plan.os,
        arch: plan.cpu,
        release: release?.tag_name ?? null,
        manual_install: manualInstructions(tool, platform),
        reason: platform === 'linux'
          ? `No ${info.label} build is published for ${plan.os}/${plan.cpu}.`
          : `${info.label} for ${plan.os} ships as an installer that needs administrator rights and, for VeraCrypt, a kernel driver. Install it with the system package manager.`,
      };
    }

    const archive = path.join(binDir, asset.name);
    await download(asset.browser_download_url, archive, { log });
    const size = (await stat(archive)).size;

    let checksum = { status: 'unavailable' };
    try {
      const expected = release ? await expectedChecksum(release, asset) : null;
      if (expected) {
        const actual = await sha256(archive);
        const match = actual === expected.value;
        checksum = { status: match ? 'verified' : 'mismatch', expected: expected.value, actual, source: expected.source };
        if (!match) {
          await rm(archive, { force: true });
          return { status: 'checksum_mismatch', tool, asset: asset.name, checksum };
        }
      }
    } catch (error) {
      checksum = { status: 'unavailable', error: cleanError(error.message) };
    }

    if (checksum.status !== 'verified') {
      await rm(archive, { force: true });
      return { status: 'checksum_unavailable', tool, asset: asset.name, checksum,
        error: 'Publisher SHA-256 unavailable; refusing to execute unverified download.' };
    }

    if (/\.AppImage$/i.test(asset.name)) {
      const executable = binaryName(tool, platform);
      const appImage = path.join(binDir, `${tool}.AppImage`);
      await rename(archive, appImage);
      await chmod(appImage, 0o755);
      const extractDir = path.join(binDir, `${tool}-appimage`);
      await rm(extractDir, { recursive: true, force: true });
      await mkdir(extractDir, { recursive: true });
      const extracted = await run(appImage, ['--appimage-extract'], { cwd: extractDir, timeout: 300000, allowFailure: true });
      const appDir = path.join(extractDir, 'squashfs-root');
      const binary = path.join(appDir, 'usr', 'bin', executable);
      const found = await isExecutableFile(binary);
      if (!found) {
        await rm(extractDir, { recursive: true, force: true });
        await rm(appImage, { force: true });
        return {
          status: 'failed',
          tool,
          asset: asset.name,
          checksum,
          error: `AppImage extraction did not produce usr/bin/${executable}. ${cleanError(extracted.stderr || extracted.stdout)}`.trim(),
          hint: manualInstructions(tool, platform),
        };
      }
      const launcher = path.join(binDir, executable);
      await writeFile(launcher, LAUNCHER(appDir, `usr/bin/${executable}`), { mode: 0o755 });
      await chmod(launcher, 0o755);
      await rm(appImage, { force: true });
      const resolved = await resolveCli(tool, { binDir, platform, env: { ...process.env } });
      if (!resolved.available) {
        // The extraction succeeded but the binary cannot start here (missing
        // system library, wrong architecture). Leave no half-working launcher.
        await rm(launcher, { force: true });
        await rm(extractDir, { recursive: true, force: true });
      }
      return {
        status: resolved.available ? 'installed' : 'failed',
        tool,
        asset: asset.name,
        release: release?.tag_name ?? null,
        checksum,
        path: resolved.available ? launcher : null,
        version: resolved.version ?? null,
        size_bytes: size,
        error: resolved.available ? undefined : (resolved.attempted?.at(-1)?.reason ?? 'the extracted binary did not start'),
        note: 'Extracted from the official AppImage; the launcher sets LD_LIBRARY_PATH to the bundled Qt libraries.',
      };
    }

    const stage = path.join(binDir, `${tool}-unpack`);
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });
    const extract = await extractZip(archive, stage, { platform });
    const executable = binaryName(tool, platform);
    const found = await findFile(stage, executableNames(tool, platform));
    if (!found) {
      return {
        status: 'failed',
        tool,
        asset: asset.name,
        checksum,
        error: `${executable} was not inside ${asset.name}.`,
        hint: manualInstructions(tool, platform),
      };
    }
    const destination = path.join(binDir, executable);
    await copyFile(found, destination);
    if (!isWindows(platform)) await chmod(destination, 0o755);
    await rm(stage, { recursive: true, force: true });
    await rm(archive, { force: true });
    const resolved = await resolveCli(tool, { binDir, platform, env: { ...process.env } });
    if (!resolved.available) await rm(destination, { force: true });
    return {
      status: resolved.available ? 'installed' : 'failed',
      tool,
      asset: asset.name,
      release: release?.tag_name ?? null,
      checksum,
      path: resolved.available ? destination : null,
      version: resolved.version ?? null,
      size_bytes: size,
      extractor: extract.extractor,
      error: resolved.available ? undefined : (resolved.attempted?.at(-1)?.reason ?? 'the extracted binary did not start'),
    };
  } catch (error) {
    return { status: 'failed', tool, error: cleanError(error.message), hint: manualInstructions(tool, platform) };
  }
}

/**
 * Make both CLIs usable: reuse an existing installation, otherwise download.
 * Order matters — the brief and ordinary courtesy both prefer the copy the
 * user already has.
 */
export async function ensureClis({ binDir, tools = ['keepassxc', 'veracrypt'], overrides = {}, allowDownload = true, force = false, platform = process.platform, arch = process.arch, log = () => {}, token } = {}) {
  const report = { platform: detectPlatform(platform, arch), bin_dir: binDir ?? null, tools: {} };
  for (const tool of tools) {
    const existing = await resolveCli(tool, { binDir, override: overrides[tool], platform });
    if (existing.available && !force) {
      report.tools[tool] = { ...existing, status: existing.source === 'downloaded' ? 'downloaded_present' : 'system_install' };
      continue;
    }
    if (!allowDownload) {
      report.tools[tool] = { ...existing, status: existing.available ? 'system_install' : 'download_disabled' };
      continue;
    }
    log(`${TOOLS[tool].label}: nothing usable found, downloading the official build`);
    const installed = await installCli(tool, { binDir, platform, arch, log, token });
    report.tools[tool] = { ...installed, previous: existing.attempted };
  }
  return report;
}

/** One-line status for both CLIs, used by the MCP vault_status tool. */
export async function cliStatus({ binDir, overrides = {}, platform = process.platform } = {}) {
  const entries = await Promise.all(Object.keys(TOOLS).map(async tool => [tool, await resolveCli(tool, { binDir, override: overrides[tool], platform })]));
  return Object.fromEntries(entries.map(([tool, value]) => [tool, {
    label: TOOLS[tool].label,
    available: value.available,
    path: value.path,
    source: value.source,
    version: value.version,
    manual_install: value.available ? undefined : manualInstructions(tool, platform),
  }]));
}

/** Default per-user locations used when the user left a setting empty. */
export function defaultPaths({ globalStorage, config = {}, platform = process.platform, env = process.env } = {}) {
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const mountPoint = config.mountPoint
    || (platform === 'win32' ? 'V:' : path.join(home, 'VAMP-Vault'));
  return {
    binDir: path.join(globalStorage, 'bin'),
    kdbx: config.defaultKdbxPath || path.join(globalStorage, 'vault.kdbx'),
    volume: config.defaultVolumePath || path.join(globalStorage, 'vault.hc'),
    mountPoint,
  };
}
