// VAMP Vault — client side of the small local bridge to the VS Code extension.
//
// The MCP server runs as a separate process and cannot reach VS Code's secret
// storage or dialogs, so the extension host listens on a per-user socket. This
// module asks it for three things and nothing else:
//   unlock        → the KeePassXC master password held in VS Code secret storage
//   approve       → a modal yes/no before a secret leaves the vault
//   new-password  → a password the user types for a vault being created
// If the socket is not there (the server was started by hand, or the extension
// has not finished activating) every call fails fast and the caller falls back
// to the headless policy. Requests time out rather than hang.
import net from 'node:net';

export class BridgeUnavailable extends Error {
  constructor(message) {
    super(message);
    this.code = 'bridge_unavailable';
  }
}

export class BridgeClient {
  constructor(socket, { token, defaultTimeout = 120000 } = {}) {
    this.socket = socket;
    this.token = token;
    this.defaultTimeout = defaultTimeout;
    this.pending = new Map();
    this.buffer = '';
    this.nextId = 1;
    this.closed = false;
    socket.setEncoding('utf8');
    socket.on('data', chunk => this.#onData(chunk));
    socket.on('close', () => this.#failAll('bridge closed'));
    socket.on('error', error => this.#failAll(error.message));
  }

  static connect({ socketPath, token, timeoutMs = 3000 } = {}) {
    if (!socketPath) return Promise.reject(new BridgeUnavailable('no bridge socket configured'));
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new BridgeUnavailable('bridge connection timed out'));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(new BridgeClient(socket, { token }));
      });
      socket.once('error', error => {
        clearTimeout(timer);
        reject(new BridgeUnavailable(error.message));
      });
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result ?? {});
      else entry.reject(new Error(message.error ?? 'bridge request failed'));
    }
  }

  #failAll(reason) {
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeUnavailable(reason));
    }
    this.pending.clear();
  }

  request(op, params = {}, { timeout = this.defaultTimeout } = {}) {
    if (this.closed) return Promise.reject(new BridgeUnavailable('bridge is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeUnavailable(`bridge request "${op}" timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ id, token: this.token, op, params })}\n`);
    });
  }

  async unlock(kdbx) {
    const result = await this.request('unlock', { kdbx }, { timeout: 180000 });
    return { password: result.password ?? null, cancelled: Boolean(result.cancelled), source: result.source ?? 'secret_storage' };
  }

  async approve({ action, entry, detail }) {
    const result = await this.request('approve', { action, entry, detail });
    return { approved: Boolean(result.approved), remember: Boolean(result.remember) };
  }

  async newPassword({ purpose, label, kdbx }) {
    const result = await this.request('new-password', { purpose, label, ...(kdbx ? { kdbx } : {}) }, { timeout: 180000 });
    return { password: result.password ?? null, cancelled: Boolean(result.cancelled) };
  }

  async notify({ message, level = 'info' }) {
    try {
      await this.request('notify', { message, level }, { timeout: 5000 });
      return true;
    } catch { return false; }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.end(); } catch {}
  }
}
