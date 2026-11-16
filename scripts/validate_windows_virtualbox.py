"""Use the packaged VirtualBox MCP server on the disposable Windows lab host."""
import argparse
import asyncio
import base64
from datetime import timedelta
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main(args):
    root=Path(args.root)
    extension=next((root/'extensions').glob('wayfarer6.vamp-mcp-*'))
    runtime=extension/'dist/runtime'
    node=next((root/'node').rglob('node.exe'))
    env={**os.environ,'VBOXMANAGE_PATH':r'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe',
         'VBOX_MSI_INSTALL_PATH':r'C:\Program Files\Oracle\VirtualBox',
         'VBOXMANAGE_DEBUG':'false','RPA_HOST_PYTHON':sys.executable,'PYTHON_PATH':sys.executable,
         'MOUSE_HELPER_PATH':str(runtime/'backends/virtualbox/mouse_click.py'),
         'SCREENSHOT_DIR':str(root),'VAMP_DATA_DIR':str(root/'data')}
    params=StdioServerParameters(command=str(node),args=[str(runtime/'backends/virtualbox/server.mjs')],cwd=str(root),env=env)
    checks=[]
    async with stdio_client(params) as streams:
        async with ClientSession(*streams) as client:
            await client.initialize()
            tools=await client.list_tools()
            assert {'vm_list','vm_start','vm_screenshot','vm_keyboard_type','vm_mouse_click','vm_file_put','vm_file_get'}<={t.name for t in tools.tools}
            checks.append('packaged MCP tools registered')
            async def call(name,**arguments):
                response=await client.call_tool(name,arguments,read_timeout_seconds=timedelta(seconds=120))
                if response.isError:raise RuntimeError('; '.join(c.text for c in response.content if c.type=='text'))
                if name=='vm_screenshot':
                    item=next(c for c in response.content if c.type=='image')
                    target=root/('vbox-'+args.action+'.png');target.write_bytes(base64.b64decode(item.data));return str(target)
                value=next(c.text for c in response.content if c.type=='text')
                try:return json.loads(value)
                except json.JSONDecodeError:return value
            inventory=await call('vm_list')
            assert any(v['name']==args.vm for v in inventory),inventory
            checks.append('real VM inventory')
            if args.action=='boot':
                result=await call('vm_start',vm=args.vm,type='separate')
                assert result['status'] in ('start_requested','already_running'),result
                checks.append('explicit detachable frontend start')
                deadline=time.monotonic()+30
                while True:
                    try:info=await call('vm_info',vm=args.vm)
                    except RuntimeError as error:
                        if not any(text in str(error).lower() for text in ('unexpected process','being locked','session is busy')) or time.monotonic()>=deadline:raise
                        await asyncio.sleep(1);continue
                    if info['VMState']=='running' or time.monotonic()>=deadline:break
                    await asyncio.sleep(1)
                assert info['VMState']=='running',info
                screenshot=await call('vm_screenshot',vm=args.vm)
                checks.append('real running guest screenshot')
            elif args.action=='capture':
                screenshot=await call('vm_screenshot',vm=args.vm)
                info=await call('vm_screen_info',vm=args.vm)
                checks.append('real display capture')
            elif args.action=='input':
                await call('vm_keyboard_scancode',vm=args.vm,keys='win+r')
                await asyncio.sleep(1)
                await call('vm_keyboard_type',vm=args.vm,text='notepad.exe',chunkSize=8,delayMs=150)
                await call('vm_keyboard_scancode',vm=args.vm,keys='enter')
                await asyncio.sleep(3)
                await call('vm_keyboard_type',vm=args.vm,text='VAMP VirtualBox MCP keyboard verified',chunkSize=8,delayMs=150)
                screenshot=await call('vm_screenshot',vm=args.vm)
                info={'input_delivered':True,'visual_confirmation_required':True}
                checks.append('real keyboard input delivered')
            elif args.action=='terminal':
                await call('vm_keyboard_scancode',vm=args.vm,keys='win+r')
                await asyncio.sleep(1)
                await call('vm_keyboard_type',vm=args.vm,text='powershell.exe',chunkSize=8,delayMs=150)
                await call('vm_keyboard_scancode',vm=args.vm,keys='enter')
                await asyncio.sleep(3)
                screenshot=await call('vm_screenshot',vm=args.vm)
                info={'terminal_launch_requested':True,'visual_confirmation_required':True}
                checks.append('PowerShell launch requested through guest launcher')
            elif args.action=='additions':
                await call('vm_keyboard_scancode',vm=args.vm,keys='win+r')
                await asyncio.sleep(1)
                await call('vm_keyboard_type',vm=args.vm,text=r'D:\VBoxWindowsAdditions.exe',chunkSize=8,delayMs=150)
                await call('vm_keyboard_scancode',vm=args.vm,keys='enter')
                await asyncio.sleep(3)
                screenshot=await call('vm_screenshot',vm=args.vm)
                info={'installer_launch_requested':True,'visual_confirmation_required':True}
                checks.append('matching Guest Additions launcher requested')
            elif args.action=='display':
                info=await call('vm_configure_display',vm=args.vm)
                assert info.get('resolution_verified') and info.get('observed_resolution')==[1920,1080],info
                screenshot=await call('vm_screenshot',vm=args.vm)
                checks.append('native 1920x1080 verified from PNG pixels')
            elif args.action=='mouse':
                if args.x is None or args.y is None:raise ValueError('Supply observed native guest coordinates')
                await call('vm_mouse_click',vm=args.vm,x=args.x,y=args.y)
                await asyncio.sleep(1)
                screenshot=await call('vm_screenshot',vm=args.vm)
                info={'mouse_delivered':True,'x':args.x,'y':args.y,'visual_confirmation_required':True}
                checks.append('native SDK mouse input delivered')
            elif args.action=='exchange':
                payload=os.urandom(8193);source=root/'vbox-payload.bin';source.write_bytes(payload)
                put=await call('vm_file_put',vm=args.vm,local_path=str(source),guest_path='integration/payload.bin',overwrite=True)
                assert put['status']=='staged',put
                blocked=await call('vm_file_put',vm=args.vm,local_path=str(source),guest_path='integration/payload.bin')
                assert blocked.get('status')=='error',blocked
                traversal=await call('vm_file_put',vm=args.vm,local_path=str(source),guest_path='../outside.bin')
                assert traversal.get('status')=='error',traversal
                shared=Path(put['shared_file']).parent
                result_file=shared/'guest-result.json';result_file.unlink(missing_ok=True)
                # The controller must first visually verify the terminal phase.
                # Keep this script out of Win+R, which truncates long commands.
                command="$r='\\\\VBOXSVR\\VAMPFiles\\integration\\';$b=[IO.File]::ReadAllBytes($r+'payload.bin');[Array]::Reverse($b);[IO.File]::WriteAllBytes($r+'guest-reply.bin',$b);@{sha256=(Get-FileHash ($r+'guest-reply.bin')).Hash;bytes=$b.Length}|ConvertTo-Json|Set-Content ($r+'guest-result.json')"
                await call('vm_keyboard_type',vm=args.vm,text=command,chunkSize=12,delayMs=150)
                await call('vm_keyboard_scancode',vm=args.vm,keys='enter')
                deadline=time.monotonic()+90
                while not result_file.exists() and time.monotonic()<deadline:await asyncio.sleep(1)
                assert result_file.exists(),'Guest did not read/write the real shared folder'
                guest=json.loads(result_file.read_text(encoding='utf-8-sig'))
                expected=hashlib.sha256(payload[::-1]).hexdigest()
                assert guest['sha256'].lower()==expected and guest['bytes']==8193,guest
                destination=root/('vbox-received-'+str(time.time_ns())+'.bin')
                get=await call('vm_file_get',vm=args.vm,guest_path='integration/guest-reply.bin',local_path=str(destination))
                assert get['status']=='copied' and destination.read_bytes()==payload[::-1],get
                blocked_get=await call('vm_file_get',vm=args.vm,guest_path='integration/guest-reply.bin',local_path=str(destination))
                assert blocked_get.get('status')=='error',blocked_get
                info={'bytes':8193,'sha256':expected,'guest_read_and_write_verified':True,'overwrite_blocked':True,'traversal_blocked':True}
                screenshot=await call('vm_screenshot',vm=args.vm)
                checks.append('guest shared-folder IO and binary round trip')
            print(json.dumps({'status':'passed','action':args.action,'checks':checks,'info':info,'screenshot':screenshot},ensure_ascii=False))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['boot','capture','input','terminal','additions','display','mouse','exchange']);p.add_argument('--root',default=r'C:\VAMP-Lab');p.add_argument('--vm',default='VAMP-VBox-Windows');p.add_argument('--x',type=int);p.add_argument('--y',type=int);asyncio.run(main(p.parse_args()))
