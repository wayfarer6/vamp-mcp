import importlib
from types import SimpleNamespace
import unittest
from unittest.mock import patch


class ModelCacheTests(unittest.TestCase):
    def test_ocr_pipelines_survive_calls_and_share_japanese_chinese_model(self):
        import ocr_worker
        counts={'loads':0,'predicts':0}
        class Poly:
            def tolist(self):return [[1,1],[20,1],[20,10],[1,10]]
        class Pipeline:
            def __init__(self,**kwargs):counts['loads']+=1
            def predict(self,image):
                counts['predicts']+=1
                return [{'rec_texts':['label'],'rec_scores':[.99],'rec_polys':[Poly()]}]
        with patch.dict('sys.modules',{'paddleocr':SimpleNamespace(PaddleOCR=Pipeline)}), \
             patch.dict(ocr_worker._PIPELINES,{},clear=True):
            for _ in range(2):
                lines=ocr_worker.recognize('unused.png',['ja','zh','en'])
                self.assertEqual(len(lines),3)
            self.assertEqual(counts['loads'],2)
            self.assertEqual(counts['predicts'],4)


class HyperVCodeTests(unittest.TestCase):
    def module(self):
        from pathlib import Path
        path=Path(__file__).resolve().parents[1]/'backends/hyperv/scripts/vmconnect.py'
        spec=importlib.util.spec_from_file_location('hyperv_code_test',path)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module

    def test_vm_name_is_data_not_interpolated_powershell_code(self):
        import base64,json,re
        module=self.module()
        name="VM'; Start-Process unexpected; '"
        args=module.build_command(name,'localhost',False,'result.json')
        self.assertNotIn('-ExecutionPolicy',args)
        script=base64.b64decode(args[-1]).decode('utf-16le')
        self.assertNotIn(name,script)
        payload=re.search(r"-RequestBase64 '([^']+)'$",script).group(1)
        self.assertEqual(json.loads(base64.b64decode(payload))['vm_name'],name)

    def test_non_windows_host_does_not_launch_anything(self):
        module=self.module()
        with patch.object(module.sys,'platform','linux'):
            with self.assertRaises(RuntimeError):module.open_console('test')
