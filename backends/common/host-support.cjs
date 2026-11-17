// No hypervisor commands here: host capability policy shared by UI adapters.
const profile=require('./guest-install.json');
function requireBackendHost(backend,platform=process.platform){
  if(!profile.hosts[backend]?.includes(platform))throw Error(`${backend} local management is unsupported on ${platform}`);
}
function requireInstallHost(backend,platform=process.platform,architecture=process.arch){
  requireBackendHost(backend,platform);
  if(!profile.amd64_install_host_arches.includes(architecture))throw Error(`Current amd64 installer profiles require an x64 host; ${architecture} is unsupported`);
}
function backendCapabilities(platform=process.platform){
  return Object.fromEntries(Object.entries(profile.hosts).map(([backend,hosts])=>[backend,{
    hostSupported:hosts.includes(platform),implemented:backend!=='apple-hypervisor',
    reason:!hosts.includes(platform)?'unsupported_host':backend==='apple-hypervisor'?'not_implemented':null,
  }]));
}
module.exports={requireBackendHost,requireInstallHost,backendCapabilities};
