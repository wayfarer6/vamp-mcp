// libvirt/virsh parsing for the remote hypervisor server.
// Only text produced by virsh is interpreted here; nothing is evaluated.
const STATE_NAMES = {
  'shut off': 'poweroff',
  running: 'running',
  paused: 'paused',
  crashed: 'aborted',
  'pmsuspended': 'suspended',
  'in shutdown': 'shutting_down',
};

export function domainState(raw) {
  const value = String(raw || '').trim();
  return STATE_NAMES[value] || value || 'unknown';
}

export function parseDomainInfo(text) {
  const fields = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) fields[match[1].trim()] = match[2].trim();
  }
  const memoryText = fields['Max memory'] || fields['Used memory'] || '';
  const memory = Number(memoryText.replace(/[^\d.]/g, ''));
  const bytesPerUnit = /GiB/i.test(memoryText) ? 1024 ** 3 : /MiB/i.test(memoryText) ? 1024 ** 2 : 1024;
  return {
    name: fields['Name'] || '',
    id: fields['UUID'] || '',
    state: domainState(fields['State']),
    cpus: Number(fields['CPU(s)']) || undefined,
    memory_mb: Number.isFinite(memory) && memory > 0 ? Math.round((memory * bytesPerUnit) / 1024 ** 2) : undefined,
    autostart: /enable/i.test(fields['Autostart'] || ''),
    persistent: /yes/i.test(fields['Persistent'] || ''),
    managed_save: /yes/i.test(fields['Managed save'] || ''),
  };
}

export function parseDomainIds(text) {
  const ids = [];
  for (const token of String(text).split(/\s+/)) {
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(token)) ids.push(token);
  }
  return [...new Set(ids)];
}

const decode = value => String(value || '').replace(/&(?:amp|lt|gt|quot|apos);/g, char => ({
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
}[char]));

function tag(xml, name) {
  const match = String(xml).match(new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`));
  return match ? decode(match[1]) : '';
}

function attributes(text) {
  const result = {};
  for (const match of String(text || '').matchAll(/([\w:-]+)\s*=\s*(['"])(.*?)\2/g)) result[match[1]] = decode(match[3]);
  return result;
}

const MEMORY_UNITS = { KiB: 1 / 1024, MiB: 1, GiB: 1024, bytes: 1 / 1024 ** 2, k: 1 / 1024, M: 1, G: 1024 };

export function parseDomainXml(xml) {
  const source = String(xml || '');
  const memoryTag = attributes(source.match(/<memory\b([^>]*)>/)?.[1] || '');
  const unit = memoryTag.unit || 'KiB';
  const memoryMb = Math.round(Number(tag(source, 'memory')) * (MEMORY_UNITS[unit] || 1 / 1024));
  const disks = [...source.matchAll(/<disk\b([^>]*)>([\s\S]*?)<\/disk>/g)].map(match => {
    const outer = attributes(match[1]);
    const inner = match[2];
    return {
      device: outer.device || 'disk',
      bus: attributes(inner.match(/<target\b([^>]*)\/?>/)?.[1] || '').bus,
      target: attributes(inner.match(/<target\b([^>]*)\/?>/)?.[1] || '').dev,
      source: attributes(inner.match(/<source\b([^>]*)\/?>/)?.[1] || '').file
        || attributes(inner.match(/<source\b([^>]*)\/?>/)?.[1] || '').dev,
    };
  });
  const graphics = [...source.matchAll(/<graphics\b([^>]*)(?:\/>|>)/g)].map(match => {
    const values = attributes(match[1]);
    return { type: values.type, port: Number(values.port) || undefined, listen: values.listen || undefined, websocket: Number(values.websocket) || undefined };
  });
  const interfaces = [...source.matchAll(/<interface\b([^>]*)>([\s\S]*?)<\/interface>/g)].map(match => ({
    type: attributes(match[1]).type,
    mac: attributes(match[2].match(/<mac\b([^>]*)\/?>/)?.[1] || '').address,
  }));
  return {
    name: tag(source, 'name'),
    id: tag(source, 'uuid'),
    memory_mb: Number.isFinite(memoryMb) && memoryMb > 0 ? memoryMb : undefined,
    vcpus: Number(tag(source, 'vcpu')) || undefined,
    guestType: tag(source, 'type') || undefined,
    machine: attributes(source.match(/<os\b([^>]*)>/)?.[1] || '').type || undefined,
    firmware: /<loader\b/.test(source) ? 'uefi' : 'bios',
    disks: disks.filter(disk => disk.source || disk.target),
    graphics,
    interfaces,
  };
}

/** QEMU monitor command for a pointer click on an absolute pointing device. */
export function clickEvents({ x = 0.5, y = 0.5, button = 'left', double = false }) {
  const axis = value => Math.max(0, Math.min(32767, Math.round(value * 32767)));
  const events = [
    { type: 'abs', data: { axis: 'x', value: axis(x) } },
    { type: 'abs', data: { axis: 'y', value: axis(y) } },
  ];
  const presses = double ? 2 : 1;
  for (let index = 0; index < presses; index += 1) {
    events.push({ type: 'btn', data: { down: true, button } });
    events.push({ type: 'btn', data: { down: false, button } });
  }
  return events;
}

export const CLICK_BUTTONS = ['left', 'middle', 'right'];
