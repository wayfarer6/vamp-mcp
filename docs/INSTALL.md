# SPICE 설치

이 문서는 SPICE 화면 제어와 YOLO·OCR을 호스트에 설치하는 방법입니다. VS Code 확장이나 VirtualBox MCP만 쓰려면 [확장 안내](../vscode-extension/README.md)와 [VirtualBox 설치](../backends/virtualbox/README.md)를 참고하세요.

실제로 시험한 호스트는 Ubuntu 26.04.1 LTS와 NVIDIA GeForce RTX 3050 Laptop GPU입니다. AMD·Apple·NPU용 설정도 있지만 해당 장비에서는 설치와 전체 RPA를 검증하지 않았습니다.

## 호스트와 게스트 준비

requirements는 VM을 제어하는 호스트에 설치합니다. SPICE 입력에는 게스트 RPA 에이전트가 필요하지 않습니다. GUI 동작을 기록하려면 [레코더](GUEST_RECORDER.md)를 게스트에 별도로 설치할 수 있습니다.

Windows 11 설치 ISO와 유효한 라이선스는 사용자가 직접 준비해야 합니다. VAMP에는 Windows ISO·제품 키·라이선스가 없으며 정품 인증은 사용자가 진행합니다. 공개 테스트 계정과 Windows 라이선스는 별개입니다. [VM 초기 설정](GUEST_AUTOMATION.md)

Debian과 Windows 예시는 1920×1080을 기준으로 합니다. OS·배율·화면 배치가 다르면 좌표를 다시 확인해야 합니다. GNOME 실행창·`su root`·`apt update` 예시는 Debian용이며 Windows 녹화 작업의 검증 결과는 [워크플로 예시](WORKFLOWS.md)에 있습니다.

<a id="windows-powershell-host"></a>
## Windows 호스트: PowerShell 실행 정책과 Hyper-V

이 절차는 **Windows 호스트의 Windows PowerShell 5.1 (`powershell.exe`)** 용입니다. 게스트 VM이나 PowerShell 7 (`pwsh.exe`) 설정과 혼동하지 마세요. VAMP가 호출하는 것과 같은 호스트 계정으로 Windows PowerShell을 열고 확인합니다. 처음부터 관리자 권한으로 실행할 필요는 없습니다.

### 1. 변경 전에 현재 값을 기록

```powershell
Get-ExecutionPolicy -List
Get-ExecutionPolicy
Get-ExecutionPolicy -Scope CurrentUser
```

`CurrentUser` 값을 별도로 기록해 두세요. 터미널 변수를 저장하는 것만으로는 VS Code 재시작 이후 복구할 수 없습니다. 우선순위는 `MachinePolicy → UserPolicy → Process → CurrentUser → LocalMachine`입니다. 조직의 그룹 정책(GPO)이 정해져 있으면 관리자에게 승인된 절차를 요청하고 우회하지 마세요. [Microsoft 실행 정책 설명](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies?view=powershell-5.1)

### 2. 허용된 경우에만 현재 사용자 범위 변경

실효 정책이 `Restricted`이고, 장비 소유자와 조직 정책이 허용하는 경우에만 다음을 실행합니다. 기존의 더 엄격한 서명 정책을 이 안내만 보고 낮추지 마세요.

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
Get-ExecutionPolicy -List
Get-ExecutionPolicy
```

`RemoteSigned`는 인터넷에서 받은 스크립트에 신뢰할 수 있는 서명을 요구할 수 있습니다. 출처와 내용을 검토하고 승인된 서명 파일을 사용하세요. 이 안내는 `Bypass`, `LocalMachine` 변경, 기본 관리자 실행 또는 다운로드 폴더 전체의 차단 해제를 권하지 않습니다. [Microsoft Set-ExecutionPolicy](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-executionpolicy?view=powershell-5.1)

VS Code의 모든 창을 종료한 뒤 다시 열고, 새 **Windows PowerShell** 터미널에서 위의 두 확인 명령을 다시 실행하세요. 정책 변경 자체는 즉시 적용되지만 새 프로세스로 실제 빌드 환경을 다시 확인하는 단계입니다. 출력이 계속 `Restricted`이면 재시도나 권한 상승 대신 GPO 및 `Process` 범위를 확인하세요.

호스트 사전 검사 패치가 포함된 빌드에서는 실효 정책이 `Restricted`이면 Packer 프로비저닝 전에 중단하고 정책 안내를 표시합니다. 아직 패치가 없는 구버전에서 같은 조기 중단을 보장하지 않습니다. VAMP가 이 설정을 자동 변경하지는 않습니다.

### 3. 필요한 경우 원래 값으로 복구

아래 명령은 처음 기록한 값이 **정확히 `Undefined`였을 때만** 사용합니다.

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy Undefined
Get-ExecutionPolicy -List
Get-ExecutionPolicy
```

이전 값이 `Restricted`, `AllSigned`, `RemoteSigned` 등 다른 값이었다면 `Undefined` 대신 **기록한 원래 값**으로 복구하세요. `Undefined`는 전체 실행 정책 초기화가 아니라 해당 사용자 범위의 명시적 설정 제거입니다. 복구 후에도 GPO와 다른 범위가 실효 정책을 결정합니다.

### Hyper-V / CIM 접근 권한은 별도 문제

실행 정책을 바꾸어도 Hyper-V 설치 여부, 가상화 지원, 서비스 상태, Hyper-V 관리 권한이나 CIM 네임스페이스 접근 권한은 부여되지 않습니다. `Access denied` / CIM 접근 오류라면 정책을 반복해서 완화하지 말고 해당 호스트 권한을 별도로 점검하세요. 필요한 기능 설치나 관리 권한 변경은 장비 관리자와 승인된 절차로 진행합니다. 이 정책 안내는 관리자 실행이나 Hyper-V 설정 변경을 대신하지 않습니다.

### Windows MCP 실행 권한

Windows에서 VAMP와 VAMP Vault의 MCP 서버는 관리자 권한이 필요합니다. 외부 MCP 클라이언트에서 설치된 `vamp-mcp` 명령을 시작하면 호스트 UAC 승인을 요청합니다. 승인하면 별도의 관리자 서버가 시작되고 기존 클라이언트가 그 서버와 연결됩니다. 직접 서버 파일을 실행하거나 `vamp-mcp-vault`를 시작할 때는 관리자 권한으로 연 호스트를 사용하세요. [MCP 등록 안내](MCP_REGISTRATION.md#windows-host-startup)

VS Code의 VM Manager나 확장이 등록한 MCP 서버를 사용하는 경우 VS Code를 관리자 권한으로 여세요.

1. 작업을 저장하고 기존 VS Code 창을 모두 종료합니다. 별도 창만 열면 기존 비관리자 프로세스를 재사용할 수 있습니다.
2. 신뢰할 수 있는 VAMP 저장소와 필요한 확장만 사용하세요. 출처를 모르는 프로젝트, 작업(task), 확장 또는 스크립트를 관리자 편집기에서 열거나 실행하지 마세요.
3. Windows 시작 메뉴에서 **Visual Studio Code → 관리자 권한으로 실행**을 직접 선택하고 UAC 내용을 확인한 뒤 승인합니다. 열린 관리자 VS Code에서 필요한 Hyper-V 빌드만 명시적으로 시작합니다.
4. 프로비저닝이 끝나면 관리자 VS Code를 종료하고 일반 권한으로 다시 실행합니다. 실패했다고 실행 정책을 완화하거나 관리자 편집기를 계속 켜 두지 마세요.

Hyper-V의 **Check permissions (UAC)**는 별도 프로세스에서 읽기 전용 권한 진단과 스위치 조회를 실행합니다. 실제 프로비저닝은 관리자 권한으로 연 VM Manager 또는 승인된 Windows VAMP MCP의 `vm_create`에서 시작하세요. Hyper-V 설치와 서비스 및 스위치 구성도 확인하세요.

### Hyper-V Debian 설치 실패 확인

현재 Hyper-V Debian 골든 이미지는 내부 스위치와 정적 네트워크 프로필을 사용합니다. Default Switch의 DHCP 화면에서 멈춘 예전 작업은 새 정적 프로필로 다시 시작하세요. **Golden images**에서 실패한 단계를 확인합니다. `static_network_preflight`는 스위치·게이트웨이, `offline_install`은 DVD·응답 ISO, `verify_static_ip_after_reboot`는 SSH와 게스트 설정 완료 파일을 확인하는 단계입니다. [정적 프로필과 복구 절차](../backends/packer/debian-hyperv/README.md)

이전 HTTP 설치 로그를 확인할 때는 다음 두 다운로드를 구분합니다.

- **`preseed.cfg`를 받지 못한 경우:** Debian 설치기 초기에 Packer 임시 HTTP 서버로 접근하는 단계입니다. 빌드 로그의 실제 `preseed/url`, HTTP 포트, 서버 실행 상태와 선택한 Hyper-V 스위치에서 그 호스트 주소까지의 경로를 확인하세요. 일반 웹 브라우저에서 ISO를 내려받았다는 사실만으로 게스트의 이 경로가 검증되지는 않습니다.
- **`postdeb.sh`를 받지 못한 경우:** preseed 처리 뒤 `late_command`가 빌드 호스트 스크립트 서버에서 게스트 후처리 파일을 받는 별도 단계입니다. 생성된 preseed의 실제 스크립트 기본 URL, 호스트 IPv4/포트, 스크립트 서버 실행 상태를 확인하세요. preseed 다운로드 성공을 postdeb 접근 성공으로 간주하지 마세요. 설치기 로그에 표시된 실패 URL을 기준으로 진단합니다.

두 경로의 주소와 포트가 항상 같다고 가정하지 마세요. 진단한다고 방화벽 전체를 끄거나 공용/LAN 전체에 서버를 노출하지 않습니다. 필요한 경우에만 관리자와 협의해 해당 빌드 인터페이스·게스트 경로·포트에 한정된 승인된 규칙을 점검합니다. 게스트 설치용 스크립트를 호스트에서 실행하지 마세요.

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


### Hyper-V permission diagnosis with UAC

The Hyper-V panel displays the Windows version without probing the VM engine.
If Create reports missing permissions, choose **Check permissions (UAC)** in the
Hyper-V panel or request `hyperv_permission_diagnosis` from the Windows-hosted
VAMP MCP server. Both paths require the user's explicit action and the user's
own response to the Windows prompt. The administrator diagnostic window checks
the host and lists switches. For actual provisioning, use VM Manager from an
administrator VS Code session or call `vm_create` from an administrator VAMP MCP
server. The installed `vamp-mcp` CLI can request host UAC to start that server.
[Windows MCP startup](MCP_REGISTRATION.md#windows-host-startup)
