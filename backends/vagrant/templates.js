'use strict';
// Deterministic Vagrantfile generation for VAMP-managed desktops.
// Pure string work: no host tools run here, so the same input always yields
// the same file and a review can read what will be executed.

const GUEST_BOXES={debian:'generic/debian12',windows11:'gusztavvargadr/windows-11'};
const GUESTS={debian:{vagrant_guest:null,ssh_user:'vboxuser'},windows11:{vagrant_guest:'windows',ssh_user:'vboxuser'}};
const PROVIDERS=['virtualbox','libvirt','hyperv','qemu','parallels'];
const DEFAULT_PORTS={script_server:8421,vnc:5900,rdp:3389};
const NAME=/^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const BOX=/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,80}$/;
const SSH_USER=/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;

function quote(value){return JSON.stringify(String(value));}

function bounded(value,fallback,min,max){
  const number=Number(value);
  if(value===undefined||value===null||value==='')return fallback;
  if(!Number.isInteger(number)||number<min||number>max)throw new Error(`Expected an integer between ${min} and ${max}, received ${value}`);
  return number;
}

function guest_key(guest_os){
  const key=String(guest_os||'debian').toLowerCase();
  if(!Object.hasOwn(GUESTS,key))throw new Error(`Vagrant desktops support ${Object.keys(GUESTS).join(' or ')} guests`);
  return key;
}

/** Normalized, validated settings shared by creation and rendering. */
function normalize(values={},{}={}){
  if(typeof values.name!=='string'||!NAME.test(values.name))throw new Error('Desktop name must start with a letter and use letters, digits, "_" or "-"');
  const guest_os=guest_key(values.guest_os);
  const box=values.box===undefined||values.box===''?GUEST_BOXES[guest_os]:String(values.box);
  if(!BOX.test(box))throw new Error('Box name may only contain letters, digits, ".", "_" or "/"');
  const provider=String(values.provider||'virtualbox').toLowerCase();
  if(!PROVIDERS.includes(provider))throw new Error(`Vagrant provider must be one of ${PROVIDERS.join(', ')}`);
  const ssh_user=values.ssh_user||GUESTS[guest_os].ssh_user;
  if(!SSH_USER.test(ssh_user))throw new Error('Invalid SSH user name');
  const ports={...DEFAULT_PORTS,...(values.ports||{})};
  const normalized_ports=Object.fromEntries(Object.entries(ports).map(([name,value])=>[name,bounded(value,undefined,1,65535)]));
  const synced=Array.isArray(values.synced_folders)?values.synced_folders.map(folder=>{
    if(!folder||typeof folder.host!=='string'||!folder.host)throw new Error('Each synced folder needs a host path');
    if(typeof folder.guest!=='string'||!folder.guest.startsWith('/'))throw new Error('Each synced folder needs an absolute guest path');
    return {host:folder.host,guest:folder.guest,...(folder.type?{type:String(folder.type)}:{})};
  }):[];
  return {
    name:values.name,guest_os,box,box_version:values.box_version?String(values.box_version):null,provider,ssh_user,
    memory_mb:bounded(values.memory_mb,4096,512,262144),cpus:bounded(values.cpus,2,1,64),
    ports:normalized_ports,auto_correct:values.auto_correct!==false,
    synced_folders:synced,disable_default_sync:values.disable_default_sync!==false,
    gui:values.gui===true,boot_timeout:bounded(values.boot_timeout,600,60,7200),
  };
}

function provider_blocks(settings){
  const {memory_mb:memory,cpus,provider,gui}=settings;
  const blocks=[];
  blocks.push(['virtualbox',[
    `  p.memory = ${memory}`,
    `  p.cpus = ${cpus}`,
    `  p.gui = ${gui?'true':'false'}`,
    '  p.customize ["modifyvm", :id, "--graphicscontroller", "vmsvga", "--vram", "128", "--nat-localhostreachable1", "on"]',
  ]]);
  blocks.push(['libvirt',[
    `  p.memory = ${memory}`,
    `  p.cpus = ${cpus}`,
    '  p.driver = "kvm"',
    '  p.video_type = "vga"',
    '  p.graphics_type = "vnc"',
    '  p.graphics_ip = "127.0.0.1"',
    '  p.graphics_port = "-1"',
    '  p.machine_virtual_size = 64',
  ]]);
  blocks.push(['hyperv',[
    `  p.memory = ${memory}`,
    `  p.maxmemory = ${memory}`,
    `  p.cpus = ${cpus}`,
    '  p.vmname = ' + quote('VAMP-'+settings.name),
    '  p.enable_virtualization_extensions = true',
    '  p.linked_clone = true',
  ]]);
  blocks.push(['qemu',[
    `  p.memory = ${quote(String(memory))}`,
    `  p.smp = ${quote(String(cpus))}`,
    '  p.machine = "q35"',
    '  p.cpu = "host"',
    '  p.net_device = "virtio-net-pci"',
    '  p.disk_device = "virtio-blk-pci"',
  ]]);
  blocks.push(['parallels',[
    `  p.memory = ${memory}`,
    `  p.cpus = ${cpus}`,
    '  p.update_guest_tools = true',
  ]]);
  // Emit the selected provider first so a reader sees what will boot; the
  // remaining blocks stay inert until someone runs vagrant with that provider.
  blocks.sort((left,right)=>Number(right[0]===provider)-Number(left[0]===provider));
  return blocks.map(([name,lines])=>[
    `  config.vm.provider ${quote(name)} do |p|`,
    ...lines.map(line=>'  '+line),
    '  end',
  ].join('\n'));
}

/** Render the Vagrantfile body for one desktop. */
function render(values={}){
  const settings=normalize(values);
  const lines=[];
  lines.push('# Generated by VAMP. Regenerate through the adapter instead of editing.');
  lines.push(`# Desktop: ${settings.name} (${settings.guest_os} / ${settings.provider})`);
  lines.push('Vagrant.configure("2") do |config|');
  lines.push(`  config.vm.box = ${quote(settings.box)}`);
  if(settings.box_version)lines.push(`  config.vm.box_version = ${quote(settings.box_version)}`);
  lines.push('  config.vm.box_check_update = false');
  lines.push(`  config.vm.hostname = ${quote(settings.name.toLowerCase().replace(/_/g,'-'))}`);
  lines.push(`  config.vm.boot_timeout = ${settings.boot_timeout}`);
  // Both guests run the OpenSSH server that Packer provisions, so no guest
  // agent and no WinRM listener is needed on the guest.
  lines.push('  config.vm.communicator = "ssh"');
  if(GUESTS[settings.guest_os].vagrant_guest)lines.push(`  config.vm.guest = :${GUESTS[settings.guest_os].vagrant_guest}`);
  lines.push(`  config.ssh.username = ${quote(settings.ssh_user)}`);
  lines.push('  config.ssh.insert_key = false');
  lines.push('  config.ssh.forward_agent = false');
  lines.push(`  config.vm.synced_folder ".", "/vagrant", disabled: ${settings.disable_default_sync?'true':'false'}`);
  for(const folder of settings.synced_folders){
    lines.push(`  config.vm.synced_folder ${quote(folder.host)}, ${quote(folder.guest)}${folder.type?', type: '+quote(folder.type):''}`);
  }
  const forwards=[
    ['vamp-script-server','script_server',8421],
    ['vamp-vnc','vnc',5900],
    ['vamp-rdp','rdp',3389],
  ];
  for(const [id,key,guest] of forwards){
    const host=settings.ports[key];
    if(!host)continue;
    lines.push(`  config.vm.network "forwarded_port", guest: ${guest}, host: ${host}, host_ip: "127.0.0.1", id: ${quote(id)}, auto_correct: ${settings.auto_correct?'true':'false'}`);
  }
  lines.push(...provider_blocks(settings));
  lines.push('end');
  return lines.join('\n')+'\n';
}

/** Parse the guest ports a Vagrantfile asks the host to expose. */
function forwarded_ports(values={}){
  const settings=normalize(values);
  return {script_server:settings.ports.script_server,vnc:settings.ports.vnc,rdp:settings.ports.rdp};
}

module.exports={GUEST_BOXES,GUESTS,PROVIDERS,DEFAULT_PORTS,normalize,render,forwarded_ports,quote};
