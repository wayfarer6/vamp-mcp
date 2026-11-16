// VAMP Vault — data model for the sidebar views.
//
// The tree that the activity bar shows is built here, without importing
// `vscode`, so `node test/smoke.mjs` can exercise the same code the extension
// runs. A node is plain data; the extension host turns each one into a
// `vscode.TreeItem` (icon names below are ThemeIcon ids).

const RECYCLE = /^recycle bin$/i;

function trimSlashes(value) {
  return String(value ?? '').replace(/^\/+|\/+$/g, '');
}

function baseName(value) {
  const trimmed = trimSlashes(value);
  const index = trimmed.lastIndexOf('/');
  return index < 0 ? trimmed : trimmed.slice(index + 1);
}

function compare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function actionNode({ id, label, description = '', tooltip = '', command, icon = 'circle-outline' }) {
  return { type: 'action', id, label, description, tooltip: tooltip || description, command, icon };
}

function infoNode({ id, label, description = '', tooltip = '', icon = 'info', command = null }) {
  return { type: 'info', id, label, description, tooltip: tooltip || description, icon, command };
}

function groupNode(path) {
  const label = baseName(path);
  return {
    type: 'group',
    label,
    path,
    description: '',
    tooltip: path,
    icon: RECYCLE.test(label) ? 'trash' : 'folder',
    children: [],
  };
}

/**
 * Groups before entries, each sorted by name. A group's children are the same
 * group's and entry paths one level down.
 */
function sortLevel(nodes) {
  nodes.sort((a, b) => {
    const weight = node => (node.type === 'group' ? 0 : node.type === 'entry' ? 1 : 2);
    const delta = weight(a) - weight(b);
    return delta !== 0 ? delta : compare(a.label, b.label);
  });
  for (const node of nodes) if (node.children?.length) sortLevel(node.children);
  return nodes;
}

/**
 * Root nodes for the Credentials view.
 *
 * @param {object} options
 * @param {boolean} options.cliAvailable  keepassxc-cli resolved?
 * @param {boolean} options.databaseExists the configured .kdbx is on disk?
 * @param {boolean} options.locked          no master password in secret storage?
 * @param {string}  options.kdbxPath        database path (for guidance text)
 * @param {{entries: Array<{path: string, group: string, title: string}>, groups: string[]}|null} options.listing
 * @param {Record<string, {username?: string}>} options.meta  username per entry path
 * @param {string|null} options.error       last read error, shown as a node
 */
export function buildCredentialTree({
  cliAvailable = false,
  databaseExists = false,
  locked = true,
  kdbxPath = '',
  listing = null,
  meta = {},
  error = null,
} = {}) {
  const dbName = baseName(kdbxPath) || 'vault.kdbx';

  if (!cliAvailable) {
    return [
      actionNode({
        id: 'setupCli',
        label: 'Set up KeePassXC CLI',
        description: `${dbName} cannot be read without it`,
        tooltip: 'Resolve or download keepassxc-cli, then come back to this view.',
        command: 'vampVault.setupCli',
        icon: 'tools',
      }),
      infoNode({
        id: 'setupHint',
        label: 'Credentials stay offline until then',
        description: 'VAMP Vault stores them in a local KeePassXC database',
        icon: 'shield',
      }),
    ];
  }

  if (!databaseExists) {
    return [
      actionNode({
        id: 'createVault',
        label: 'Create vault',
        description: `${dbName} does not exist yet`,
        tooltip: kdbxPath,
        command: 'vampVault.createVault',
        icon: 'add',
      }),
      infoNode({
        id: 'createHint',
        label: 'The master password goes to VS Code secret storage',
        description: 'not to a settings file or an environment variable',
        icon: 'key',
      }),
    ];
  }

  if (locked) {
    return [
      actionNode({
        id: 'unlock',
        label: 'Unlock vault',
        description: dbName,
        tooltip: `${kdbxPath}\nUnlocking asks for the master password and keeps it in VS Code secret storage until you lock again.`,
        command: 'vampVault.unlock',
        icon: 'unlock',
      }),
      infoNode({
        id: 'locked',
        label: 'Locked',
        description: 'entries are not read while the vault is locked',
        icon: 'lock',
      }),
    ];
  }

  if (error) {
    return [
      infoNode({
        id: 'readError',
        label: 'Could not read the vault',
        description: error,
        tooltip: `${dbName}\n${error}`,
        icon: 'warning',
      }),
      actionNode({
        id: 'unlockAgain',
        label: 'Unlock again',
        description: 'ask for the master password once more',
        command: 'vampVault.unlock',
        icon: 'unlock',
      }),
    ];
  }

  const { entries = [], groups = [] } = listing ?? {};
  const groupPaths = new Set();
  for (const group of groups) {
    const path = trimSlashes(group);
    if (path) groupPaths.add(path);
  }
  for (const entry of entries) {
    if (entry.group && entry.group !== '/') {
      const path = trimSlashes(entry.group);
      if (path) groupPaths.add(path);
    }
  }

  const ordered = [...groupPaths].sort((a, b) => {
    const depth = a.split('/').length - b.split('/').length;
    return depth !== 0 ? depth : compare(a, b);
  });

  const roots = [];
  const index = new Map();
  for (const path of ordered) {
    const node = groupNode(path);
    index.set(path, node);
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const parent = parentPath ? index.get(parentPath) : null;
    (parent ? parent.children : roots).push(node);
  }

  for (const entry of entries) {
    const path = trimSlashes(entry.path);
    if (!path) continue;
    const groupPath = entry.group && entry.group !== '/' ? trimSlashes(entry.group) : '';
    const username = meta[path]?.username ?? '';
    const node = {
      type: 'entry',
      label: entry.title || baseName(path),
      path,
      // "username or path": the username once it has been read, the group
      // before that, so every row carries something that tells them apart.
      description: username || groupPath || 'top level',
      tooltip: `${path}${username ? `\nuser: ${username}` : ''}`,
      icon: 'key',
      children: [],
    };
    const parent = groupPath ? index.get(groupPath) : null;
    (parent ? parent.children : roots).push(node);
  }

  if (!roots.length) {
    return [
      infoNode({
        id: 'empty',
        label: 'No entries yet',
        description: 'the vault is unlocked and empty',
        tooltip: `${kdbxPath}\nAsk the agent to add a credential with vault_set_credential, or add entries in KeePassXC.`,
        icon: 'info',
      }),
    ];
  }

  return sortLevel(roots);
}

/**
 * Root nodes for the Vault Status view. Read-only: nothing here changes state.
 */
export function buildStatusTree({
  databaseExists = false,
  kdbxPath = '',
  volumeExists = false,
  volumePath = '',
  mounted = [],
  unlocked = false,
  keepassxcAvailable = false,
  keepassxcVersion = null,
  keepassxcPath = null,
  veracryptAvailable = false,
  veracryptVersion = null,
  veracryptPath = null,
  approvalMode = 'per-session',
  cacheMinutes = 5,
} = {}) {
  const mountPoints = mounted.map(item => item.mount_point ?? item.mountPoint).filter(Boolean);
  return [
    infoNode({
      id: 'lock',
      label: unlocked ? 'Unlocked' : 'Locked',
      description: unlocked ? 'master password in secret storage' : 'run Unlock to read credentials',
      tooltip: unlocked
        ? 'VAMP Vault: Lock forgets the master password immediately.'
        : 'No master password is stored, so nothing can read the database.',
      icon: unlocked ? 'unlock' : 'lock',
      command: unlocked ? null : 'vampVault.unlock',
    }),
    infoNode({
      id: 'database',
      label: 'Database',
      description: databaseExists ? baseName(kdbxPath) : 'missing — Create Vault',
      tooltip: kdbxPath || 'no database path',
      icon: databaseExists ? 'database' : 'warning',
      command: databaseExists ? 'vampVault.revealKdbx' : 'vampVault.createVault',
    }),
    infoNode({
      id: 'volume',
      label: 'Volume',
      description: mountPoints.length
        ? `mounted at ${mountPoints.join(', ')}`
        : volumeExists ? 'not mounted' : 'missing — Create Vault',
      tooltip: volumePath || 'no volume path',
      icon: mountPoints.length ? 'vm-active' : 'vm-outline',
    }),
    infoNode({
      id: 'keepassxc',
      label: 'KeePassXC CLI',
      description: keepassxcAvailable ? keepassxcVersion ?? 'available' : 'not available — Set Up CLI',
      tooltip: keepassxcPath ?? 'keepassxc-cli has not been resolved yet',
      icon: keepassxcAvailable ? 'pass-filled' : 'error',
      command: keepassxcAvailable ? null : 'vampVault.setupCli',
    }),
    infoNode({
      id: 'veracrypt',
      label: 'VeraCrypt CLI',
      description: veracryptAvailable ? veracryptVersion ?? 'available' : 'not available — Set Up CLI',
      tooltip: veracryptPath ?? 'veracrypt has not been resolved yet',
      icon: veracryptAvailable ? 'pass-filled' : 'error',
      command: veracryptAvailable ? null : 'vampVault.setupCli',
    }),
    infoNode({
      id: 'approval',
      label: 'Approval',
      description: `${approvalMode}, cache ${cacheMinutes} min`,
      tooltip: 'When the agent must ask before a secret leaves the vault.',
      icon: 'shield',
    }),
    infoNode({
      id: 'guide',
      label: 'Open guide',
      description: 'what leaves the machine, and what does not',
      icon: 'book',
      command: 'vampVault.openGuide',
    }),
  ];
}

/** Depth-first list of every node, descendants included. */
export function flattenTree(nodes) {
  const out = [];
  const walk = list => {
    for (const node of list ?? []) {
      out.push(node);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** First node whose path (or id) matches, anywhere in the tree. */
export function findNode(nodes, match) {
  const test = typeof match === 'function' ? match : node => node.path === match || node.id === match;
  return flattenTree(nodes).find(test) ?? null;
}
