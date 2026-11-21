"""Install VAMP vision runtimes in separate environments selected for this host."""
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
from tempfile import NamedTemporaryFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from model_daemon import file_lock
from scripts.download_models import cache_directory, ensure_weights


def probe(command):
    if not shutil.which(command[0]):
        return ""
    try:
        result = subprocess.run(command, capture_output=True, text=True, errors="replace", timeout=10, check=True)
        return result.stdout or ""
    except (OSError, subprocess.SubprocessError):
        return ""


def available_profiles():
    system = platform.system()
    if system in ("Windows", "Linux") and platform.machine().lower() in ("amd64", "x86_64", "aarch64"):
        if system == "Linux" and probe(["npu-smi", "info"]):
            yield "ascend"
        display = (probe(["lspci", "-nn"]) if system == "Linux" else
                   probe(["powershell.exe", "-NoProfile", "-Command",
                          "(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue).FriendlyName"]))
        if re.search(r"Intel.*(?:AI Boost|neural processing|\bNPU\b)", display, re.I):
            yield "intel-npu"
        cuda = probe(["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"])
        if platform.machine().lower() in ("amd64", "x86_64") and any(
            re.match(r"\d+\.", line) and int(line.split(".")[0]) >= 570 for line in cuda.splitlines()
        ):
            yield "cuda"
        if system == "Windows" and sys.version_info[:2] == (3, 12) and sys.getwindowsversion().build >= 22000:
            gpus = probe(["powershell.exe", "-NoProfile", "-Command",
                          "(Get-CimInstance Win32_VideoController).Name"])
            if re.search(r"Radeon.*(?:RX\s+(?:9070(?:\s+XT)?|9060\s+XT|7900\s+XTX|7700)\b|R9700\b|W7900\b)",
                         gpus, re.I):
                yield "rocm-windows"
        if system == "Linux" and platform.machine().lower() in ("amd64", "x86_64") and (
            Path("/dev/kfd").exists() and re.search(r"\bgfx[0-9a-f]+\b", probe(["rocminfo"]))
        ):
            yield "rocm"
    yield "cpu"


def install(python, *args):
    command = [str(python), "-m", "pip", "--disable-pip-version-check",
               "install", "--timeout", "60", "--retries", "5", *args]
    try:
        subprocess.run(command, check=True)
    except subprocess.CalledProcessError:
        subprocess.run(command, check=True)


def prepare(root, name, args, check):
    executable = root / name / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not executable.is_file():
        subprocess.run([sys.executable, "-m", "venv", str(root / name)], check=True)
    marker = root / f"{name}-ready-v1"
    if not marker.is_file():
        args(executable)
    result = subprocess.run([str(executable), "-c", check])
    if result.returncode:
        marker.unlink(missing_ok=True)
        raise RuntimeError(f"{name} failed the {root.name} device check")
    marker.touch()
    return executable


def setup_yolo(python, selected):
    if selected == "ascend":
        install(python, "torch==2.7.1", "torchvision==0.22.1", "torch-npu==2.7.1")
    elif selected == "rocm-windows":
        url = "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/"
        install(python, *(url + name for name in (
            "rocm_sdk_core-7.2.1-py3-none-win_amd64.whl",
            "rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl",
            "rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl",
            "rocm-7.2.1.tar.gz",
        )))
        install(python, url + "torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
                url + "torchvision-0.24.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl")
    elif platform.system() == "Darwin":
        install(python, "torch==2.10.0", "torchvision==0.25.0")
    else:
        channel = {"cuda": "cu128", "rocm": "rocm7.1"}.get(selected, "cpu")
        install(python, "--index-url", f"https://download.pytorch.org/whl/{channel}",
                "torch==2.10.0", "torchvision==0.25.0")
    install(python, "ultralytics>=8.3,<9", "pillow")
    if selected == "intel-npu":
        install(python, "openvino>=2025.0,<2027", "onnx>=1.17,<2")


def setup_ocr(python, selected):
    if selected == "cuda":
        install(python, "--extra-index-url", "https://www.paddlepaddle.org.cn/packages/stable/cu126/",
                "paddlepaddle-gpu==3.2.2")
    else:
        install(python, "paddlepaddle==3.2.2")
    install(python, "paddleocr==3.3.2")


def main():
    if not (3, 11) <= sys.version_info[:2] <= (3, 13):
        raise SystemExit("Use Python 3.11, 3.12 or 3.13 for vision setup. Python 3.12 is recommended.")
    home = Path(os.environ.get("VAMP_HOME", Path.home() / ".vamp")).expanduser().resolve()
    home.mkdir(parents=True, exist_ok=True)
    with file_lock(home / "vision-setup.lock"):
        candidates = list(available_profiles())
        yolo_checks = {
            "cuda": "import torch; assert not torch.version.hip; torch.ones(1, device='cuda').cpu()",
            "rocm": "import torch; assert torch.version.hip; torch.ones(1, device='cuda').cpu()",
            "rocm-windows": "import torch; assert torch.version.hip; torch.ones(1, device='cuda').cpu()",
            "ascend": "import torch, torch_npu; assert torch.npu.is_available()",
            "intel-npu": "import openvino; assert any(d.startswith('NPU') for d in openvino.Core().available_devices)",
            "cpu": "import torch",
        }
        for selected in candidates:
            root = home / "vision" / selected
            root.mkdir(parents=True, exist_ok=True)
            print(f"Checking VAMP YOLO profile: {selected}", flush=True)
            try:
                yolo = prepare(root, "yolo", lambda p: setup_yolo(p, selected),
                               yolo_checks[selected] + "; import ultralytics")
                break
            except RuntimeError as error:
                if selected == "cpu":
                    raise
                print(f"VAMP YOLO {selected} did not initialize: {error}. Trying the next device.", file=sys.stderr)
        for ocr_device in (["cuda", "cpu"] if "cuda" in candidates else ["cpu"]):
            root = home / "vision" / ocr_device
            root.mkdir(parents=True, exist_ok=True)
            ocr_check = "import paddle, paddleocr"
            if ocr_device == "cuda":
                ocr_check += "; paddle.set_device('gpu:0'); assert paddle.ones([1]).place.is_gpu_place()"
            try:
                ocr = prepare(root, "ocr", lambda p: setup_ocr(p, ocr_device), ocr_check)
                break
            except RuntimeError as error:
                if ocr_device == "cpu":
                    raise
                print(f"VAMP OCR CUDA did not initialize: {error}. Trying CPU.", file=sys.stderr)
        if not os.environ.get("VAMP_YOLO_MODEL"):
            ensure_weights(cache_directory())
        subprocess.run([str(ocr), "-c",
                        "from paddlex.inference.utils.official_models import official_models; "
                        "print(*(official_models[name] for name in "
                        "('PP-OCRv5_mobile_det','en_PP-OCRv5_mobile_rec',"
                        "'korean_PP-OCRv5_mobile_rec','PP-OCRv5_mobile_rec')))"], check=True)
        payload = {"profile": selected, "ocr_profile": ocr_device,
                   "yolo": str(yolo.relative_to(home)), "ocr": str(ocr.relative_to(home))}
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=home, delete=False) as output:
            json.dump(payload, output)
        Path(output.name).replace(home / "vision-environment.json")
        print(json.dumps(payload))


if __name__ == "__main__":
    main()
