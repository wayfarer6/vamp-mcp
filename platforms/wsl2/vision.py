import atexit
import json
from pathlib import Path
import select
import subprocess
import threading

from PIL import Image, ImageDraw, ImageFont

EXPECTED = "vamp wsl gpu check"
ROOT = Path(__file__).resolve().parent
WORKERS = {}


class VisionProcess:
    def __init__(self, python, kind):
        self.lock = threading.Lock()
        self.process = subprocess.Popen(
            [python, "-u", str(ROOT / "vision_process.py"), kind],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8",
        )
        atexit.register(self.close)

    def query(self, sample):
        with self.lock:
            if self.process.poll() is not None:
                raise RuntimeError("Remote GPU vision worker stopped")
            self.process.stdin.write(json.dumps({"image": str(sample)}) + "\n")
            self.process.stdin.flush()
            if not select.select([self.process.stdout], [], [], 45)[0]:
                self.process.kill()
                raise RuntimeError("Remote GPU vision inference timed out")
            reply = self.process.stdout.readline()
        if not reply:
            raise RuntimeError("Remote GPU vision worker stopped")
        result = json.loads(reply)
        if "error" in result:
            raise RuntimeError(result["error"])
        return result

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()


def verify_gpu():
    WORKERS["ocr"] = VisionProcess("/opt/ocr/bin/python", "ocr")
    WORKERS["yolo"] = VisionProcess("/opt/venv/bin/python", "yolo")
    fixture = Image.new("RGB", (960, 540), "white")
    draw = ImageDraw.Draw(fixture)
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 46)
    draw.text((80, 190), EXPECTED.upper(), fill="black", font=font)
    sample = Path("/tmp/vamp-vision-check.png")
    try:
        fixture.save(sample)
        return inspect_screen(sample, EXPECTED)
    finally:
        sample.unlink(missing_ok=True)


def inspect_screen(sample, expected):
    ocr = WORKERS["ocr"].query(sample)
    if ocr["device"] != "gpu:0" or expected not in ocr["text"].casefold():
        raise RuntimeError("Remote GPU OCR did not read the expected task text")
    yolo = WORKERS["yolo"].query(sample)
    if yolo["device"] != "cuda:0":
        raise RuntimeError("Remote YOLO did not use NVIDIA CUDA")
    return {"status": "verified", "ocr": ocr["device"], "yolo": yolo["device"],
            "yolo_targets": yolo["targets"]}
