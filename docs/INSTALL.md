# 설치: 수동 실행과 AI 에이전트

이 프로젝트는 사용자가 요구사항을 제시하고 AI 에이전트(Codex)와 바이브 코딩으로 개발한 프로젝트입니다. **실제 실행·검증 환경은 Ubuntu 26.04.1 LTS + NVIDIA GeForce RTX 3050 Laptop GPU입니다.** AMD·Apple·NPU 설치 구성은 실행 경로를 제공하지만, 별도 장비에서 설치·추론·전체 RPA를 검증하지 않았습니다.

## 호스트와 게스트를 구분하세요

requirements는 SPICE를 제어하는 **호스트**에 설치합니다. 게스트인 Debian VM과 Windows 11 VM에는 Python RPA를 설치하지 않습니다. 두 VM은 1920×1080 기준이며, OS별 실행 절차와 좌표 검증은 별개입니다. 현재 GNOME 실행창·`su root`·`apt update` 예시는 Debian용입니다. Windows용 기록 변환 패키지 `windows_naver_recorded`는 Win+R 재생·로그인 화면 도달을 확인했습니다. 추가 Windows 작업과 Hyper-V 호스트는 별도 구현·검증이 필요합니다.

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

## MCP / 상주 모델 / Hyper-V 추가 경로

MCP 클라이언트에 연결할 때는 `requirements-mcp.txt`를 추가하고 [MCP 안내](VM_MCP.md)를 따릅니다. 정상 RPA 경로는 모델을 [독립 백그라운드 프로세스](MODEL_BACKGROUND.md)로 재사용합니다. systemd를 설치하지 않습니다.

Windows Hyper-V 호스트용 VMConnect 코드만 사용할 때는 [Hyper-V 전용 설치](../backends/hyperv/README.md)를 따르세요. 해당 경로는 `.venv-hyperv`/별도 requirements이며 Linux GI/SPICE 컨트롤러를 Windows에 설치하는 절차와 다릅니다. RDP 입력·영상 백엔드는 아직 구현되지 않았습니다.
