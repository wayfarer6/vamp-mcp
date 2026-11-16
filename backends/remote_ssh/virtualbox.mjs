// VBoxManage parsing for Windows, Linux and macOS remote hosts.
const STATE_NAMES = {
  running: 'running',
  poweroff: 'poweroff',
  saved: 'saved',
  paused: 'paused',
  aborted: 'aborted',
  gurumeditation: 'gurumeditation',
  teleported: 'teleported',
  livepositionsaving: 'paused',
};

export function vboxState(raw) {
  const value = String(raw || '').trim();
  return STATE_NAMES[value.toLowerCase()] || value || 'unknown';
}

/** Parse `VBoxManage list vms` output: `"Name" {uuid}`. */
export function parseVmList(text) {
  return String(text).split(/\r?\n/).flatMap(line => {
    const match = line.match(/^"(.+)"\s+\{([a-f0-9-]{36})\}$/i);
    return match ? [{ name: match[1], id: match[2] }] : [];
  });
}

/** Parse `VBoxManage showvminfo <id> --machinereadable` key/value output. */
export function parseMachineReadable(text) {
  const fields = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (!match) continue;
    fields[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return fields;
}

export function vboxVm(fields, fallback = {}) {
  const memory = Number(fields.memory);
  const cpus = Number(fields.cpus);
  return {
    name: fields.name || fallback.name || '',
    id: fields.UUID || fallback.id || '',
    state: vboxState(fields.VMState),
    memory_mb: Number.isFinite(memory) && memory > 0 ? memory : undefined,
    cpus: Number.isFinite(cpus) && cpus > 0 ? cpus : undefined,
    guestOS: fields.ostype || undefined,
    vrdp: fields.VRDEActive === 'on',
    usb: fields.USBEnable === 'on',
    sharedFolders: Object.keys(fields).filter(key => /^SharedFolderNameMachineMapping\d+$/.test(key)).length,
  };
}

/** Full detail for a VirtualBox guest, including its network forwarding rules. */
export function vboxStatus(fields, fallback = {}) {
  const vm = vboxVm(fields, fallback);
  const forwarding = [];
  for (const key of Object.keys(fields)) {
    const match = key.match(/^Forwarding\((\d+)\)$/);
    if (match) {
      const index = match[1];
      const [name, protocol, hostIp, hostPort, guestIp, guestPort] = String(fields[key]).split(',');
      forwarding.push({ name, protocol, host_ip: hostIp, host_port: Number(hostPort) || hostPort, guest_ip: guestIp, guest_port: Number(guestPort) || guestPort, rule: Number(index) });
    }
  }
  return {
    ...vm,
    cpu_execution_cap: Number(fields.CPUExecutionCap) || undefined,
    graphics: Number(fields.GraphicsPort) ? [{ type: 'vrdp', port: Number(fields.GraphicsPort) }] : [],
    macs: Object.keys(fields).filter(key => /^macaddress\d+$/.test(key)).map(key => fields[key]),
    disks: Object.keys(fields)
      .filter(key => /^SATA-ImageUUID-\d+$|^IDE-ImageUUID-\d+$|^SATA-\d+-\d+$/.test(key))
      .map(key => fields[key])
      .filter(Boolean),
    port_forwarding: forwarding,
    installation_complete: fields.installDateUtc || undefined,
  };
}
