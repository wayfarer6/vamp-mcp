"""Persistent stdio MCP client shared by Robot validation and CLI diagnostics."""
import asyncio
import json
import os
from pathlib import Path
import sys
import threading
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[2]


class Client:
    def __init__(self, config=None):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        self.config = config
        self._run(self._connect())

    def _run(self, coroutine, timeout=1900):
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result(timeout)

    async def _connect(self):
        self.ready = asyncio.get_running_loop().create_future()
        self.stop = asyncio.Event()
        self.task = asyncio.create_task(self._serve())
        await self.ready

    async def _serve(self):
        env = dict(os.environ)
        if self.config:
            env['VM_MCP_CONFIG'] = str(Path(self.config).resolve())
        try:
            async with stdio_client(StdioServerParameters(command=sys.executable,
                    args=[str(ROOT / 'vm_mcp_server.py')], env=env, cwd=str(ROOT))) as transport:
                async with ClientSession(*transport) as session:
                    self.session = session
                    await session.initialize()
                    self.ready.set_result(True)
                    await self.stop.wait()
        except BaseException as error:
            if not self.ready.done():
                self.ready.set_exception(error)
            else:
                raise

    async def _call(self, name, arguments):
        result = await self.session.call_tool(name, arguments)
        if result.structuredContent is not None:
            return result.structuredContent
        return json.loads(next(item.text for item in result.content if item.type == 'text'))

    def call(self, name, **arguments):
        return self._run(self._call(name, arguments))

    def tools(self):
        return self._run(self.session.list_tools())

    def close(self):
        # MCP's cancel scopes must exit in the same task which entered them.
        self._run(self._disconnect())
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=5)

    async def _disconnect(self):
        self.stop.set()
        await self.task
