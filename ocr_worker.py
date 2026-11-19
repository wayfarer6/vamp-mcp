"""PaddleOCR worker for the isolated Python 3.12 environment."""
import argparse
import json
import os
from pathlib import Path
import re

os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK', 'True')
os.environ.setdefault('OMP_NUM_THREADS', '1')


MODELS = {'ko':'korean_PP-OCRv5_mobile_rec','ja':'PP-OCRv5_mobile_rec',
          'en':'en_PP-OCRv5_mobile_rec','zh':'PP-OCRv5_mobile_rec'}
_PIPELINES = {}


def choose_ocr_device(requested='auto'):
    import paddle
    requested = str(requested).lower()
    if requested == 'cpu':
        return 'cpu'
    custom_devices = getattr(paddle.device, 'get_available_custom_device', lambda: [])() or []
    npus = sorted(int(value.split(':')[1]) for value in custom_devices if re.fullmatch(r'npu:\d+', value))
    if requested == 'auto':
        if npus:
            return f'npu:{npus[0]}'
        available = paddle.device.cuda.device_count() if paddle.device.is_compiled_with_cuda() else 0
        return 'gpu:0' if available else 'cpu'
    if requested in ('npu', 'ascend', 'ascend-npu'):
        requested = 'npu:0'
    if re.fullmatch(r'npu:\d+', requested):
        if int(requested.split(':')[1]) not in npus:
            raise RuntimeError('Requested PaddleOCR NPU is unavailable; install a compatible PaddlePaddle NPU backend')
        return requested
    if requested in ('cuda', 'gpu', 'nvidia'):
        requested = 'gpu:0'
    if not re.fullmatch(r'gpu:\d+', requested):
        raise ValueError('PaddleOCR device must be auto, cpu, gpu[:index] or npu[:index]')
    available = paddle.device.cuda.device_count() if paddle.device.is_compiled_with_cuda() else 0
    if int(requested.split(':')[1]) >= available:
        raise RuntimeError('Requested PaddleOCR CUDA device is unavailable; install a compatible PaddlePaddle GPU build')
    return requested


def get_pipeline(language, device):
    from paddleocr import PaddleOCR
    name=MODELS[language]
    key = name, device
    if key not in _PIPELINES:
        _PIPELINES[key]=PaddleOCR(device=device,text_recognition_model_name=name,
            use_doc_orientation_classify=False,use_doc_unwarping=False,
            use_textline_orientation=False,text_detection_model_name='PP-OCRv5_mobile_det',
            enable_mkldnn=False,cpu_threads=4)
    return _PIPELINES[key]


def warmup(languages=('ko','en','ja','zh'), *, device='cpu'):
    for language in languages:get_pipeline(language,device)
    return list(_PIPELINES)


def recognize(image,languages,*,device='cpu'):
    lines=[];predictions={}
    for language in languages:
        name=MODELS[language]
        if name not in predictions:
            predictions[name]=[]
            for result in get_pipeline(language,device).predict(image):
                for text,score,poly in zip(result['rec_texts'],result['rec_scores'],result['rec_polys']):
                    if float(score)<.45:continue
                    coords=poly.tolist();xs=[p[0] for p in coords];ys=[p[1] for p in coords]
                    predictions[name].append({'text':text,'confidence':float(score),
                                              'xyxy':[min(xs),min(ys),max(xs),max(ys)]})
        lines.extend({**line,'language':language} for line in predictions[name])
    return lines


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('image')
    parser.add_argument('--languages', default='ko,en,ja,zh')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    from model_daemon import request
    lines = request('ocr',{'op':'predict','image':str(Path(args.image).resolve()),
                          'languages':args.languages.split(',')})['lines']
    Path(args.output).write_text(json.dumps(lines, ensure_ascii=False, indent=2))
