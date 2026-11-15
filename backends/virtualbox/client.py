"""Robot/Python client for the pinned upstream-backed VirtualBox MCP server."""
from __future__ import annotations
import argparse
import asyncio
import base64
from datetime import timedelta
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
TOOLS = {'vm_list','vm_info','vm_start','vm_screenshot','vm_screen_info',
         'vm_keyboard_scancode','vm_keyboard_type','vm_mouse_click','vm_prepare_recorder','vm_create','vm_configure_display','vm_insert_guest_additions'}

async def request(tool: str, arguments: dict, screenshot: str | None = None):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    if tool not in TOOLS:
        raise ValueError(f'Unsupported tool: {tool}')
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Install Node.js and put node on PATH')
    if not (ROOT/'third_party/mcp-virtualbox/dist/index.js').is_file():
        raise RuntimeError('Build third_party/mcp-virtualbox first: npm ci --ignore-scripts; npm run build')
    env = dict(os.environ)
    # Avoid upstream debug logs recording typed secrets.
    env['VBOXMANAGE_DEBUG'] = 'false'
    env['RPA_HOST_PYTHON'] = sys.executable
    env['SCREENSHOT_DIR'] = tempfile.gettempdir()
    params = StdioServerParameters(command=node, args=[str(ROOT/'backends/virtualbox/server.mjs')], env=env)
    async with asyncio.timeout(450 if tool == 'vm_create' else 90):
        async with stdio_client(params) as streams:
            async with ClientSession(*streams) as session:
                await session.initialize()
                response = await session.call_tool(tool, arguments, read_timeout_seconds=timedelta(seconds=450 if tool == 'vm_create' else 90))
    if response.isError:
        raise RuntimeError('; '.join(getattr(c,'text','') for c in response.content))
    output = {'status':'completed', 'tool':tool, 'texts':[]}
    for block in response.content:
        if block.type == 'text':
            output['texts'].append(block.text)
        elif block.type == 'image':
            if screenshot is None:
                raise ValueError('vm_screenshot requires a local --screenshot output path')
            path = Path(screenshot).expanduser().resolve()
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_bytes(base64.b64decode(block.data, validate=True))
            output['screenshot'] = str(path)
    return output

class VirtualBox:
    ROBOT_LIBRARY_SCOPE = 'SUITE'

    def call_vm_tool(self, tool: str, arguments: str = '{}', screenshot: str = ''):
        """Generic Robot keyword. Arguments are JSON, screenshots stay local."""
        return asyncio.run(request(tool, json.loads(arguments), screenshot or None))

    def observe_vm(self, vm: str, screenshot: str):
        """Capture only; does not imply guest/application readiness."""
        return asyncio.run(request('vm_screenshot', {'vm':vm}, screenshot))

    def start_vm(self, vm: str, frontend: str = 'separate'):
        return asyncio.run(request('vm_start', {'vm':vm,'type':frontend}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tool', choices=sorted(TOOLS))
    parser.add_argument('--args', default='{}', help='JSON arguments; do not put credentials on the command line')
    parser.add_argument('--screenshot', help='Local output PNG path for vm_screenshot')
    options = parser.parse_args()
    try:
        print(json.dumps(asyncio.run(request(options.tool,json.loads(options.args),options.screenshot)),ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'status':'failed','error':str(exc)},ensure_ascii=False),file=sys.stderr)
        sys.exit(1)
