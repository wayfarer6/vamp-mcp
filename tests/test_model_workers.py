import importlib
from types import SimpleNamespace
import unittest
from unittest.mock import patch


class ModelCacheTests(unittest.TestCase):
    def test_auto_device_prioritizes_npu_then_gpu_then_cpu(self):
        from inference_device import choose_device
        from ocr_worker import choose_ocr_device
        for npu, gpu, yolo, ocr in (
            (True, True, 'npu:0', 'npu:0'),
            (False, True, '0', 'gpu:0'),
            (False, False, 'cpu', 'cpu'),
        ):
            with self.subTest(npu=npu, gpu=gpu):
                torch = SimpleNamespace(
                    npu=SimpleNamespace(is_available=lambda: npu),
                    cuda=SimpleNamespace(is_available=lambda: gpu),
                    backends=SimpleNamespace(),
                )
                paddle = SimpleNamespace(device=SimpleNamespace(
                    get_available_custom_device=lambda: ['npu:0'] if npu else [],
                    is_compiled_with_cuda=lambda: gpu,
                    cuda=SimpleNamespace(device_count=lambda: int(gpu)),
                ))
                with patch.dict('sys.modules', {'torch': torch, 'torch_npu': SimpleNamespace(), 'paddle': paddle}), \
                     patch('inference_device.openvino_device_available', return_value=False):
                    self.assertEqual(choose_device(), yolo)
                    self.assertEqual(choose_ocr_device(), ocr)
                    self.assertEqual(choose_device('cpu'), 'cpu')
                    self.assertEqual(choose_ocr_device('cpu'), 'cpu')

    def test_intel_npu_precedes_gpu_for_yolo(self):
        from inference_device import choose_device
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))
        with patch.dict('sys.modules', {'torch': torch, 'torch_npu': None}), \
             patch('inference_device.openvino_device_available', side_effect=lambda device: device=='NPU'):
            self.assertEqual(choose_device(), 'intel-npu')

    def test_intel_gpu_is_selected_before_cpu_with_torch_or_openvino(self):
        from inference_device import choose_device
        for torch_gpu in (True, False):
            with self.subTest(torch_gpu=torch_gpu):
                torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False),
                                        xpu=SimpleNamespace(is_available=lambda: torch_gpu),
                                        backends=SimpleNamespace())
                with patch.dict('sys.modules', {'torch': torch, 'torch_npu': None}), \
                     patch('inference_device.openvino_device_available', side_effect=lambda device: device=='GPU'):
                    self.assertEqual(choose_device(), 'xpu' if torch_gpu else 'intel-gpu')

    def test_preload_attempts_both_workers_independently(self):
        import model_daemon
        def start(kind, device):
            if kind == 'yolo':
                raise RuntimeError('Missing fixture YOLO environment')
            return {'kind': kind, 'running': True}
        with patch.object(model_daemon, 'start', side_effect=start) as launch:
            states = model_daemon.ensure_services(wait=False)
        self.assertEqual([call.args[0] for call in launch.call_args_list], ['yolo', 'ocr'])
        self.assertIn('Missing fixture YOLO', states['yolo']['warm_error'])
        self.assertTrue(states['ocr']['running'])

    def test_cuda_paddle_pipeline_is_preloaded_and_reused(self):
        import ocr_worker
        loaded = []
        class Pipeline:
            def __init__(self, **options):
                loaded.append(options['device'])
            def predict(self, image):
                return []
        gpu = SimpleNamespace(is_compiled_with_cuda=lambda: True,
                              cuda=SimpleNamespace(device_count=lambda: 2))
        with patch.dict('sys.modules', {
            'paddle': SimpleNamespace(device=gpu),
            'paddleocr': SimpleNamespace(PaddleOCR=Pipeline),
        }), patch.dict(ocr_worker._PIPELINES, {}, clear=True):
            device = ocr_worker.choose_ocr_device()
            self.assertEqual(device, 'gpu:0')
            ocr_worker.warmup(('en',), device=device)
            ocr_worker.recognize('unused.png', ['en'], device=device)
            self.assertEqual(loaded, ['gpu:0'])
            with self.assertRaisesRegex(RuntimeError, 'CUDA device is unavailable'):
                ocr_worker.choose_ocr_device('gpu:2')

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
