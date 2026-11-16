"""Native Windows integration checks against the packaged Vault MCP server."""
import argparse
import asyncio
from datetime import timedelta
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main(args):
    root=Path(args.root)
    node=next((root/'node').rglob('node.exe'))
    extension=next((root/'extensions').glob('wayfarer6.vamp-vault-*'))
    checks=[]
    with tempfile.TemporaryDirectory(prefix='vault-native-',dir=root) as temporary:
        database=Path(temporary)/'test.kdbx'
        master=secrets.token_urlsafe(24)
        secret=secrets.token_urlsafe(24)
        env={**os.environ,'VAULT_KEEPASSXC_CLI':r'C:\Program Files\KeePassXC\keepassxc-cli.exe',
             'VAULT_VERACRYPT_CLI':r'C:\Program Files\VeraCrypt\VeraCrypt.exe','VAULT_MASTER_PASSWORD':master,
             'VAULT_KDBX':str(database),'VAULT_MOUNT_POINT':'V:','VAULT_APPROVAL_MODE':'per-session'}
        params=StdioServerParameters(command=str(node),args=[str(extension/'dist/runtime/backends/vault/server.mjs')],env=env)
        async with stdio_client(params) as streams:
            async with ClientSession(*streams) as client:
                await client.initialize()
                async def call(name,**arguments):
                    response=await client.call_tool(name,arguments,read_timeout_seconds=timedelta(seconds=360))
                    return json.loads(response.content[0].text)
                def check(name,condition):
                    if not condition:raise AssertionError(name)
                    checks.append(name)
                tools=await client.list_tools()
                check('nine packaged MCP tools',len(tools.tools)==9)
                status=await call('vault_status')
                check('native KeePassXC CLI resolves',status['cli']['keepassxc']['available'])
                check('native VeraCrypt PE version resolves',status['cli']['veracrypt']['available'])
                check('create encrypted database',(await call('vault_create',master_password=master))['status']=='created')
                check('refuse database overwrite',(await call('vault_create',master_password=master))['code']=='already_exists')
                created=await call('vault_set_credential',entry='Native Windows',group='Integration',username='lab-user',password=secret)
                check('create grouped credential',created['status']=='created')
                listing=await call('vault_list_credentials')
                check('list without password disclosure',any(x['path']=='Integration/Native Windows' for x in listing['entries']) and secret not in json.dumps(listing))
                pending=await call('vault_get_credential',entry='Integration/Native Windows',fields=['password'])
                check('read requires consent',pending['status']=='approval_required')
                approved=await call('vault_get_credential',entry='Integration/Native Windows',fields=['username','password'],confirm=True)
                check('approved read returns exact fixture',approved.get('username')=='lab-user' and approved.get('password')==secret)
                cached=await call('vault_get_credential',entry='Integration/Native Windows',fields=['password'])
                check('session cache',cached.get('cached') and cached.get('password')==secret)
                updated=secrets.token_urlsafe(24)
                check('update credential',(await call('vault_update_credential',entry='Integration/Native Windows',password=updated))['status']=='updated')
                reread=await call('vault_get_credential',entry='Integration/Native Windows',fields=['password'],confirm=True)
                check('update invalidates old cache',reread.get('password')==updated)
                check('delete credential',(await call('vault_delete_credential',entry='Integration/Native Windows'))['status']=='deleted')
                check('database encrypted on disk',secret.encode() not in database.read_bytes() and master.encode() not in database.read_bytes())
                if args.volume:
                    if Path('V:\\').exists():raise RuntimeError('V: is already occupied')
                    (root/'vault-native-awaiting-password.json').write_text(json.dumps({'stage':'native_password_dialog','volume':args.volume}))
                    mounted=await call('vault_mount_volume',volume=args.volume,mount_point='V:',confirm=True)
                    check('native VeraCrypt dialog mounts fixture',mounted.get('mounted') is True and mounted.get('password_source')=='native_windows_dialog')
                    try:
                        marker=Path('V:\\round-trip.txt')
                        marker.write_text('VAMP Windows VeraCrypt native integration',encoding='utf-8')
                        check('mounted volume permits real file IO',marker.read_text(encoding='utf-8')=='VAMP Windows VeraCrypt native integration')
                    finally:
                        unmounted=await call('vault_unmount_volume',mount_point='V:')
                    check('native volume dismount verified',unmounted.get('unmounted') is True and not Path('V:\\').exists())
        print(json.dumps({'status':'passed','platform':os.name,'checks':checks,'count':len(checks)},ensure_ascii=False))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',default=r'C:\VAMP-Lab');parser.add_argument('--volume');asyncio.run(main(parser.parse_args()))
