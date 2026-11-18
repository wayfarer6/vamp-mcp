#!/usr/bin/env node
// One public VAMP registration; registrars do not connect transports or prepare hosts.
import {McpServer} from '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import {StdioServerTransport} from '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import {registerVirtualBoxTools,virtualBoxInstructions} from '../virtualbox/server.mjs';
import {registerLibraryTools,libraryInstructions} from '../library/server.mjs';
import {registerPodmanTools,podmanInstructions} from '../podman/server.mjs';
import {registerRemoteTools,remoteInstructions} from '../remote_ssh/server.mjs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
export function createUnifiedServer({remote={},podman={}}={}){
  const instructions=[virtualBoxInstructions,libraryInstructions,podmanInstructions,remoteInstructions,
    'This is the single VAMP MCP server. VirtualBox VM tools retain vm_ names; remote backend tools use remote_ names. Podman manages existing containers, scoped workspace sessions and explicitly authorized local Debian VM builds. Vault remains a separate server. Registration and initialization do not prepare or start hosts, guests, models, or container engines.'].join('\n\n');
  const server=new McpServer({name:'VAMP MCP',version:'0.3.2'},{instructions});
  registerVirtualBoxTools(server);
  registerLibraryTools(server);
  registerPodmanTools(server,podman);
  registerRemoteTools(server,remote);
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  await createUnifiedServer().connect(new StdioServerTransport());
}
