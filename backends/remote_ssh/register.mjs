// Optional unified registration. Discovery never starts a process or connects SSH.
import { z } from '../../third_party/mcp-virtualbox/node_modules/zod/index.js';
import { resolveConfig } from './config.mjs';
import { createTools } from './tools.mjs';
import { normalizeRemoteConfig, RemoteSshClient } from './client.mjs';

const READ = new Set(['remote_audit_search','remote_env_check','remote_vm_list','remote_vm_status','remote_vm_screenshot','remote_golden_images']);

// Convert the finite JSON-schema vocabulary in tools.mjs, rejecting unknown
// vocabulary instead of silently weakening validation during consolidation.
export function remoteSchema(schema) {
  let value;
  if (schema.enum) value=z.enum(schema.enum);
  else if(schema.type==='string') {
    if(schema.format!==undefined&&schema.format!=='ipv4')throw Error(`Unsupported remote string format: ${schema.format}`);
    value=schema.format==='ipv4'?z.ipv4():z.string();
    if(schema.maxLength!==undefined)value=value.max(schema.maxLength);
    if(schema.pattern)value=value.regex(new RegExp(schema.pattern));
  } else if(schema.type==='boolean') value=z.boolean();
  else if(['number','integer'].includes(schema.type)) {
    value=z.number();if(schema.type==='integer')value=value.int();
    if(schema.minimum!==undefined)value=value.min(schema.minimum);
    if(schema.maximum!==undefined)value=value.max(schema.maximum);
  } else if(schema.type==='array') {
    value=z.array(remoteSchema(schema.items));
    if(schema.maxItems!==undefined)value=value.max(schema.maxItems);
  } else if(schema.type==='object') {
    const shape={};
    for(const [key,child] of Object.entries(schema.properties||{})) {
      let field=remoteSchema(child);
      if(!(schema.required||[]).includes(key))field=field.optional();
      // Defaults belong outside optional so omitted parameters retain old defaults.
      if(child.default!==undefined)field=field.default(child.default);
      shape[key]=field;
    }
    value=z.object(shape);
    if(schema.additionalProperties===false)value=value.strict();
    else if(typeof schema.additionalProperties==='object')value=value.catchall(remoteSchema(schema.additionalProperties));
    else value=value.passthrough();
  } else throw Error(`Unsupported remote tool schema: ${schema.type}`);
  if(schema.description)value=value.describe(schema.description);
  return value;
}

export function remoteContent(output) {
  const content=[];
  if(output?.text!==undefined)content.push({type:'text',text:JSON.stringify(output.text)});
  for(const image of output?.images||[])content.push({type:'image',data:image.data,mimeType:image.mimeType});
  if(output?.text===undefined) {
    // SSH one-shot results flatten screenshot metadata; do not echo image bytes
    // again inside the text block.
    const text=output && typeof output==='object' ? {...output} : output;
    if(text && typeof text==='object')delete text.images;
    content.unshift({type:'text',text:JSON.stringify(text)??'null'});
  }
  return {content};
}

export function registerRemoteTools(server, options={}) {
  const env=options.env||process.env;
  // Construct only the static catalog against harmless defaults. Real config
  // parsing/validation is deferred, so bad optional settings cannot kill VAMP.
  const catalog=createTools({run:()=>{throw Error('Discovery cannot execute');},config:resolveConfig({env:{},platform:options.platform})}).tools;
  let route;
  function target(){
    if(route)return route;
    let raw=options.remoteConfig;
    if(raw===undefined && env.VAMP_REMOTE_CONFIG_JSON!==undefined)raw=JSON.parse(env.VAMP_REMOTE_CONFIG_JSON);
    if(raw!==undefined){
      if(!raw || raw.enabled!==true)throw Error('Remote SSH is disabled. Enable and configure the intended remote host; no local fallback was attempted.');
      const config=normalizeRemoteConfig(raw);
      if(!config.host)throw Error('Remote SSH host is missing; no local fallback was attempted.');
      const client=options.clientFactory?options.clientFactory(config):new RemoteSshClient(config);
      route={call:(name,args)=>client.call(name,args)};
    }else{
      throw Error('Remote SSH is not configured. Set VAMP_REMOTE_CONFIG_JSON for the intended host, or use explicit kvm_* tools for the local Linux host. No local fallback was attempted.');
    }
    return route;
  }
  for(const tool of catalog){
    if(!tool.name.startsWith('remote_'))throw Error('Remote tools require the fixed remote_ namespace');
    const inputSchema=remoteSchema(tool.inputSchema);
    server.registerTool(tool.name,{title:tool.title,description:tool.description,inputSchema,
      annotations:{readOnlyHint:READ.has(tool.name)}},async args=>{
      try{return remoteContent(await target().call(tool.name,inputSchema.parse(args??{})));}
      catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({status:'error',message:String(error?.message||error)})}]};}
    });
  }
  return {names:catalog.map(tool=>tool.name)};
}

// Preserve the former Linux KVM-host registration independently from SSH.
// The fixed namespace and backend prevent toggling remote settings from silently
// changing where an existing call runs.
export function registerLocalKvmTools(server, options={}) {
  const env=options.env||process.env;
  const platform=options.platform||process.platform;
  const catalog=createTools({run:()=>{throw Error('Discovery cannot execute');},config:resolveConfig({env:{},platform})}).tools;
  let handlers;
  function local(){
    if(platform!=='linux')throw Error('Local KVM tools require a Linux host. No SSH or other backend fallback was attempted.');
    if(!handlers){
      const config={...resolveConfig({env:{...env,VAMP_REMOTE_REPO:env.VAMP_KVM_REPO||env.VAMP_REMOTE_REPO},argv:['--backend','kvm'],platform}),...options.localKvmConfig,backend:'kvm',platform};
      handlers=new Map(createTools({config,run:options.run,fsx:options.fsx,now:options.now}).tools.map(tool=>[tool.name,tool.handler]));
    }
    return handlers;
  }
  const names=[];
  for(const tool of catalog){
    const name=tool.name.replace(/^remote_/,'kvm_'),inputSchema=remoteSchema(tool.inputSchema);
    names.push(name);
    server.registerTool(name,{title:tool.title?.replace(/remote/gi,'local KVM'),
      description:'LOCAL LINUX KVM HOST ONLY (not SSH). '+tool.description.replace(/remote_/g,'kvm_'),
      inputSchema,annotations:{readOnlyHint:READ.has(tool.name)}},async (args,extra)=>{
      try{return remoteContent(await local().get(tool.name)(inputSchema.parse(args??{}),extra));}
      catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({status:'error',message:String(error?.message||error)})}]};}
    });
  }
  return {names};
}
