# SPICE 설치

이 문서는 SPICE 화면 제어와 YOLO·OCR을 호스트에 설치하는 방법입니다. VS Code 확장이나 VirtualBox MCP만 쓰려면 [확장 안내](../vscode-extension/README.md)와 [VirtualBox 설치](../backends/virtualbox/README.md)를 참고하세요.

실제로 시험한 호스트는 Ubuntu 26.04.1 LTS와 NVIDIA GeForce RTX 3050 Laptop GPU입니다. AMD·Apple·NPU용 설정도 있지만 해당 장비에서는 설치와 전체 RPA를 검증하지 않았습니다.

## 호스트와 게스트 준비

requirements는 VM을 제어하는 호스트에 설치합니다. SPICE 입력에는 게스트 RPA 에이전트가 필요하지 않습니다. GUI 동작을 기록하려면 [레코더](GUEST_RECORDER.md)를 게스트에 별도로 설치할 수 있습니다.

Windows 11 설치 ISO와 유효한 라이선스는 사용자가 직접 준비해야 합니다. VAMP에는 Windows ISO·제품 키·라이선스가 없으며 정품 인증은 사용자가 진행합니다. 공개 테스트 계정과 Windows 라이선스는 별개입니다. [VM 초기 설정](GUEST_AUTOMATION.md)

Debian과 Windows 예시는 1920×1080을 기준으로 합니다. OS·배율·화면 배치가 다르면 좌표를 다시 확인해야 합니다. GNOME 실행창·`su root`·`apt update` 예시는 Debian용이며 Windows 녹화 작업의 검증 결과는 [워크플로 예시](WORKFLOWS.md)에 있습니다.

## 1. 수동 설치 — Ubuntu 호스트

저장소 루트에서 실행하세요. 다음 OS 패키지는 호스트 설치용이며 게스트 apt 업데이트 RPA와 다릅니다.

```bash
sudo apt update
sudo apt install python3-venv python3-gi python3-pil gir1.2-spiceclientglib-2.0

# OS에서 제공하는 GI와 같은 Python을 사용
/usr/bin/python3 -m venv --system-site-packages .venv
.venv/bin/python -m pip install --upgrade pip

# 하드웨어 프로필 하나만 선택. 검증 환경은 NVIDIA
.venv/bin/python -m pip install -r requirements-nvidia.txt

# PaddleOCR는 별도 Python 3.12 venv에서 CPU로 실행
.venv/bin/python -m pip install uv
.venv/bin/uv venv --python 3.12 .venv-ocr
.venv/bin/uv pip install --python .venv-ocr/bin/python -r requirements-ocr.txt

# YOLO 아이콘 탐지 모델과 라이선스 다운로드·체크섬 확인
.venv/bin/python scripts/download_models.py
```

SPICE GI 바인딩은 pip만으로 설치되지 않습니다. `--system-site-packages`는 **같은 Python 버전**의 OS GI를 사용하기 위한 옵션입니다. 예를 들어 OS Python 3.14용 GI를 uv Python 3.12에서 바로 공유할 수는 없습니다. 다른 가속기 wheel이 현재 Python을 지원하지 않으면 해당 wheel과 GI가 함께 지원되는 OS/Python을 선택하거나 그 Python용 GI를 별도 설치해야 합니다. ROCm·TorchNPU는 공급사의 OS·Python·GPU 지원표에 맞춰야 합니다.

`requirements.lock.txt`는 검증 호스트의 Python 3.14/CUDA 환경 기록입니다. 다른 하드웨어에 이 lock을 그대로 설치하지 마세요. 프로필 설치 파일과 lock 재현은 별개의 경로입니다.

## 2. 하드웨어별 requirements

각 파일은 공통 Robot Framework·PyAutoGUI·Pillow·requests와 YOLO를 포함합니다. PaddleOCR의 `requirements-ocr.txt`는 어느 프로필에서도 별도 설치합니다. 모든 프로필을 한 환경에 동시에 설치하지 마세요.

| 호스트 가속기 | 설치 파일 | YOLO 장치 지정 | 프로젝트 검증 |
| --- | --- | --- | --- |
| NVIDIA CUDA | `requirements-nvidia.txt` | `auto`, `0`, `nvidia` | Ubuntu + NVIDIA에서 실행 확인 |
| CPU 전용 | `requirements-cpu.txt` | `cpu` | 기존 Ubuntu 호스트에서 CPU 추론 확인; 이 설치 프로필의 신규 설치는 미검증 |
| AMD GPU / ROCm 7.1 | `requirements-amd-rocm.txt` | `rocm` 또는 `auto` | 미검증 |
| Apple Silicon / MPS | `requirements-apple.txt` | `mps` 또는 `auto` | 미검증 |
| Huawei Ascend NPU | `requirements-npu-ascend.txt` | `ascend-npu`, `npu:0` | 미검증 |
| Intel NPU / OpenVINO | `requirements-npu-intel.txt` | `intel-npu` | 미검증 |

CPU 전용 파일의 `+cpu` wheel은 Linux/Windows 계열용이며, macOS에서 CPU를 쓸 때도 Apple 프로필을 설치한 뒤 `DEVICE:cpu`를 지정하세요.

NPU는 공통 런타임이 아닙니다. Ascend와 Intel 프로필은 서로 호환되지 않으며, Qualcomm·AMD Ryzen AI·Apple Neural Engine 등의 모든 NPU를 지원한다는 뜻은 아닙니다. Apple 프로필은 **Metal GPU(MPS)** 경로입니다. 가속기는 YOLO에 적용하며 PaddleOCR는 CPU를 사용합니다.

### AMD

호환 AMD GPU, Linux 드라이버와 ROCm 런타임을 준비한 뒤 NVIDIA 대신 다음 파일을 설치합니다. 예시 wheel은 PyTorch 2.10/ROCm 7.1 조합입니다.

```bash
.venv/bin/python -m pip install -r requirements-amd-rocm.txt
.venv/bin/python scripts/run_rpa.py desktop_control --var ACTION:analyze --var DEVICE:rocm
```

ROCm도 PyTorch의 `torch.cuda` 인터페이스를 사용합니다. `DEVICE:rocm`은 ROCm build와 AMD 장치가 확인되어야 실행되며 NVIDIA Torch를 AMD 지원으로 오인하지 않습니다. [PyTorch 설치 조합](https://pytorch.org/get-started/previous-versions/)

### Apple Silicon

macOS에서 사용할 SPICE/GI 시스템 라이브러리를 먼저 설치합니다.

```bash
brew install spice-gtk pygobject3
# Homebrew GI가 연결된 Python으로 생성해야 함
python3 -m venv --system-site-packages .venv
.venv/bin/python -m pip install -r requirements-apple.txt
```

위의 Python 3.12 OCR 환경·모델 설치도 별도로 수행하세요. macOS가 요구하는 접근성/화면 접근 권한과 호환 SPICE GI를 준비해야 합니다. Mac에서 Linux KVM을 그대로 실행한다는 뜻은 아니며, VM을 제공하는 호스트의 접근 가능한 SPICE 주소를 지정합니다. brew의 Python과 선택한 Torch/Paddle wheel의 Python·아키텍처가 맞는지 확인해야 합니다. Windows/Linux 네이티브 SPICE 컨트롤러와 macOS 컨트롤러는 별개의 설치 환경입니다.

```bash
.venv/bin/python scripts/run_rpa.py desktop_control --var ACTION:analyze --var DEVICE:mps --var SPICE_URI:spice://VM_HOST:5900
```

`VM_HOST`는 실제 VM 호스트 주소로 바꾸세요. [Homebrew SPICE](https://formulae.brew.sh/formula/spice-gtk), [PyTorch MPS](https://docs.pytorch.org/docs/stable/notes/mps.html)

### Ascend NPU

프로필의 PyTorch 2.7.1/TorchNPU 2.7.1과 맞는 Ascend 드라이버·CANN을 공급사 절차로 설치한 뒤 실행합니다. wheel이 제공되는 Linux/Python/아키텍처가 필요합니다. 다른 CANN 조합을 쓰면 관련 버전을 함께 맞춰야 합니다.

```bash
.venv/bin/python -m pip install -r requirements-npu-ascend.txt
source /usr/local/Ascend/ascend-toolkit/set_env.sh
.venv/bin/python scripts/run_rpa.py desktop_control --var ACTION:analyze --var DEVICE:ascend-npu
```

[Ultralytics Ascend](https://docs.ultralytics.com/integrations/ascend/), [Ascend PyTorch 설치](https://github.com/Ascend/pytorch)

### Intel NPU

Intel NPU 드라이버를 준비한 뒤 다음 파일을 설치합니다.

```bash
.venv/bin/python -m pip install -r requirements-npu-intel.txt
.venv/bin/python scripts/run_rpa.py desktop_control --var ACTION:analyze --var DEVICE:intel-npu
```

Intel NPU 경로는 명시적으로 선택해야 합니다. 첫 사용 때 YOLO 모델을 고정 크기·batch 1의 OpenVINO 형식으로 변환하며 추가 시간이 들 수 있습니다. `openvino.Core().available_devices`에 NPU가 없으면 중단합니다. 생성 모델은 Git에서 제외합니다. OmniParser 탐지 모델의 변환·연산 호환성도 이 장비에서 검증하지 않았으므로, 프로필 제공을 전체 모델 성공 보장으로 해석하지 마세요. [Ultralytics OpenVINO](https://docs.ultralytics.com/integrations/openvino/)

## 3. AI 에이전트에게 설치 맡기기

이 호스트에서는 `$spice-rpa-install` 스킬을 사용할 수 있습니다. 다른 호스트에서는 저장소의 `.agents/skills/spice-rpa-install/`을 에이전트 스킬 경로에 연결하거나 이 문서를 읽게 하세요.

예시 요청:

> 이 저장소의 README와 docs/INSTALL.md, spice-rpa-install 스킬을 읽고 내 호스트에 맞는 requirements 프로필 하나로 venv와 OCR venv를 설치해줘. 실제 검증된 환경은 Ubuntu + NVIDIA이고 다른 환경은 미검증이라는 점을 유지해. 게스트 VM에는 패키지를 설치하지 말고, 로그인·apt update 같은 RPA는 실행하지 마.

에이전트 절차:

1. 호스트 OS·아키텍처·Python과 이미 설치된 GPU/NPU 드라이버·GI를 확인합니다. 게스트 OS를 보고 호스트 프로필을 고르지 않습니다.
2. 기존 `.venv`와 작업 중인 환경이 있으면 재사용 가능 여부를 먼저 확인합니다. 여러 Torch 프로필을 덮어 설치하지 않습니다.
3. 프로필 하나를 선택하고 위 pip/uv 명령으로 호스트 venv를 준비합니다. 드라이버·CANN·ROCm 설치가 필요하면 해당 호스트에 맞는 별도 작업으로 다룹니다.
4. 모델을 내려받고 manifest 체크섬을 확인합니다. 개인 자격 증명을 읽지 않습니다.
5. 패키지 import·설정·dry-run 정도로 설치 상태를 보고합니다. 사용자가 요청하지 않은 VM 입력이나 인증 제출을 실행하지 않습니다. 이 프로젝트가 AMD·Apple·NPU에서 검증됐다고 표현하지 않습니다.

사용자가 별도 플랫폼 테스트를 요청하지 않았다면 장비별 추론/전체 RPA 테스트는 수행하지 않습니다. 설치 성공, import 확인, 모델 실행 성공과 실제 RPA 성공을 구분해서 보고하세요.

## 4. 설치 후 선택적으로 확인

```bash
.venv/bin/python -m pip check
.venv/bin/python scripts/validate_rpas.py
.venv/bin/python scripts/run_rpa.py naver_login --dryrun
```

위 설정·dry-run 검사는 실제 VM 로그인이나 apt update를 실행하지 않습니다. 실제 실행 명령은 [RPA 패키지 README](../rpas/README.md)에 있습니다.
