import contextlib
import json
import os
import sys

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("YOLO_CONFIG_DIR", "/tmp/ultralytics")


def load_ocr():
    import paddle
    from paddleocr import PaddleOCR

    if not paddle.device.is_compiled_with_cuda() or not paddle.device.cuda.device_count():
        raise RuntimeError("PaddleOCR CUDA is unavailable")
    model = PaddleOCR(device="gpu:0", use_doc_orientation_classify=False,
                      use_doc_unwarping=False, use_textline_orientation=False,
                      text_detection_model_name="PP-OCRv5_mobile_det",
                      text_recognition_model_name="en_PP-OCRv5_mobile_rec",
                      text_detection_model_dir="/opt/vamp/models/PP-OCRv5_mobile_det",
                      text_recognition_model_dir="/opt/vamp/models/en_PP-OCRv5_mobile_rec")

    def predict(image):
        results = list(model.predict(image))
        return {"device": "gpu:0", "text": " ".join(value for result in results for value in result["rec_texts"])}

    return predict


def load_yolo():
    import torch
    from ultralytics import YOLO

    if not torch.cuda.is_available() or torch.version.hip:
        raise RuntimeError("YOLO NVIDIA CUDA is unavailable")
    model = YOLO("/opt/vamp/models/omniparser-icon.pt")
    model.to("cuda:0")

    def predict(image):
        result, = model.predict(image, device="cuda:0", imgsz=1280, verbose=False)
        device = torch.device(model.predictor.model.device)
        return {"device": f"cuda:{device.index or 0}" if device.type == "cuda" else str(device),
                "targets": len(result.boxes)}

    return predict


def main(kind):
    with contextlib.redirect_stdout(sys.stderr):
        predict = {"ocr": load_ocr, "yolo": load_yolo}[kind]()
    for line in sys.stdin:
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = predict(json.loads(line)["image"])
        except Exception:
            import traceback
            traceback.print_exc(file=sys.stderr)
            result = {"error": f"{kind} GPU inference failed"}
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
