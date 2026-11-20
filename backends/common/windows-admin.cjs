'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');

function powershell() {
  return path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function isAdministrator({ platform = process.platform, execute = execFile } = {}) {
  if (platform !== 'win32') return Promise.resolve(true);
  const query = '$id=[Security.Principal.WindowsIdentity]::GetCurrent();' +
    'if (([Security.Principal.WindowsPrincipal]::new($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 }; exit 37';
  return new Promise((resolve, reject) => execute(powershell(),
    ['-NoProfile', '-NonInteractive', '-Command', query], { windowsHide: true, timeout: 10000 },
    error => {
      if (!error) resolve(true);
      else if (error.code === 37) resolve(false);
      else reject(error);
    }));
}

const administratorRequired = 'VAMP MCP requires Windows administrator privileges. Run the MCP server or its host as administrator.';

async function requireAdministrator(options) {
  if (!await isAdministrator(options)) throw new Error(administratorRequired);
}

module.exports = { administratorRequired, isAdministrator, powershell, requireAdministrator };
