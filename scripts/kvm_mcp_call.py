#!/usr/bin/env python3
"""One diagnostic MCP call; stdout contains only its JSON result."""
import asyncio
from contextlib import AsyncExitStack
import json
import os
from pathlib import Path
import sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main():
    root = Path(__file__).resolve().parents[1]
    async with stdio_client(StdioServerParameters(command=sys.executable, args=[str(root/'vm_mcp_server.py')], env=dict(os.environ), cwd=str(root))) as transport:
        async with ClientSession(*transport) as session:
            await session.initialize()
            result = await session.call_tool(sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv)>2 else {})
            print(json.dumps(result.structuredContent or json.loads(result.content[0].text), indent=2))

if __name__ == '__main__':
    asyncio.run(main())
