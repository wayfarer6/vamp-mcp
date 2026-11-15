"""Fuse UI icon boxes with multilingual text. Coordinates always refer to guest pixels."""
import json
import time
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent


def overlap(a, b):
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    intersection = max(0, x2-x1) * max(0, y2-y1)
    return intersection / max(1, min((a[2]-a[0])*(a[3]-a[1]), (b[2]-b[0])*(b[3]-b[1])))


def text_rank(line):
    text, lang = line['text'], line['language']
    native = (lang == 'ko' and any('\uac00' <= c <= '\ud7a3' for c in text)) or (
        lang == 'ja' and any('\u3040' <= c <= '\u30ff' for c in text))
    return line['confidence'] + (0.15 if native else 0.05 if lang == 'en' else 0)


def fuse(detections, lines):
    # Each region keeps alternative language readings for inspection.
    groups = []
    for line in sorted(lines, key=text_rank, reverse=True):
        group = next((g for g in groups if overlap(g[0]['xyxy'], line['xyxy']) > 0.65), None)
        if group is None:
            groups.append([line])
        else:
            group.append(line)
    elements = [dict(t, kind='ui_region', text='', ocr_confidence=None, readings=[]) for t in detections]
    groups.sort(key=lambda g: (g[0]['xyxy'][1], g[0]['xyxy'][0]))
    for group in groups:
        best = group[0]
        box = best['xyxy']
        cx, cy = (box[0]+box[2])/2, (box[1]+box[3])/2
        containers = [e for e in elements if e['kind'] == 'ui_region'
                      and e['xyxy'][0]-3 <= cx <= e['xyxy'][2]+3
                      and e['xyxy'][1]-3 <= cy <= e['xyxy'][3]+3
                      and overlap(e['xyxy'], box) > 0.6]
        if containers:
            element = min(containers, key=lambda e: (e['xyxy'][2]-e['xyxy'][0])*(e['xyxy'][3]-e['xyxy'][1]))
            element['text'] = (element['text']+' '+best['text']).strip()
            element['ocr_confidence'] = min(element['ocr_confidence'] or 1, best['confidence'])
            element['readings'].extend(group)
        else:
            elements.append({'kind':'text', 'text':best['text'], 'xyxy':box,
                             'center':[cx,cy], 'confidence':None,
                             'ocr_confidence':best['confidence'], 'readings':group})
    elements.sort(key=lambda e: (e['xyxy'][1], e['xyxy'][0]))
    for index, element in enumerate(elements):
        element['id'] = index
    return elements


def analyze(robot, output='artifacts/ui.json', languages='ko,en,ja,zh', device='auto'):
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    screenshot = output.with_suffix('.png')
    captured_at = time.time()
    robot.capture_guest_screen(screenshot)
    # Inference uses exactly the saved frame that OCR reads.
    detections = robot.detect_guest_targets(model=str(ROOT/'models/omniparser-icon.pt'),
        device=device, confidence=0.15, output=str(output.with_suffix('.yolo.json')),
        image_path=str(screenshot))
    ocr_output = output.with_suffix('.ocr.json')
    lines = run_ocr(robot, screenshot, languages, ocr_output)
    elements = fuse(detections, lines)
    image = Image.open(screenshot).convert('RGB')
    draw = ImageDraw.Draw(image)
    for element in elements:
        box = element['xyxy']
        color = 'red' if element['kind']=='ui_region' else 'blue'
        draw.rectangle(box, outline=color, width=2)
        draw.text((box[0], max(0,box[1]-12)), str(element['id']), fill='white', stroke_width=2, stroke_fill='black')
    annotated = output.with_suffix('.annotated.png')
    image.save(annotated)
    result = {'captured_at':captured_at, 'screenshot':str(screenshot),
              'annotated':str(annotated), 'width':image.width, 'height':image.height,
              'elements':elements}
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def run_ocr(robot, screenshot, languages, output):
    from model_daemon import request
    output=Path(output).resolve();output.parent.mkdir(parents=True,exist_ok=True)
    result=request('ocr',{'op':'predict','image':str(Path(screenshot).resolve()),
                         'languages':languages.split(',')},pump=robot._pump)
    output.write_text(json.dumps(result['lines'],ensure_ascii=False,indent=2))
    output.with_suffix('.log').write_text(json.dumps({key:value for key,value in result.items() if key!='lines'},indent=2))
    return result['lines']
