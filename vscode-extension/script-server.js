'use strict';
/**
 * Host helper for the VAMP guest setup HTTP server.
 *
 * Guest setup scripts are staged from guest_setup/ and served by Python's
 * standard library on the fixed port 8421. A guest reaches the host as
 * 10.0.2.2 under VirtualBox NAT and QEMU user networking, and as
 * 192.168.122.1 on libvirt's default network.
 *
 * VAMP does not rewrite ISOs and does not use xorriso.
 */
const {execFile} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {SCRIPT_SERVER_PORT, scriptBaseUrl} = require('./guest-bootstrap');

function createScriptServer({runtime, python, log = () => {}}) {
  const script = path.join(runtime, 'scripts/script_server.py');
  const pythonCommand = () => (typeof python === 'function' ? python() : python);
  const call = (command, extra = []) => new Promise((resolve, reject) => {
    execFile(pythonCommand(), [script, command, '--port', String(SCRIPT_SERVER_PORT), '--json', ...extra],
      {timeout: 120000, maxBuffer: 4 * 1024 * 1024}, (error, stdout, stderr) => {
        const text = String(stdout || '').trim();
        if (text) {
          try {
            const parsed = JSON.parse(text);
            if (!error || parsed.status === 'failed' || parsed.status === 'port_in_use') return resolve(parsed);
          } catch {}
        }
        reject(new Error(String(stderr || '').trim() || error?.message || 'The guest setup script server failed.'));
      });
  });
  return {
    port: SCRIPT_SERVER_PORT,
    script,
    available: () => fs.existsSync(script),
    status: () => call('status'),
    stop: () => call('stop'),
    start: (options = {}) => {
      const extra = [];
      if (options.ttlSeconds !== undefined) extra.push('--ttl', String(options.ttlSeconds));
      if (options.bind) extra.push('--bind', options.bind);
      return call('start', extra);
    },
    /** Reuse a running server or start one; returns its JSON status. */
    ensure: async (options = {}) => {
      const current = await call('status');
      if (current.status === 'running') return current;
      if (current.status === 'port_in_use') return current;
      const started = await call('start', ['--ttl', String(options.ttlSeconds ?? 1800)]);
      if (started.status === 'running') {
        log(`Serving guest setup at ${started.guest_urls?.virtualbox_nat || scriptBaseUrl()} (port ${SCRIPT_SERVER_PORT})`);
      }
      return started;
    },
  };
}

module.exports = {SCRIPT_SERVER_PORT, createScriptServer};
