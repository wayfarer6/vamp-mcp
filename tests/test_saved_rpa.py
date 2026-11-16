import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
def module(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'backends/library'/f'{name}.py')
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result
registry=module('registry');replay=module('replay')
class SavedRPATests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.source=self.root/'source.py';self.source.write_text("import pyautogui\npyautogui.write('${query}')\npyautogui.press('enter')\n")
        self.request={'title':'Search invoice','description':'Enter a query into the guest search field','source_path':str(self.source),'backend':'kvm','width':640,'height':480,'inputs':['query'],'reviewed':True}
    def test_registers_title_description_contract_without_executing_source(self):
        saved=registry.register(self.root/'catalog',self.request)
        self.assertEqual(saved['definition']['name'],'Search invoice');self.assertFalse(saved['definition']['source_executed']);self.assertEqual(saved['definition']['action_count'],2)
        request={'registry':str(self.root/'catalog'),'id':saved['definition']['id'],'vm_id':'12345678-1234-1234-1234-123456789abc','inputs':{'query':'November'},'confirmed':True}
        metadata,actions=replay.load(request);self.assertEqual(actions[0]['text'],'November')
        request['confirmed']=False
        with self.assertRaisesRegex(ValueError,'confirm'):replay.load(request)
        request['confirmed']=True;(Path(saved['folder'])/'source.py').write_text('changed')
        with self.assertRaisesRegex(ValueError,'uncommitted|source changed'):replay.load(request)
    def test_rejects_unreviewed_unsupported_and_unused_input_names(self):
        bad={**self.request,'inputs':['missing']}
        with self.assertRaisesRegex(ValueError,'placeholder'):registry.register(self.root/'catalog',bad)
        with self.assertRaisesRegex(ValueError,'Hyper-V'):registry.register(self.root/'catalog',{**self.request,'backend':'hyperv'})
        saved=registry.register(self.root/'catalog',{**self.request,'reviewed':False})
        with self.assertRaisesRegex(ValueError,'Review'):replay.load({'registry':str(self.root/'catalog'),'id':saved['definition']['id'],'vm_id':'12345678-1234-1234-1234-123456789abc','confirmed':True,'inputs':{'query':'x'}})
    def test_replay_checks_geometry_and_releases_keys_on_failure(self):
        class Driver:
            def __init__(self):self.closed=False;self.keys=[]
            def geometry(self):return [640,480]
            def down(self,key):self.keys.append(key)
            def up(self,key):self.keys.remove(key)
            async def drain(self):pass
            def close(self):self.closed=True;self.keys=[]
        driver=Driver();count=asyncio.run(replay.replay(driver,[{'op':'hotkey','keys':['ctrl','l']}],[640,480]));self.assertEqual(count,1);self.assertTrue(driver.closed);self.assertEqual(driver.keys,[])
        with self.assertRaisesRegex(ValueError,'resolution'):asyncio.run(replay.replay(Driver(),[],[1920,1080]))

    def test_each_skill_has_independent_git_versions_and_repair_conflict_protection(self):
        saved=registry.register(self.root/'catalog',self.request)
        folder=Path(saved['folder']);self.assertTrue((folder/'.git').is_dir())
        self.source.write_text("import pyautogui\npyautogui.write('${query}')\npyautogui.press('tab')\n")
        repaired=registry.register(self.root/'catalog',{**self.request,'id':saved['definition']['id'],'expected_commit':saved['commit'],'reviewed':False,'commit_message':'Repair tab navigation'})
        self.assertEqual(repaired['definition']['version'],'1.0.1');self.assertNotEqual(saved['commit'],repaired['commit']);self.assertEqual(registry.git(folder,'rev-list','--count','HEAD'),'2')
        with self.assertRaisesRegex(ValueError,'changed since'):registry.register(self.root/'catalog',{**self.request,'id':saved['definition']['id'],'expected_commit':saved['commit']})
