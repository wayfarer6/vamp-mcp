'use strict';
// Vagrant provider plugins. A provider that ships inside Vagrant needs none;
// the rest are gems installed into the user's own Vagrant home (~/.vagrant.d).

const PROVIDERS={
  virtualbox:{plugin:null,builtin:true,platforms:['linux','win32','darwin']},
  hyperv:{plugin:null,builtin:true,platforms:['win32']},
  libvirt:{plugin:'vagrant-libvirt',builtin:false,platforms:['linux']},
  qemu:{plugin:'vagrant-qemu',builtin:false,platforms:['linux','darwin']},
  parallels:{plugin:'vagrant-parallels',builtin:false,platforms:['darwin']},
};
const ARM_ONLY_VIRTUALBOX_UNSUPPORTED=['darwin'];

/** Providers that can run on this host and CPU architecture. */
function providers(platform=process.platform,architecture=process.arch){
  return Object.entries(PROVIDERS).flatMap(([provider,item])=>{
    if(!item.platforms.includes(platform))return [];
    // VirtualBox has no Apple Silicon build, so a darwin arm64 host needs qemu
    // or Parallels instead.
    const armVirtualBox=provider==='virtualbox'&&architecture==='arm64'&&ARM_ONLY_VIRTUALBOX_UNSUPPORTED.includes(platform);
    return [{provider,plugin:item.plugin,builtin:item.builtin,architecture_supported:!armVirtualBox}];
  });
}

function plugin_for(provider){
  const item=PROVIDERS[provider];
  if(!item)throw new Error(`Unknown Vagrant provider: ${provider}`);
  return item.plugin;
}

function require_supported(provider,platform=process.platform,architecture=process.arch){
  const item=PROVIDERS[provider];
  if(!item)throw new Error(`Unknown Vagrant provider: ${provider}`);
  if(!item.platforms.includes(platform))throw new Error(`${provider} Vagrant machines are unsupported on ${platform}; use ${providers(platform,architecture).filter(p=>p.architecture_supported).map(p=>p.provider).join(' or ')||'another host'}`);
  if(provider==='virtualbox'&&architecture==='arm64'&&platform==='darwin')throw new Error('VirtualBox has no Apple Silicon build; use the qemu or parallels Vagrant provider on this Mac');
  return item;
}

function install_command(provider){
  const plugin=plugin_for(provider);
  return plugin?`vagrant plugin install ${plugin}`:null;
}

/** Parse `vagrant plugin list` output into a name → version map. */
function parse_list(text){
  const plugins=new Map();
  for(const line of String(text||'').split(/\r?\n/)){
    const match=line.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s+\(([^)]*)\)/);
    if(match)plugins.set(match[1],match[2].split(',')[0].trim());
  }
  return plugins;
}

async function list(run){
  const output=typeof run==='function'?await run(['plugin','list']):run;
  return parse_list(output);
}

/**
 * Make sure the provider's plugin exists. `install:false` only reports.
 * Installing writes to the user's Vagrant home, so callers pass install
 * explicitly rather than assuming a host may change.
 */
async function ensure(provider,{run,install=true,timeout=900000}={}){
  const plugin=plugin_for(provider);
  if(!plugin)return {provider,plugin:null,installed:true,installed_now:false};
  const plugins=await list(run);
  if(plugins.has(plugin))return {provider,plugin,version:plugins.get(plugin),installed:true,installed_now:false};
  if(!install)return {provider,plugin,installed:false,installed_now:false,command:install_command(provider)};
  await run(['plugin','install',plugin],{timeout});
  const after=await list(run);
  if(!after.has(plugin))throw new Error(`Vagrant plugin ${plugin} is still missing after installation; run "${install_command(provider)}" and check the Vagrant plugin log`);
  return {provider,plugin,version:after.get(plugin),installed:true,installed_now:true};
}

module.exports={PROVIDERS,providers,plugin_for,require_supported,install_command,parse_list,list,ensure};
