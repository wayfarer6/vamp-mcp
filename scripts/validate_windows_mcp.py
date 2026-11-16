"""Exercise the real stdio server in the disposable Windows hypervisor lab."""
import asyncio
import json
import os
from pathlib import Path
import sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main():
    root=Path(__file__).resolve().parents[1]
    params=StdioServerParameters(command=sys.executable,args=[str(root/'vm_mcp_server.py')],cwd=str(root),env=dict(os.environ))
    async with stdio_client(params) as streams:
        async with ClientSession(*streams) as session:
            await session.initialize()
            tools=await session.list_tools()
            names={t.name for t in tools.tools}
            assert {'vm_list','hyperv_open_console','vm_file_put','vm_file_get'}<=names,names
            response=await session.call_tool('vm_list',{})
            inventory=response.structuredContent or json.loads(response.content[0].text)
            assert inventory['status']=='observed' and inventory['backend']=='hyperv',inventory
            assert any(v['name']=='VAMP-Nested-Windows' and v['state']=='Running' for v in inventory['vms']),inventory
            response=await session.call_tool('vm_file_put',{'vm_name':'VAMP-Nested-Windows','backend':'hyperv','local_path':str(root/'requirements-mcp.txt'),'guest_path':'mcp-probe.txt'})
            transfer=response.structuredContent or json.loads(response.content[0].text)
            assert transfer['status']=='needs_credentials',transfer
            print(json.dumps({'status':'passed','host':sys.platform,'tool_count':len(names),'inventory':inventory,'no_credentials_transfer':transfer},ensure_ascii=False))

if __name__=='__main__':asyncio.run(main())
