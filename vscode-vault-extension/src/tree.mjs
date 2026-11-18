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

function groupNode(path, scope = null) {
  const label = baseName(path);
  const node = {
    type: 'group',
    label,
    path,
    description: '',
    tooltip: scope === 'remote' ? `${path}\nremote vault` : path,
    icon: RECYCLE.test(label) ? 'trash' : 'folder',
    children: [],
  };
  if (scope) node.scope = scope;
  return node;
}

/** A titled section that holds one vault's nodes: local and remote never mix. */
function sectionNode({ id, label, description = '', tooltip = '', icon = 'folder-library', children = [] }) {
  return { type: 'section', id, label, description, tooltip: tooltip || description, icon, children };
}

/**
 * Group and entry nodes for one database listing. `scope` marks where the
 * entries live, so a command knows which vault to read: nothing else may
 * decide that, because two vaults can hold an entry with the same path.
 */
function listingNodes({ entries = [], groups = [], meta = {}, scope = null } = {}) {
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
    const node = groupNode(path, scope);
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
      tooltip: `${path}${username ? `\nuser: ${username}` : ''}${scope === 'remote' ? '\nremote vault' : ''}`,
      icon: 'key',
      children: [],
    };
    if (scope) node.scope = scope;
    const parent = groupPath ? index.get(groupPath) : null;
    (parent ? parent.children : roots).push(node);
  }

  const countEntries = node => {
    if (node.type === 'entry') return 1;
    const count = node.children.reduce((total, child) => total + countEntries(child), 0);
    node.description = `${count} ${count === 1 ? 'entry' : 'entries'}`;
    return count;
  };
  for (const node of roots) countEntries(node);
  return roots;
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
  const roots = listingNodes({ entries, groups, meta });

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

/**
 * Nodes for one remote host's vault in the Status view. Everything here is
 * about that host alone: a second host has its own section and its own rows.
 */
export function buildRemoteStatusNodes({
  enabled = false,
  configured = false,
  host = '',
  target = '',
  kdbxPath = '',
  volumePath = '',
  mountPoint = '',
  approvalMode = 'per-session',
  checked = false,
  reachable = false,
  error = '',
  databaseExists = false,
  volumeExists = false,
  mounted = [],
  unlocked = false,
  keepassxcAvailable = false,
  keepassxcVersion = null,
  veracryptAvailable = false,
  veracryptVersion = null,
  serverVersion = null,
  nodeVersion = null,
  checkedAt = null,
} = {}) {
  const name = target || host || 'remote host';
  if (!enabled) {
    return [
      infoNode({
        id: 'remoteOff',
        label: '🌐 Remote vaults',
        description: 'off',
        tooltip: 'Turn on “VAMP Vault: Remote Enabled” to keep a separate vault on another machine over SSH.',
        icon: 'remote',
        command: 'vampVault.setupRemote',
      }),
    ];
  }
  if (!configured) {
    return [
      sectionNode({
        id: 'remote',
        label: '🌐 Remote Vault',
        description: 'no host yet',
        tooltip: 'Set the host of the remote vault. Nothing is shared with the local vault.',
        icon: 'remote',
        children: [
          actionNode({
            id: 'remoteConfigure',
            label: 'Set remote host',
            description: 'SSH host and account',
            command: 'vampVault.setupRemote',
            icon: 'gear',
          }),
        ],
      }),
    ];
  }
  const mountPoints = mounted.map(item => item.mount_point ?? item.mountPoint).filter(Boolean);
  const children = [
    infoNode({
      id: 'remoteLock',
      label: unlocked ? 'Unlocked' : 'Locked',
      description: unlocked
        ? `master password held for ${name} only`
        : 'run Unlock Remote Vault to read it',
      tooltip: unlocked
        ? 'Locking this remote vault forgets only its master password; the local vault keeps its own.'
        : 'No master password is stored for this host.',
      icon: unlocked ? 'unlock' : 'lock',
      command: unlocked ? null : 'vampVault.unlockRemote',
    }),
    infoNode({
      id: 'remoteDatabase',
      label: 'Database',
      description: databaseExists ? baseName(kdbxPath) : 'missing — Create Remote Vault',
      tooltip: `${kdbxPath}\non ${name} · this host's own database, never synced with any other`,
      icon: databaseExists ? 'database' : 'warning',
      command: databaseExists ? null : 'vampVault.createRemoteVault',
    }),
    infoNode({
      id: 'remoteVolume',
      label: 'Volume',
      description: mountPoints.length
        ? `mounted at ${mountPoints.join(', ')}`
        : volumeExists ? 'not mounted' : 'not created',
      tooltip: volumePath ? `${volumePath}\non ${name}` : 'no volume path',
      icon: mountPoints.length ? 'vm-active' : 'vm-outline',
    }),
    infoNode({
      id: 'remoteKeepassxc',
      label: 'KeePassXC CLI',
      description: keepassxcAvailable
        ? `on ${name} · ${keepassxcVersion ?? 'available'}`
        : `missing on ${name} — Set Up Remote Vault`,
      tooltip: `keepassxc-cli on ${name}`,
      icon: keepassxcAvailable ? 'pass-filled' : 'error',
      command: keepassxcAvailable ? null : 'vampVault.setupRemote',
    }),
    infoNode({
      id: 'remoteVeracrypt',
      label: 'VeraCrypt CLI',
      description: veracryptAvailable ? `on ${name} · ${veracryptVersion ?? 'available'}` : 'not installed',
      tooltip: `veracrypt on ${name} · optional`,
      icon: veracryptAvailable ? 'pass-filled' : 'circle-slash',
    }),
    infoNode({
      id: 'remoteConnection',
      label: 'SSH connection',
      description: !checked
        ? 'not checked yet'
        : reachable ? `reachable${serverVersion ? ` · vault server ${serverVersion}` : ''}` : 'not reachable',
      tooltip: error || `${name}${nodeVersion ? `\nNode.js ${nodeVersion}` : ''}${checkedAt ? `\nchecked ${checkedAt}` : ''}`,
      icon: !checked ? 'question' : reachable ? 'pass-filled' : 'warning',
      command: 'vampVault.verifyRemote',
    }),
    infoNode({
      id: 'remoteApproval',
      label: 'Approval',
      description: `each read approved here · ${approvalMode}`,
      tooltip: 'Approvals for this vault happen on this computer, before anything is sent over SSH.',
      icon: 'shield',
    }),
    actionNode({
      id: 'remoteSetup',
      label: 'Set Up Remote Vault',
      description: 'install the vault server on the host',
      command: 'vampVault.setupRemote',
      icon: 'cloud-upload',
    }),
    actionNode({
      id: 'remoteVerify',
      label: 'Verify Remote Vault',
      description: 'SSH, Node.js, KeePassXC and the database',
      command: 'vampVault.verifyRemote',
      icon: 'check',
    }),
    actionNode({
      id: 'remoteLockAction',
      label: unlocked ? 'Lock Remote Vault' : 'Unlock Remote Vault',
      description: unlocked ? `forget the password of ${name} only` : 'ask for this host\'s master password',
      command: unlocked ? 'vampVault.lockRemote' : 'vampVault.unlockRemote',
      icon: unlocked ? 'lock' : 'unlock',
    }),
  ];
  return [
    sectionNode({
      id: 'remote',
      label: `🌐 Remote Vault · ${name}`,
      description: `[Remote: ${name}]`,
      tooltip: `${kdbxPath}\nA vault that exists only on ${name}. It is not synced with the local vault or with any other host.`,
      icon: 'remote',
      children,
    }),
  ];
}

/**
 * Nodes for one remote host's credentials. The rows carry scope: 'remote' so a
 * copy command reads that host's database and never the local one.
 */
export function buildRemoteCredentialNodes({
  enabled = false,
  configured = false,
  host = '',
  target = '',
  kdbxPath = '',
  locked = true,
  reachable = true,
  error = null,
  keepassxcAvailable = true,
  databaseExists = false,
  listing = null,
  meta = {},
} = {}) {
  const name = target || host || 'remote host';
  if (!enabled) {
    return [
      infoNode({
        id: 'remoteOff',
        label: '🌐 Remote vaults',
        description: 'off',
        tooltip: 'Turn on “VAMP Vault: Remote Enabled” to keep a separate vault on another machine over SSH.',
        icon: 'remote',
        command: 'vampVault.setupRemote',
      }),
    ];
  }
  if (!configured) {
    return [
      actionNode({
        id: 'remoteConfigure',
        label: 'Set remote host',
        description: 'each host keeps its own vault',
        command: 'vampVault.setupRemote',
        icon: 'gear',
      }),
    ];
  }
  const rows = [];
  if (!reachable) {
    rows.push(infoNode({
      id: 'remoteUnreachable',
      label: 'Remote host not reachable',
      description: error || name,
      tooltip: `${error || ''}\nRun Verify Remote Vault to check SSH, Node.js and KeePassXC on ${name}.`,
      icon: 'warning',
      command: 'vampVault.verifyRemote',
    }));
  } else if (!keepassxcAvailable) {
    rows.push(actionNode({
      id: 'remoteSetupCli',
      label: 'Set up KeePassXC on the host',
      description: name,
      command: 'vampVault.setupRemote',
      icon: 'tools',
    }));
  } else if (!databaseExists) {
    rows.push(actionNode({
      id: 'remoteCreateVault',
      label: 'Create remote vault',
      description: `${baseName(kdbxPath) || 'vault.kdbx'} on ${name}`,
      tooltip: `${kdbxPath}\nA new database on ${name} only. Nothing is copied from the local vault.`,
      command: 'vampVault.createRemoteVault',
      icon: 'add',
    }));
  } else if (locked) {
    rows.push(actionNode({
      id: 'remoteUnlock',
      label: 'Unlock remote vault',
      description: name,
      tooltip: `${kdbxPath}\nThe master password for ${name} is kept separately from the local one.`,
      command: 'vampVault.unlockRemote',
      icon: 'unlock',
    }));
  } else if (error) {
    rows.push(infoNode({
      id: 'remoteReadError',
      label: 'Could not read the remote vault',
      description: error,
      tooltip: `${kdbxPath}\n${error}`,
      icon: 'warning',
    }));
    rows.push(actionNode({
      id: 'remoteUnlockAgain',
      label: 'Unlock again',
      description: 'ask for this host\'s master password once more',
      command: 'vampVault.unlockRemote',
      icon: 'unlock',
    }));
  } else if (!listing) {
    rows.push(infoNode({
      id: 'remoteReading',
      label: 'Reading the entries…',
      description: `from ${name}`,
      tooltip: `The vault on ${name} is unlocked here; its entries are being read over SSH.`,
      icon: 'loading~spin',
      command: 'vampVault.refreshTree',
    }));
  } else {
    const entries = listing?.entries ?? [];
    const roots = listingNodes({ entries, groups: listing?.groups ?? [], meta, scope: 'remote' });
    if (!roots.length) {
      rows.push(infoNode({
        id: 'remoteEmpty',
        label: 'No entries yet',
        description: `the vault on ${name} is unlocked and empty`,
        tooltip: 'Ask the agent to add a credential to the remote vault, or add entries in KeePassXC on that host.',
        icon: 'info',
      }));
    } else {
      rows.push(...roots);
    }
  }
  return [
    sectionNode({
      id: `remote:${name}`,
      label: `🌐 Remote Vault · ${name}`,
      description: `[Remote: ${name}]`,
      tooltip: `${kdbxPath}\nEntries that exist only on ${name}.`,
      icon: 'remote',
      children: rows,
    }),
  ];
}

/**
 * The credentials view: one flat list when only the local vault is in play,
 * and one section per vault as soon as a remote vault is turned on. A vault is
 * never merged into another: every row belongs to exactly one section.
 */
export function buildCredentialSections({ local = {}, remote = null } = {}) {
  const localNodes = buildCredentialTree(local);
  if (!remote?.enabled) return [...localNodes, ...buildRemoteCredentialNodes(remote ?? { enabled: false })];
  return [
    sectionNode({
      id: 'local',
      label: '📦 Local Vault',
      description: local.databaseExists ? baseName(local.kdbxPath) : 'this computer',
      tooltip: `${local.kdbxPath || 'local database'}\nStays on this computer. The remote vaults are separate databases.`,
      icon: 'vm',
      children: localNodes,
    }),
    ...buildRemoteCredentialNodes(remote),
  ];
}

/** The status view: local rows alone, or grouped by vault when remote is on. */
export function buildStatusSections({ local = {}, remote = null } = {}) {
  const localNodes = buildStatusTree(local);
  if (!remote?.enabled) return [...localNodes, ...buildRemoteStatusNodes(remote ?? { enabled: false })];
  return [
    sectionNode({
      id: 'local',
      label: '📦 Local Vault',
      description: 'this computer',
      tooltip: 'The vault on this computer. Its master password and cache are independent of every remote host.',
      icon: 'vm',
      children: localNodes,
    }),
    ...buildRemoteStatusNodes(remote),
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
