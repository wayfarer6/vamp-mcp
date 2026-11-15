# VAMP — Virtual Agent Machine Platform

**RPA 및 AI Agent용 VM MCP 플랫폼**입니다. 기존 SPICE/KVM 엔진과 별도의 VirtualBox 백엔드, 실험적 Hyper-V 기동 코드를 제공합니다.

SPICE 엔진은 호스트에서 SPICE 화면을 읽고 키보드·마우스 패킷을 보내는 RPA 프로젝트입니다. 실행 대상은 **Debian VM과 Windows 11 VM으로 구분**합니다. Robot Framework가 시나리오를 실행하고, PyAutoGUI는 **게스트 화면**의 이미지 매칭에 사용합니다. YOLO로 UI 영역을 찾고 PaddleOCR로 한국어·영어·일본어·중국어 텍스트를 연결합니다. 게스트에 자동화 프로그램을 설치하거나 SSH·WebDriver·클립보드를 사용하지 않습니다. 자동화 탐지가 불가능하다는 보장은 없습니다.

이 프로젝트는 사용자가 요구사항과 방향을 제시하고 **AI 에이전트(Codex)와 바이브 코딩으로 개발**했습니다. Python·Robot Framework 코드, 스킬과 문서를 AI의 도움으로 작성·수정했습니다.

**실제 실행·검증 환경: Ubuntu 26.04.1 LTS + NVIDIA GeForce RTX 3050 Laptop GPU.** AMD·Apple·NPU는 설치 프로필과 백엔드 경로를 제공하지만 해당 장비에서 별도 검증하지 않았습니다.

## 대상 VM: Debian / Windows 11

| 대상 | 현재 libvirt VM 이름 | 공통 기준 해상도 | 현재 시나리오 상태 |
| --- | --- | --- | --- |
| Debian VM | `debian13` | 1920×1080 | GNOME Firefox·네이버·root apt update 예제 구현 및 실제 실행 확인 |
| Windows 11 VM | `windows-RPA` | 1920×1080 | 녹화 기반 네이버 로그인 화면 도달 검증; Windows 업데이트 절차는 미구현 |

해상도가 같아도 OS·브라우저 배율·글꼴·UI 배치는 다르므로 좌표와 탐지 규칙을 검증 없이 공유하지 않습니다. 공통 SPICE/OCR 엔진을 재사용하고, OS별 `.robot`과 Python 동작은 구분해 관리합니다. 현재 GNOME `Alt+F2`, `su root`, `apt update`를 쓰는 패키지는 Debian용입니다. 게스트 Windows 11과 RPA를 설치하는 호스트 OS는 별개입니다.

두 VM의 SPICE 포트는 libvirt에서 자동 배정합니다. VM을 실행한 뒤 실제 주소를 확인해 `SPICE_URI`에 전달하세요. 개발 기본값 `spice://127.0.0.1:5900`이 항상 Debian에 연결된다고 가정하지 마세요.

```bash
virsh -c qemu:///system domdisplay debian13
virsh -c qemu:///system domdisplay windows-RPA
```

## RPA별 패키지 규격

이제 실행·공유 단위는 **RPA 하나 = 폴더 하나 + 하나 이상의 `.robot` 파일 + 전용 Python 라이브러리 + manifest**입니다. 작업 순서와 검증은 Robot 파일에, 좌표·SPICE 입력·YOLO·OCR 세부 처리는 Python에 둡니다.

```text
rpas/
├── naver_login/
│   ├── manifest.json
│   ├── run.robot       # 로그인 화면 검출
│   ├── login.robot     # 계정 입력·로그인 제출
│   └── workflow.py
├── debian_update/
│   ├── manifest.json
│   ├── run.robot
│   └── workflow.py
└── common.resource     # 공통 연결·종료·결과·사용자 인계
```

| 패키지 ID | 현재 대상 | 작업 |
| --- | --- | --- |
| `firefox_launch` | Debian GNOME | Firefox 실행 |
| `firefox_naver` | Debian GNOME | Firefox에서 네이버 접속 |
| `naver_login` | Debian GNOME 기동 절차 | 로그인 폼 검출 또는 명시적으로 선택한 로그인 제출 |
| `debian_update` | Debian 전용 | root apt update |
| `captcha_handoff` | 공통 OCR; Windows 미검증 | CAPTCHA·추가 인증 감지 후 사용자 인계 |
| `desktop_control` | 공통 SPICE; Windows 미검증 | 화면·OCR·YOLO·좌표·키보드 작업 |

```bash
cd /home/ssh1032007/spice_kvm_based_rpa
.venv/bin/python scripts/run_rpa.py --list
.venv/bin/python scripts/run_rpa.py debian_update
.venv/bin/python scripts/run_rpa.py naver_login
# 실제 로그인 제출은 별도 진입점을 명시
.venv/bin/python scripts/run_rpa.py naver_login --entry login --var CREDENTIAL_SOURCE:prompt
```

기본 결과는 `artifacts/rpas/<ID>/summary.json`이며, `schema_version`, `rpa_id`, `status`와 필요한 검증·상세 경로만 반환합니다. Robot 보고서는 같은 폴더의 `report.html`, 로그는 `log.html`입니다. 기존 `rpa.py` CLI와 `tests/*.robot` 실행법도 유지합니다.

[패키지 규격·변수·결과·새 RPA 추가·녹화 확장 안내](rpas/README.md)에 전체 사용법을 정리했습니다. 스킬은 이 패키지의 `.robot` 진입점을 우선 실행하도록 연결했습니다. Robot listener를 붙일 실행 경계는 마련했으며, 영상·매크로 녹화 기능 자체는 아직 구현하지 않았습니다.

## 사용자 직접 작성·수동 기록 가져오기

누구나 공개 Python CLI로 RPA 폴더를 만들거나 Recorder 코드를 변환할 수 있습니다. AI 없이도 실행 가능합니다.

```bash
# 직접 작성할 Windows RPA의 Robot/Python/manifest 틀 생성
.venv/bin/python scripts/new_rpa.py my_windows_task --guest-os windows11
# Debian용은 --guest-os debian

# 게스트 안에서 기록한 PyAutoGUI Python을 Robot/SPICE 패키지로 변환
.venv/bin/python scripts/convert_recording.py ~/naver_login_rpa \
  --id my_recorded_naver --guest-os windows11 --coordinate-space guest \
  --width 1920 --height 1080
```

Windows 프로그램은 **Win+R + 실행 명령**, Debian GNOME은 **Alt+F2 + 실행 명령**으로 시작합니다. 사용자마다 다른 바탕화면 아이콘 좌표에 의존하지 않습니다. 원본 파일은 실행하거나 덮어쓰지 않고 정적 분석하며, 지원하지 않는 문장은 중단합니다.

이번 입력은 `~/naver_login_rpa`이고 생성 패키지는 `rpas/windows_naver_recorded/`입니다. 80개 동작을 변환했고 Win+R 시작을 확인했습니다. 기본 실행은 `needs_review`로 멈추며, 검토 후 `ALLOW_REPLAY:True`를 지정해야 VM 입력을 보냅니다. 원시 기록은 민감한 키 입력이 있을 수 있어 `recording.local.json`으로 로컬 보관하고 Git에서 제외합니다.

[직접 작성·변환·좌표 보정·재생 안내](docs/RECORDING_CONVERSION.md) · [AI 변환 스킬](.agents/skills/spice-recording-convert/SKILL.md)

## 설치

[수동 설치·AI 에이전트 설치·플랫폼별 세부 안내](docs/INSTALL.md)에 전체 절차를 정리했습니다. requirements는 **컨트롤러 호스트**에 설치하고 게스트 VM에는 설치하지 않습니다.

### 수동 설치 — Ubuntu + NVIDIA

```bash
sudo apt update
sudo apt install python3-venv python3-gi python3-pil gir1.2-spiceclientglib-2.0
/usr/bin/python3 -m venv --system-site-packages .venv
.venv/bin/python -m pip install -r requirements-nvidia.txt
.venv/bin/python -m pip install uv
.venv/bin/uv venv --python 3.12 .venv-ocr
.venv/bin/uv pip install --python .venv-ocr/bin/python -r requirements-ocr.txt
.venv/bin/python scripts/download_models.py
```

OS의 GI/SPICE와 컨트롤러 Python 버전이 맞아야 합니다. 현재 환경은 컨트롤러 Python 3.14와 OCR Python 3.12를 사용합니다. Linux 호스트에서는 GUI 세션의 `DISPLAY`, `XAUTHORITY`도 필요합니다.

| 호스트 가속기 | requirements | YOLO `DEVICE` | 검증 상태 |
| --- | --- | --- | --- |
| NVIDIA CUDA | `requirements-nvidia.txt` | `auto` / `0` | Ubuntu + NVIDIA 실제 실행 확인 |
| CPU | `requirements-cpu.txt` | `cpu` | 기존 Ubuntu에서 CPU 추론 확인; 새 설치 프로필 미검증 |
| AMD ROCm | `requirements-amd-rocm.txt` | `rocm` / `auto` | 미검증 |
| Apple Silicon MPS | `requirements-apple.txt` | `mps` / `auto` | 미검증 |
| Huawei Ascend NPU | `requirements-npu-ascend.txt` | `ascend-npu` | 미검증 |
| Intel NPU OpenVINO | `requirements-npu-intel.txt` | `intel-npu` | 미검증 |

프로필은 하나만 선택해 `pip install -r <파일>`로 설치합니다. 드라이버·ROCm·CANN·SPICE GI는 pip와 별도로 준비해야 합니다. Apple은 MPS GPU 경로이며 Neural Engine 지원을 의미하지 않습니다. NPU는 제조사별 런타임을 구분하며 모든 NPU를 지원한다는 뜻은 아닙니다. PaddleOCR는 모든 프로필에서 별도 `requirements-ocr.txt`와 CPU를 사용합니다. 기존 `requirements.txt`는 일반/호환 설치용으로 유지합니다.

`auto`는 사용 가능한 CUDA/ROCm → MPS → Ascend → CPU 순서로 선택합니다. Intel NPU는 명시적으로 선택하며 최초 OpenVINO 모델 변환이 필요합니다. 사용 예:

```bash
.venv/bin/python scripts/run_rpa.py desktop_control --var ACTION:analyze --var DEVICE:rocm
.venv/bin/python scripts/run_rpa.py desktop_control --var ACTION:analyze --var DEVICE:mps
.venv/bin/python scripts/run_rpa.py desktop_control --var ACTION:analyze --var DEVICE:intel-npu
```

설치 조합 출처: [PyTorch](https://pytorch.org/get-started/previous-versions/), [MPS](https://docs.pytorch.org/docs/stable/notes/mps.html), [Ascend](https://docs.ultralytics.com/integrations/ascend/), [OpenVINO](https://docs.ultralytics.com/integrations/openvino/). 프로필 제공과 실제 장비 검증은 구분합니다.

### AI 에이전트에게 설치 요청

`$spice-rpa-install` 스킬을 추가했습니다. 예시:

> README와 docs/INSTALL.md를 읽고 내 호스트에 맞는 requirements 하나로 컨트롤러 venv와 OCR venv를 설치해줘. Ubuntu + NVIDIA만 검증된 프로젝트라는 점을 유지하고, 게스트에 패키지를 설치하거나 로그인·업데이트 RPA를 실행하지 마.

에이전트는 호스트 OS·Python·GI·가속기 런타임을 확인한 뒤 프로필 하나를 고르고 pip/uv 설치를 진행합니다. AMD·Apple·NPU 장비별 테스트는 별도 요청이 없으면 실행하지 않습니다. [설치 스킬](.agents/skills/spice-rpa-install/SKILL.md)

## Firefox 실행 — Debian GNOME

Debian 검증 예제: `debian13`, 당시 SPICE 주소 `spice://127.0.0.1:5900`, 기준 화면 1920×1080. 실제 실행 주소는 위 VM 구분 절차로 확인하세요.

```bash
.venv/bin/python -m robot --outputdir artifacts tests/launch_firefox.robot
# 다른 연결 주소
.venv/bin/python -m robot --variable SPICE_URI:spice://127.0.0.1:5901 --outputdir artifacts tests/launch_firefox.robot
```

GNOME Alt+F2 실행창에서 `firefox`를 입력합니다. `artifacts/firefox.png`로 실제 실행 여부를 확인하세요. 시나리오는 Firefox 문구를 OCR로 검사합니다. SPICE 서버는 새 클라이언트 연결 시 기존 virt-manager 뷰어를 끊을 수 있습니다.

## AI 제어 인터페이스

```bash
.venv/bin/python rpa.py capture
.venv/bin/python rpa.py analyze --languages ko,en,ja,zh
.venv/bin/python rpa.py analyze --languages en --device cpu
.venv/bin/python rpa.py click-text '확인'
.venv/bin/python rpa.py click 800 500
.venv/bin/python rpa.py hotkey ctrl l
.venv/bin/python rpa.py write 'about:blank'
.venv/bin/python rpa.py hotkey enter
```

`--uri`는 서브커맨드 앞에 지정합니다. 기본 분석 결과는 `artifacts/ui.json`, 번호가 표시된 화면은 `artifacts/ui.annotated.png`입니다. 각 요소에는 다음이 있습니다.

- `kind`: YOLO `ui_region` 또는 OCR 단독 `text`
- `text`, `ocr_confidence`, `readings`: 문구, 신뢰도, 언어별 판독 후보
- `xyxy`, `center`: 게스트 원본 화면의 영역과 클릭 중심
- `id`, `confidence`: 프레임 내 번호와 YOLO 탐지 신뢰도

YOLO는 접근성 API가 아니므로 영역이 실제 버튼인지는 화면과 문구를 함께 판단해야 합니다. 문구 클릭은 정확히 하나의 일치 결과, OCR 신뢰도 ≥0.7, 분석 후 동일한 대상 화면을 요구합니다. 여러 결과 또는 바뀐 화면이면 실패시켜 잘못된 클릭을 방지합니다. 언어별 잘못된 OCR 후보도 나올 수 있으므로 중요한 작업은 화면을 확인하세요.

입력은 US 키보드 기준 ASCII를 지원합니다. CJK OCR 지원과 CJK 문자열 입력 지원은 별개입니다. CLIENT 마우스 모드에서 절대 좌표를 사용합니다. SERVER 모드 상대 이동 API는 제공하지만, OS 가속을 제거하지 않으므로 정밀 클릭을 보장하지 않습니다.

## Codex 스킬

`.agents/skills/spice-vm-rpa/SKILL.md`에 워크플로가 있습니다. `$spice-vm-rpa`로 호출할 수 있도록 현재 호스트의 `~/.codex/skills/spice-vm-rpa`에 연결했습니다. 다른 호스트에서는 해당 폴더를 스킬 경로에 설치하고 저장소 위치를 맞추세요.


### 실패한 RPA의 AI 보정

`$spice-rpa-repair` 스킬을 추가했습니다. 예: “네이버 로그인 RPA가 실패했으니 `$spice-rpa-repair`로 원인을 확인하고 좌표·탐지 규칙을 보정해줘.”

AI가 짧은 실패 결과와 Robot 키워드 기록을 읽고, 필요한 경우 현재 OCR·YOLO 좌표를 다시 관찰합니다. UI 위치 변경이면 해당 패키지의 `workflow.py`나 탐지 규칙을 수정하고, Robot 순서 문제이면 `.robot`을 수정합니다. 단위 테스트·dry-run 후 승인된 범위의 안전한 단계만 재검증합니다. CAPTCHA·자격 증명 대기는 사용자에게 넘기고, 로그인 제출 같은 동작을 무조건 반복하지 않습니다.

```bash
# VM 조작 없이 실패 근거의 위치와 요약만 수집
.venv/bin/python .agents/skills/spice-rpa-repair/scripts/collect_failure.py naver_login
# 별도 실행 폴더를 사용한 경우
.venv/bin/python .agents/skills/spice-rpa-repair/scripts/collect_failure.py naver_login --run-dir artifacts/my-login-run
```

이 스킬은 실패 후 AI가 호출해 수행하는 코드 보정 절차입니다. 일반 RPA 실행 중 모델을 자동 호출하거나 코드를 스스로 수정하는 기능은 아닙니다. 보정 시도는 실패 건당 최대 2회이며, 실시간 검증 여부를 구분해 보고합니다. [스킬 지침](.agents/skills/spice-rpa-repair/SKILL.md)에 상세 절차가 있습니다.

## 모델 출처

UI 탐지: [Microsoft OmniParser v2 icon_detect](https://huggingface.co/microsoft/OmniParser-v2.0) (YOLOv8). 해당 가중치는 AGPL-3.0이며 `models/OMNIPARSER-LICENSE`를 보존합니다. 원본 코드·모델의 라이선스는 각각 적용됩니다. OCR: [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR). [SPICE 입력 API](https://www.spice-space.org/api/spice-gtk/SpiceInputsChannel.html).

가중치의 출처 revision과 SHA-256은 `models/manifest.json`으로 고정하고 다운로드 시 검사합니다. 가중치, venv, 캡처·로그는 Git에 포함하지 않습니다. `scripts/download_models.py`로 YOLO 가중치를 복원할 수 있습니다.

## 네이버 접속·로그인 예시

```bash
# Firefox 실행 → 네이버 접속 → 화면의 도메인과 NAVER 텍스트 OCR 검사
.venv/bin/python -m robot --outputdir artifacts/naver-run tests/firefox_naver.robot

# 로그인 화면으로 이동 → ID/PW/Sign in 영역 검출, 계정 입력 없이 종료
.venv/bin/python -m robot --outputdir artifacts/login-run tests/naver_login.robot
.venv/bin/python rpa.py login

# 호스트의 비공개 입력창에서 계정 수집 → SPICE 입력 → 로그인 한 번 제출
.venv/bin/python rpa.py login --prompt-credentials

# 실행 환경에 NAVER_ID, NAVER_PASSWORD가 이미 제공된 경우
.venv/bin/python rpa.py login --use-env
.venv/bin/python -m robot --variable LOGIN_SUBMIT:True --outputdir artifacts/login-run tests/naver_login.robot
```

`rpa.py login`의 기본 동작은 화면 검출까지만 수행합니다. `artifacts/login/state.json`의 `needs_credentials`는 로그인 폼을 확인했고 계정 입력을 기다린다는 의미입니다. 결정론적 규칙은 ID/PW/로그인 문구, 각 영역의 세로 배치, 유일한 폼, OCR 신뢰도 ≥0.7, 주소창의 `nid.naver.com`을 요구합니다. 가중치가 고정된 YOLO 탐지 후 이 규칙을 적용하며 LLM 판단으로 필드를 추측하지 않습니다.

입력 전 화면이 유지됐는지 검사하고, 비밀번호는 Robot 인자나 명령행 인자로 받지 않습니다. 비대화형 실행의 `--prompt-credentials`는 호스트 Zenity 창을 열며, 로컬 터미널에서는 getpass를 씁니다. 계정은 파일에 저장하지 않습니다. 로그인 제출 후 확인용 화면·OCR 결과는 임시 폴더에서 검사한 뒤 삭제합니다. 로그인 화면을 캡처하는 다른 프로그램은 이 코드의 제어 범위 밖입니다.

`logged_in`은 로그아웃 UI를 인식한 경우에만 반환합니다. `submitted_unverified`는 제출만 확인했으며 성공을 증명하지 못했다는 뜻입니다. CAPTCHA·OTP·추가 인증이 보이면 `needs_user_verification`으로 멈춥니다. 실패한 계정을 반복 제출하지 않습니다.

AI 로그인 스킬은 `.agents/skills/spice-naver-login/SKILL.md`이며 현재 호스트에 `$spice-naver-login`으로 연결했습니다. 로그인 대기 상태를 확인한 AI가 비공개 입력창을 띄우고, 사용자가 제공한 ID/PW를 VM의 검출된 필드에 SPICE로 입력하는 절차입니다.

영문 로그인 페이지(`locale=en_US`)를 사용해 게스트의 한글 폰트가 부족해도 입력란을 확인할 수 있습니다. 네이버 본문에서 글자가 네모로 보이면 게스트에 해당 폰트가 필요하며 OCR로 원래 문자를 복원할 수 없습니다. 현재 지원하는 인증 정보는 US 키보드로 입력 가능한 ASCII입니다.

## 검증

```bash
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python scripts/check_multilingual_ocr.py
.venv/bin/python -m robot --outputdir artifacts/examples-run tests/launch_firefox.robot tests/firefox_naver.robot tests/naver_login.robot
```

라이브 VM 검증은 한 프로세스씩 실행하세요. 같은 엔드포인트의 RPA 세션은 파일 잠금으로 동시 제어를 막고, 다른 뷰어가 연결을 끊으면 중단합니다. 사용자의 직접 입력과 자동화 입력도 섞이지 않게 하세요.

재현용 의존성 목록은 `requirements.lock.txt`와 `requirements-ocr.lock.txt`에 있습니다. 전자는 현재 Linux/Python 3.14/CUDA 13.2 환경을 기록하므로 다른 Python·GPU 환경에서는 `requirements.txt`를 기준으로 호환 Torch를 선택하세요. 시스템 GI/Pillow는 OS 패키지에서 제공됩니다.

## 공개 Debian VM에서 root apt update — OCR 전용

직접 실행하는 순서는 [VM 업데이트 실행 가이드](docs/VM_UPDATE.md)에 정리했습니다.

소유자가 공개 배포를 명시적으로 요청한 테스트 자격 증명입니다. `config/sandbox-vm.json`에 VM 이름 `debian13`, SPICE 주소, root 계정과 공개 비밀번호 `password123!`를 기록했습니다. 이 공개 VM 설정과 네이버 등 개인 계정 정보는 별도로 취급합니다.

```bash
.venv/bin/python rpa.py vm-update
.venv/bin/python -m robot --outputdir artifacts/update-run tests/vm_update.robot
```

`Ctrl+Alt+T`로 터미널을 열고 OCR로 확인합니다. 단축키가 설정되지 않은 Debian GNOME 환경에서는 `Alt+F2` → `gnome-terminal --maximize`로 전환합니다. 이후 `su root` → `Password:` 프롬프트 확인 → 설정 비밀번호 입력 → root 프롬프트 및 `id -u` 확인 → `apt update` 실행 순서입니다. 완료 후 `exit`로 root 셸을 나옵니다.

AI는 화면 이미지를 보지 않고 로컬 PaddleOCR의 텍스트만 읽습니다. 실행 결과 표식은 printf의 8진수 이스케이프로 출력하므로, 명령어가 화면에 에코된 것을 성공 결과로 오인하지 않습니다. 콘솔과 라이브러리는 요약 결과만 반환합니다. 요약은 `artifacts/vm-update/summary.json`, 전체 OCR 기록은 `artifacts/vm-update/result.json`에 저장됩니다. `--full-result` 옵션으로 실행하면 콘솔에도 전체 기록을 출력합니다. `succeeded`, `completed_with_warnings`, `failed`, 검증 불가·타임아웃 상태를 구분하며, Robot 예시는 `succeeded`일 때만 통과합니다. `apt update`는 패키지 목록을 갱신하며 패키지 업그레이드를 수행하지 않습니다.

2026-11-15 초기 VM 검증: OCR로 `Password:`, `root@debian`과 root 확인 표식을 인식했고 `apt update`를 실행했습니다. 최종 결과는 **failed**였습니다. 온라인 Debian 저장소에는 접속했지만, 설치 DVD 저장소의 다음 오류와 실패 표식이 검출됐습니다.

```text
Error: The repository 'cdrom://[Debian GNU/Linux 13.7.0 ...] trixie Release' does not have a Release file.
```

게스트 상세 로그: `/tmp/spice-rpa-apt-qrfpzy.log`. 이 검증에서는 APT 저장소 설정을 변경하지 않았습니다. `$spice-vm-update` 스킬은 같은 OCR 전용 절차와 실패 처리 방법을 제공합니다.

## CAPTCHA·추가 인증의 사용자 인계

```bash
.venv/bin/python rpa.py check-verification
.venv/bin/python scripts/check_verification_ocr.py
```

첫 명령은 현재 VM 화면을 OCR로만 검사하고 이동·클릭·타이핑하지 않습니다. 두 번째는 실제 CAPTCHA 대신 4개 언어의 **안내 문구만** 그린 합성 이미지로 OCR 감지를 검증합니다.

로그인 RPA는 계정 입력 전과 제출 후 `CAPTCHA`, `I'm not a robot`, `보안문자`, `画像認証`, `图形验证码` 등의 안내를 검사합니다. 결과가 `needs_user_captcha` 또는 `needs_user_verification`이면 자동 입력을 멈추고 다음과 같이 안내하는 `$spice-captcha-handoff` 스킬을 제공합니다.

> 보안 확인 화면이 감지되어 자동화를 멈췄습니다. VM 창에서 CAPTCHA나 추가 인증을 직접 완료한 뒤 ‘완료’라고 알려주세요. 완료 후 제가 화면 상태를 다시 확인하겠습니다.

사용자의 완료 통보 뒤 한 번 재검사하고 예상하는 다음 화면의 긍정적인 OCR 증거를 확인한 후 이어갑니다. `no_challenge_text`는 안내 문구를 찾지 못했다는 뜻이며, CAPTCHA 해제나 로그인 성공을 보장하지 않습니다. 문구가 없는 이미지형 CAPTCHA, 누락된 폰트, 낮은 OCR 품질은 감지를 방해할 수 있습니다. CAPTCHA의 정답을 읽거나 자동으로 풀지 않습니다.

## 라이선스와 추가 백엔드

직접 작성한 코드와 문서는 [MIT](LICENSE)입니다. 외부 모델·라이브러리·가상화 제품의 라이선스는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)처럼 별도로 유지합니다.

- [VirtualBox](backends/virtualbox/README.md): main에서 제공. 상류 MIT `mcp-virtualbox`를 포함하며, 기본 `separate` 기동으로 사용자 관전 창과 RPA 실행을 분리합니다. Ubuntu 호스트의 기존 Windows/Debian VM에서 실제 실행 검증했습니다. 새 VM 생성·스냅샷 촬영·복원은 실행하지 않았습니다.
- [Hyper-V](backends/hyperv/README.md): 실험적 VMConnect/UAC 기동 코드. RDP 화면·입력 어댑터는 미구현이며 Windows 장비 테스트가 필요합니다.
- SPICE VM 전체를 MCP로 묶은 구현은 별도 `feat/vm-mcp-server` 브랜치에 있습니다. VirtualBox MCP 엔트리는 main에도 독립적으로 있습니다.

YOLO/OCR은 [별도 백그라운드 Python 프로세스](docs/MODEL_BACKGROUND.md)에서 모델을 유지합니다. systemd 등록 없이 `scripts/model_service.py start/status/stop`으로 관리하며, 실제 SPICE 연결 시 자동으로 시작합니다.

## VS Code Marketplace용 확장

[VAMP 확장 안내](vscode-extension/README.md), [패키징·게시 절차](docs/VSCODE_MARKETPLACE.md). `.vsix` 형식으로 패키징하며 Node MCP 서버를 번들합니다. **VAMP: Set Up Python Environment**가 호스트 전용 venv를 만들고, **VAMP: Create VM From ISO**가 ISO 파일을 선택받아 AI 루프 없이 무인 설치를 시작합니다. 기본 공개 계정은 `vboxuser` / `password123!`입니다. 게시자 인증과 실제 Marketplace 업로드는 별도입니다.

VirtualBox MCP `vm_create`도 ISO 경로 하나로 자동 이름·기본 사양을 선택할 수 있습니다. VM 생성 후 설치를 `separate` 모드로 시작하며, 레코더는 [게스트 설치 안내](docs/GUEST_RECORDER.md)에 따라 Debian postinstall / Windows 최초 바탕화면 로그인 시 구성합니다. 실제 설치 완료를 자동 검증한 상태는 아닙니다.

게스트 OS 자체 **1920×1080 / 배율 100%** 및 호스트 관전 **View → Scaled Mode** 설정은 [해상도 안내](docs/VM_DISPLAY.md)를 참고하세요. Windows Guest Additions ISO 삽입은 스크립트로, 설치/UAC 승인과 재부팅은 사용자가 수행합니다.

[초기 설정·매 로그인 해상도·GUI 녹화 공유·스냅샷 안내](docs/GUEST_AUTOMATION.md)를 추가했습니다. Debian 네트워크 미러를 자동 설정하고, Windows는 생성 전에 별도 선택과 라이선스 고지를 합니다.

[Robot 실행 영상·스크린샷·SQLite 이력](docs/EXECUTION_HISTORY.md): 선택적 저화질 녹화와 MCP 이력·이미지 조회를 제공합니다.

현재 실제 VirtualBox 검증 대상은 **Win-RPA / Debian-RPA**입니다. 위의 libvirt VM 이름은 기존 SPICE 개발 구성의 이름이며 현재 호스트에서 실행 중이라고 가정하지 않습니다. GUI 레코더는 선택적으로 게스트에 설치하는 프로그램이고, 기존 SPICE 입력 실행 자체에 게스트 자동화 에이전트가 필요한 것은 아닙니다.

현재 환경의 실제 검증 결과와 미검증 범위는 [검증 기록](docs/VALIDATION.md)에 정리했습니다.
