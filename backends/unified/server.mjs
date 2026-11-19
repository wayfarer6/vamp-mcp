#!/usr/bin/env node
// One public VAMP registration; registrars do not connect transports or prepare hosts.
import {McpServer} from '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import {StdioServerTransport} from '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import {registerVirtualBoxTools,virtualBoxInstructions} from '../virtualbox/server.mjs';
import {registerLibraryTools,libraryInstructions} from '../library/server.mjs';
import {registerPodmanTools,podmanInstructions} from '../podman/server.mjs';
import {registerRemoteTools,remoteInstructions} from '../remote_ssh/server.mjs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import visionPreload from '../common/vision-preload.cjs';
import windowsAdmin from '../common/windows-admin.cjs';
import path from 'node:path';
export function createUnifiedServer({remote={},podman={}}={}){
  const instructions=[virtualBoxInstructions,libraryInstructions,podmanInstructions,remoteInstructions,
    'This is the single VAMP MCP server. VirtualBox VM tools retain vm_ names; remote backend tools use remote_ names. Podman manages existing containers, scoped workspace sessions and explicitly authorized local Debian VM builds. Vault remains a separate server. Startup preloads configured host vision models locally. Registration and initialization do not prepare or start hosts, guests, or container engines.'].join('\n\n');
  const server=new McpServer({name:'VAMP MCP',version:'0.3.9'},{instructions});
  registerVirtualBoxTools(server);
  registerLibraryTools(server);
  registerPodmanTools(server,podman);
  registerRemoteTools(server,remote);
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try { await windowsAdmin.requireAdministrator(); }
  catch (error) { console.error(error.message); process.exit(1); }
  await createUnifiedServer().connect(new StdioServerTransport());
  if (visionPreload.enabled()) {
    try {
      const local = fileURLToPath(new URL('../..', import.meta.url));
      const assets = await globalThis[Symbol.for('vamp.provisioningAssets')]?.(true);
      visionPreload.ensureVisionServices({runtime:assets || local,logger:message=>console.error(message)});
    } catch (error) {
      console.error('VAMP vision startup unavailable:', error.message);
    }
  }
}
