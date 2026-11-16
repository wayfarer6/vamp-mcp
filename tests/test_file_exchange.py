import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from mcp_vm import file_transfer
from backends.virtualbox import transfers
from backends.hyperv.scripts.file_transfer import transfer as hyperv_transfer


class FakeAgent:
    root=None
    def __init__(self,*args):self.handles={};self.next=0
    def close(self):
        for stream in self.handles.values():stream.close()
    def program(self,operation,path='',*extra):
        result=subprocess.run([sys.executable,'-c',file_transfer.GUEST_PROGRAM,operation,str(self.root),path,*extra],capture_output=True,text=True)
        if result.returncode:raise RuntimeError(result.stderr.splitlines()[-1])
        return json.loads(result.stdout)
    def call(self,operation,**args):
        if operation=='guest-ping':return {}
        if operation=='guest-file-open':
            self.next+=1;self.handles[self.next]=open(args['path'],args['mode']);return self.next
        stream=self.handles[args['handle']]
        if operation=='guest-file-close':stream.close();del self.handles[args['handle']];return {}
        if operation=='guest-file-write':
            data=base64.b64decode(args['buf-b64']);written=stream.write(data[:4096]);return {'count':written}
        if operation=='guest-file-read':
            data=stream.read(args['count']);return {'count':len(data),'buf-b64':base64.b64encode(data).decode(),'eof':len(data)<args['count']}
        raise AssertionError(operation)


class GuestExchangeTests(unittest.TestCase):
    def test_binary_stream_roundtrip_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);FakeAgent.root=root/'guest';source=root/'source.bin';destination=root/'copy.bin'
            payload=bytes(range(256))*3001;source.write_bytes(payload)
            with patch.object(file_transfer,'GuestAgent',FakeAgent):
                prepared=file_transfer.prepare(None,'VM');self.assertEqual(prepared['status'],'ready')
                sent=file_transfer.put(None,'VM',source,'nested/data.bin')
                self.assertTrue(sent['verified']);self.assertEqual(sent['sha256'],hashlib.sha256(payload).hexdigest())
                received=file_transfer.get(None,'VM','nested/data.bin',destination)
                self.assertEqual(destination.read_bytes(),payload);self.assertEqual(received['bytes'],len(payload))
                with self.assertRaises(RuntimeError):file_transfer.put(None,'VM',source,'nested/data.bin')
                with self.assertRaises(FileExistsError):file_transfer.get(None,'VM','nested/data.bin',destination)
                self.assertEqual(destination.read_bytes(),payload)
                self.assertFalse(list(root.rglob('.vamp-transfer-*')))

    def test_traversal_rejected_without_guest_io(self):
        for value in ['../secret','/etc/shadow','C:/secret','dir/../../secret','dir\\secret','dir/./file']:
            with self.subTest(path=value),patch.object(file_transfer,'GuestAgent') as agent:
                with self.assertRaises(ValueError):file_transfer.put(None,'VM','unused',value)
                agent.assert_not_called()

    def test_guest_symlink_cannot_escape_exchange(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);FakeAgent.root=root/'guest';FakeAgent.root.mkdir();outside=root/'outside';outside.mkdir()
            (FakeAgent.root/'escape').symlink_to(outside,target_is_directory=True)
            source=root/'source';source.write_bytes(b'payload')
            with patch.object(file_transfer,'GuestAgent',FakeAgent):
                with self.assertRaises(RuntimeError):file_transfer.put(None,'VM',source,'escape/file')
            self.assertEqual(list(outside.iterdir()),[])

    def test_hyperv_does_not_launch_a_windows_worker_on_linux(self):
        with patch('backends.hyperv.scripts.file_transfer.sys.platform','linux'):
            self.assertEqual(hyperv_transfer('VM','put','source','test.bin')['status'],'unsupported_host')


class VirtualBoxExchangeTests(unittest.TestCase):
    def test_staging_and_guest_reply_copy_have_distinct_statuses(self):
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'VAMP_DATA_DIR':directory}):
            root=Path(directory);source=root/'source';source.write_bytes(bytes(range(256))*10);calls=[]
            def run(*args):
                calls.append(args)
                return 'VMState="poweroff"\n' if args[0]=='showvminfo' else ''
            sent=transfers.put('VM',source,'nested/data.bin',run=run)
            self.assertEqual(sent['status'],'staged');self.assertFalse(sent['guest_delivery_verified'])
            shared=transfers.exchange_root('VM');self.assertEqual((shared/'nested/data.bin').read_bytes(),source.read_bytes())
            (shared/'reply.bin').write_bytes(b'guest reply\x00\xff')
            received=transfers.get('VM','reply.bin',root/'reply.bin',run=run)
            self.assertEqual(received['status'],'copied');self.assertEqual((root/'reply.bin').read_bytes(),b'guest reply\x00\xff')
            with self.assertRaises(FileExistsError):transfers.put('VM',source,'nested/data.bin',run=run)
            with self.assertRaises(ValueError):transfers.get('VM','../source',root/'bad',run=run)
            self.assertTrue(any(args[0]=='sharedfolder' for args in calls))

if __name__=='__main__':unittest.main()
