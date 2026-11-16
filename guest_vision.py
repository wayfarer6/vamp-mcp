"""Transport-independent image matching, OCR, YOLO and packaged guest workflows."""
import json
from pathlib import Path
from PIL import Image
from robot.api.deco import keyword


class GuestVision:
    @keyword
    def find_guest_image(self, template):
        import pyautogui
        box = pyautogui.locate(Image.open(template), self._image(), grayscale=False)
        if box is None:
            raise AssertionError(f'Image not found: {template}')
        return [int(v) for v in box]

    @keyword
    def click_guest_image(self, template):
        x, y, w, h = self.find_guest_image(template)
        self.guest_click(x+w//2, y+h//2)

    @keyword
    def detect_guest_targets(self, model='models/omniparser-icon.pt', device='auto', confidence=0.35,
                             output='artifacts/detections.json', image_path=None):
        from model_daemon import request
        from tempfile import TemporaryDirectory
        target=Path(output).resolve();target.parent.mkdir(parents=True,exist_ok=True)
        def predict(path):
            return request('yolo',{'op':'predict','image':str(Path(path).resolve()),
                'model':str(Path(model).resolve()),'device':device,'confidence':float(confidence),
                'annotated':str(target.with_suffix('.jpg'))},pump=self._pump)
        if image_path:
            result=predict(image_path)
        else:
            with TemporaryDirectory(prefix='spice-yolo-') as directory:
                image=Path(directory)/'screen.png';self._image().save(image);result=predict(image)
        target.write_text(json.dumps({**result,'requested_device':device},indent=2))
        return result['targets']

    @keyword
    def click_detected_target(self, label, model='models/omniparser-icon.pt', device='auto', confidence=0.5):
        targets = [t for t in self.detect_guest_targets(model, device, confidence) if t['label'] == label]
        if len(targets) != 1:
            raise AssertionError(f'Expected one {label!r} target; found {len(targets)}. Inspect screenshot.')
        self.guest_click(*targets[0]['center'])

    @keyword
    def analyze_guest_ui(self, output='artifacts/ui.json', languages='ko,en,ja,zh', device='auto'):
        from vision import analyze
        return analyze(self, output, languages, device)

    @keyword
    def click_guest_text(self, text, languages='ko,en,ja,zh', device='auto'):
        result = self.analyze_guest_ui(languages=languages, device=device)
        targets = [e for e in result['elements'] if e['text'].strip().casefold() == text.strip().casefold()]
        if len(targets) != 1:
            raise AssertionError(f'Expected one exact text match for {text!r}, found {len(targets)}; inspect artifacts/ui.json')
        target = targets[0]
        if target['ocr_confidence'] < 0.7:
            raise AssertionError('OCR confidence below 0.7; inspect the screen before clicking')
        # Verify the target still looks the same after the inference delay.
        import pyautogui
        reference = Image.open(result['screenshot'])
        box = tuple(int(v) for v in target['xyxy'])
        crop = reference.crop(box)
        current = self._image()
        current_crop = current.crop(box)
        if pyautogui.locate(crop, current_crop, grayscale=False) is None:
            raise AssertionError('Target changed during inference; analyze the screen again')
        self.guest_click(*target['center'])
        return target

    @keyword
    def guest_screen_should_contain_text(self, expected, languages='en'):
        from vision import run_ocr
        path = self.capture_guest_screen('artifacts/verify.png')
        lines = run_ocr(self, path, languages, Path('artifacts/verify-ocr.json'))
        if not any(expected.casefold() in line['text'].casefold() and line['confidence'] >= 0.7 for line in lines):
            raise AssertionError(f'Expected visible text {expected!r}; inspect artifacts/verify.png')

    @keyword
    def prepare_naver_login(self, languages='en', device='auto'):
        from login_flow import prepare
        return prepare(self, languages, device)

    @keyword
    def submit_naver_login_from_environment(self, state):
        from login_flow import read_credentials, fill_and_submit
        username, password = read_credentials()
        try:
            return fill_and_submit(self, state, username, password)
        finally:
            username = password = None

    @keyword
    def update_sandbox_vm(self, config='config/sandbox-vm.json', output='artifacts/vm-update', timeout=300):
        from vm_update import run_update
        return run_update(self, config, output, timeout)

    @keyword
    def check_guest_verification(self, languages='ko,en,ja,zh'):
        from verification import check_guest_verification
        return check_guest_verification(self, languages)
