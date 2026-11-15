"""PaddleOCR worker for the isolated Python 3.12 environment."""
import argparse
import json
import os
from pathlib import Path

os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK', 'True')
os.environ.setdefault('OMP_NUM_THREADS', '1')


def recognize(image, languages):
    from paddleocr import PaddleOCR
    lines = []
    models = {'ko': 'korean_PP-OCRv5_mobile_rec', 'ja': 'PP-OCRv5_mobile_rec',
              'en': 'en_PP-OCRv5_mobile_rec', 'zh': 'PP-OCRv5_mobile_rec'}
    for language in languages:
        pipeline = PaddleOCR(
            device='cpu', text_recognition_model_name=models[language],
            use_doc_orientation_classify=False, use_doc_unwarping=False,
            use_textline_orientation=False, text_detection_model_name='PP-OCRv5_mobile_det',
            enable_mkldnn=False, cpu_threads=4,
        )
        for result in pipeline.predict(image):
            for text, score, poly in zip(result['rec_texts'], result['rec_scores'], result['rec_polys']):
                if float(score) < 0.45:
                    continue
                coords = poly.tolist()
                xs, ys = [p[0] for p in coords], [p[1] for p in coords]
                lines.append({'text': text, 'confidence': float(score), 'language': language,
                              'xyxy': [min(xs), min(ys), max(xs), max(ys)]})
        del pipeline
    return lines


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('image')
    parser.add_argument('--languages', default='ko,en,ja,zh')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    lines = recognize(args.image, args.languages.split(','))
    Path(args.output).write_text(json.dumps(lines, ensure_ascii=False, indent=2))
