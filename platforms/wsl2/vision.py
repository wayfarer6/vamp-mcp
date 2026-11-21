import os
from pathlib import Path

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("YOLO_CONFIG_DIR", "/tmp/ultralytics")

EXPECTED = "vamp wsl gpu check"
MODELS = None


def verify_gpu():
    import paddle
    import torch
    from PIL import Image, ImageDraw, ImageFont
    from paddleocr import PaddleOCR
    from ultralytics import YOLO

    if not torch.cuda.is_available() or not paddle.device.is_compiled_with_cuda() or not paddle.device.cuda.device_count():
        raise RuntimeError("CUDA unavailable for one or both vision frameworks")
    fixture = Image.new("RGB", (960, 540), "white")
    draw = ImageDraw.Draw(fixture)
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 46)
    draw.text((80, 190), EXPECTED.upper(), fill="black", font=font)
    sample = Path("/tmp/vamp-vision-check.png")
    fixture.save(sample)
    global MODELS
    try:
        ocr = PaddleOCR(device="gpu:0", use_doc_orientation_classify=False,
                        use_doc_unwarping=False, use_textline_orientation=False,
                        text_detection_model_dir="/opt/vamp/models/PP-OCRv5_mobile_det",
                        text_recognition_model_dir="/opt/vamp/models/en_PP-OCRv5_mobile_rec")
        detector = YOLO("/opt/vamp/models/omniparser-icon.pt")
        MODELS = (ocr, detector)
        return inspect_screen(sample, EXPECTED)
    finally:
        sample.unlink(missing_ok=True)


def inspect_screen(sample, expected):
    if MODELS is None:
        raise RuntimeError("The GPU vision models have not been loaded")
    ocr, detector = MODELS
    results = list(ocr.predict(str(sample)))
    text = " ".join(value for result in results for value in result["rec_texts"]).casefold()
    if expected not in text:
        raise RuntimeError("GPU OCR did not read the expected task text")
    prediction, = detector.predict(str(sample), device="cuda:0", imgsz=1280, verbose=False)
    if next(detector.model.parameters()).device.type != "cuda":
        raise RuntimeError("YOLO did not use GPU")
    return {"status": "verified", "ocr": "gpu:0", "yolo": "cuda:0",
            "yolo_targets": len(prediction.boxes)}
