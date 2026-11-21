"""Verify a reviewed target on a fresh guest frame before each recorded button press."""
import asyncio
import math
from pathlib import Path
from tempfile import TemporaryDirectory
import unicodedata

MIN_CONFIDENCE = 0.90
MAX_OFFSET = 24  # Allow a click on the padding beside the text of a button.
GENERIC_CLASSES = {'button', 'icon', 'object', 'widget', 'control', 'text', 'element'}


class ClickBlocked(ValueError):
    def __init__(self, reason, score=None):
        self.reason = reason
        self.score = score
        self.completed = 0
        self.presses = 0
        self.attempts = 0
        super().__init__(f'Recorded click stopped: {reason} before button press.')


def normalized(value):
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())


def target_spec(action):
    target = action.get('target')
    if not isinstance(target, dict) or len(target) != 1:
        raise ClickBlocked('target_not_reviewed')
    method, value = next(iter(target.items()))
    if method not in ('ocr', 'yolo') or not isinstance(value, str) or not 1 <= len(value.strip()) <= 120:
        raise ClickBlocked('invalid_target')
    if method == 'yolo' and normalized(value) in GENERIC_CLASSES:
        raise ClickBlocked('specific_detector_class_required')
    return method, value.strip()


def detect(frame, method, value):
    from model_daemon import request
    params = {'op': 'predict', 'image': str(frame)}
    if method == 'ocr':
        from backends.library.replay import start_screen_language
        params['languages'] = [start_screen_language(value)]
        return request('ocr', params, timeout=90)['lines']
    params.update(required_class=value, confidence=0.35)
    result = request('yolo', params, timeout=90)
    if result.get('verified_class') != value:
        raise ClickBlocked('specific_detector_class_required')
    return result['targets']


def select(rows, method, value, action, size, threshold):
    field = 'text' if method == 'ocr' else 'label'
    matches = [r for r in rows if normalized(r[field]) == normalized(value)]
    if not matches:
        raise ClickBlocked('target_not_found')
    if len(matches) != 1:
        raise ClickBlocked('ambiguous_target')
    row = matches[0]
    score = row['confidence']
    if type(score) not in (float, int) or not math.isfinite(score) or not 0 <= score <= 1:
        raise ClickBlocked('invalid_detector_result')
    if score < threshold:
        raise ClickBlocked('low_confidence', score)
    box = row['xyxy']
    if len(box) != 4 or not all(type(v) in (int, float) and math.isfinite(v) for v in box):
        raise ClickBlocked('invalid_detector_result')
    l, t, r, b = box
    if not (0 <= l < r <= size[0] and 0 <= t < b <= size[1]):
        raise ClickBlocked('invalid_detector_result')
    x, y = action['x'], action['y']
    if l <= x < r and t <= y < b:
        point = (x, y)
    else:
        cx, cy = int((l+r)/2), int((t+b)/2)
        if math.hypot(cx-x, cy-y) > MAX_OFFSET:
            raise ClickBlocked('target_moved', score)
        point = (cx, cy)
    crop = (max(0, math.floor(min(l,x))-8), max(0, math.floor(min(t,y))-8),
            min(size[0], math.ceil(max(r,x+1))+8), min(size[1], math.ceil(max(b,y+1))+8))
    return point, crop, score


async def verify_click(action, size, capture, geometry, position, threshold=MIN_CONFIDENCE):
    method, value = target_spec(action)
    try:
        from PIL import Image, ImageChops
    except ImportError as cause:
        raise ClickBlocked('image_runtime_unavailable') from cause
    with TemporaryDirectory(prefix='vamp-click-') as folder:
        frame = Path(folder) / 'frame.png'
        current = Path(folder) / 'current.png'
        for attempt in (1, 2):
            try:
                if list(geometry()) != list(size):
                    raise ClickBlocked('geometry_changed')
                await capture(frame, size)
                with Image.open(frame) as first:
                    if first.size != tuple(size):
                        raise ClickBlocked('geometry_changed')
                    rows = detect(frame, method, value)
                    point, crop, score = select(rows, method, value, action, size, threshold)
                    reference = first.crop(crop).convert('RGB')
                await position(*point)
                await capture(current, size)
                with Image.open(current) as latest:
                    if latest.size != tuple(size) or list(geometry()) != list(size):
                        raise ClickBlocked('geometry_changed')
                    if ImageChops.difference(reference, latest.crop(crop).convert('RGB')).getbbox():
                        raise ClickBlocked('target_changed', score)
                return point, {'method': method, 'score': score, 'required_score': threshold,
                               'attempts': attempt}
            except ClickBlocked as error:
                error.attempts = attempt
                if attempt == 2 or error.reason not in ('target_not_found', 'target_changed', 'low_confidence'):
                    raise
                await asyncio.sleep(.25)
            except Exception as cause:
                error = ClickBlocked('detector_or_capture_unavailable')
                error.attempts = attempt
                raise error from cause
