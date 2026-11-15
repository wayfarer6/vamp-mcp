# RPA 패키지 규격 v1

이 프로젝트는 AI 에이전트와 바이브 코딩으로 개발했습니다. 실제 실행·검증 호스트는 Ubuntu + NVIDIA입니다. [호스트 설치와 가속기 프로필](../docs/INSTALL.md)을 참고하세요.

게스트 대상은 Debian(`debian13`)과 Windows 11(`windows-RPA`)로 구분하고 둘 다 1920×1080 기준을 사용합니다. 동일 해상도가 동일 좌표·UI를 보장하지는 않습니다. 현재 GNOME Firefox 기동·로그인 준비와 apt update는 Debian용이며, Windows 전용 작업은 별도로 작성·검증해야 합니다. 패키지 선택과 호스트 GPU/NPU 프로필 선택은 별개입니다.

RPA 한 개를 폴더 하나로 관리합니다. 각 폴더에는 하나 이상의 `.robot` 실행 파일, RPA 전용 Python 라이브러리, 실행 메타데이터가 들어갑니다. Robot Framework의 표준 확장자는 `.robot`입니다.

```text
rpas/
├── common.resource             # SPICE 연결·종료, 결과·사용자 인계 공통 키워드
├── manifest.schema.json        # manifest 형식
├── naver_login/
│   ├── manifest.json
│   ├── run.robot               # 로그인 화면 검출만
│   ├── login.robot             # 검출 → 계정 입력 → 제출 → 결과 확인
│   └── workflow.py             # 이 RPA의 Python 키워드
└── debian_update/
    ├── manifest.json
    ├── run.robot               # root apt update → 결과 확인
    └── workflow.py
```

`.robot`에는 작업 순서, 분기, 확인 조건을 적습니다. `workflow.py`는 좌표·입력·OCR·YOLO와 해당 RPA의 세부 동작을 처리합니다. 공통 엔진인 `spice_robot.py`, `vision.py`, `login_flow.py`, `vm_update.py` 등은 저장소 루트에서 공유합니다. 패키지 폴더만 복사한 독립 실행은 지원하지 않으므로 공유할 때는 공통 엔진과 의존성도 함께 제공해야 합니다.

## 제공 패키지

| ID | 기본 진입점 | 동작 |
| --- | --- | --- |
| `firefox_launch` | `run.robot` | Firefox 실행·OCR 확인 |
| `firefox_naver` | `run.robot` | Firefox 실행·네이버 접속·OCR 확인 |
| `naver_login` | `run.robot` | 로그인 폼 검출까지만 수행 |
| `naver_login` | `login.robot` | 자격 증명을 받아 로그인 제출 |
| `debian_update` | `run.robot` | root apt update·OCR 결과 판정 |
| `captcha_handoff` | `run.robot` | 현재 화면 인증 문구 확인·사용자 인계 |
| `desktop_control` | `run.robot` | 화면 캡처·OCR·YOLO·키보드·마우스 작업 한 개 |

## 실행

저장소 루트에서 `.venv` Python으로 실행합니다. `run_rpa.py`는 manifest에서 **하나의 Robot 진입점만 선택**합니다. 작업 구현은 해당 Robot 파일과 Python 라이브러리에 있습니다.

```bash
cd /home/ssh1032007/spice_kvm_based_rpa
.venv/bin/python scripts/run_rpa.py --list
.venv/bin/python scripts/run_rpa.py firefox_launch
.venv/bin/python scripts/run_rpa.py firefox_naver
.venv/bin/python scripts/run_rpa.py debian_update

# 로그인 폼 검출만: 자격 증명을 입력하거나 제출하지 않음
.venv/bin/python scripts/run_rpa.py naver_login

# 실제 제출: 호스트 비공개 입력창/getpass 사용
.venv/bin/python scripts/run_rpa.py naver_login --entry login --var CREDENTIAL_SOURCE:prompt

# NAVER_ID/NAVER_PASSWORD가 실행 환경에 이미 제공된 경우
.venv/bin/python scripts/run_rpa.py naver_login --entry login

# 현재 화면만 검사. 사용자의 CAPTCHA 진행 상태를 보존
.venv/bin/python scripts/run_rpa.py captcha_handoff
```

한 번에 한 명령씩 실행하세요. `robot rpas`처럼 폴더 전체를 일반 실행하면 apt update와 로그인 제출 진입점도 순서대로 실행될 수 있으므로, 전체 폴더 검사는 아래의 `--dryrun`으로 수행하세요.

표준 Robot 명령으로 직접 실행할 수도 있습니다.

```bash
.venv/bin/python -m robot --outputdir artifacts/rpas/debian_update rpas/debian_update/run.robot
.venv/bin/python -m robot --variable CREDENTIAL_SOURCE:prompt --outputdir artifacts/rpas/naver_login rpas/naver_login/login.robot
```

다른 SPICE 주소는 `--var SPICE_URI:spice://127.0.0.1:5901`로 전달합니다. Debian 업데이트는 `--var VM_CONFIG:config/my-sandbox-vm.json`도 지정해 설정 파일의 URI를 맞춰야 합니다.

## 화면·입력 RPA

```bash
# 기본은 화면 캡처 한 번
.venv/bin/python scripts/run_rpa.py desktop_control
.venv/bin/python scripts/run_rpa.py desktop_control --var ACTION:screen-info
.venv/bin/python scripts/run_rpa.py desktop_control --var ACTION:ocr --var LANGUAGES:ko,en,ja,zh
.venv/bin/python scripts/run_rpa.py desktop_control --var ACTION:analyze
.venv/bin/python scripts/run_rpa.py desktop_control --var ACTION:hotkey --var KEYS:ctrl+l
.venv/bin/python scripts/run_rpa.py desktop_control --var ACTION:write --var TEXT:about:blank
.venv/bin/python scripts/run_rpa.py desktop_control --var ACTION:hotkey --var KEYS:enter
.venv/bin/python scripts/run_rpa.py desktop_control --var ACTION:click --var X:800 --var Y:500
.venv/bin/python scripts/run_rpa.py desktop_control --var ACTION:click-text --var TEXT:확인
```

YOLO `DEVICE`는 `cpu`, `auto`, `rocm`, `mps`, `ascend-npu`, `intel-npu` 등을 받습니다. AMD·Apple·NPU 경로는 미검증입니다.

추가 ACTION: `move`, `move-relative`(`DX`, `DY`), `detect`, `find-image`, `click-image`(`TEMPLATE`). 절대 좌표는 게스트 원본 화면 기준입니다. 상대 이동은 SERVER 모드에서만 가능합니다. 일반 `write`에 개인 비밀번호를 넘기면 Robot 인자 로그에 남으므로 계정 입력에는 전용 로그인 진입점을 사용하세요.

## 공통 결과

기본 출력 폴더는 `artifacts/rpas/<id>/`입니다. `--output <폴더>`로 변경할 수 있습니다.

```json
{
  "schema_version": 1,
  "rpa_id": "debian_update",
  "status": "succeeded",
  "verification": "ocr_only",
  "root_verified": true,
  "root_shell_exited": true,
  "details_path": ".../update/result.json"
}
```

- `summary.json`: AI와 호출자가 읽는 짧은 결과. `status`가 실제 작업 상태입니다.
- `log.html`, `report.html`, `output.xml`: Robot 실행·검증 기록.
- 화면·OCR 상세 자료: 해당 실행 폴더 아래 저장. Debian 업데이트는 `update/`, 로그인 폼 검출은 `login/`에 저장.
- 실패 시 `error_summary`는 최대 300자로 제한합니다. Robot 검증이 실패하면 `execution_status: failed`도 기록합니다.

`executed`는 입력을 전송했다는 뜻이며 목표 화면 도달을 보장하지 않습니다. `observed`, `captured`, `analyzed`, `detected`, `found`도 각 관찰 동작의 완료 상태입니다. `needs_credentials`는 계정 입력 대기, `needs_user_captcha`/`needs_user_verification`은 사용자 인계입니다. CAPTCHA 인계 시 Robot 작업은 SKIP으로 종료해 사용자 조작을 기다립니다. `no_challenge_text`만으로 인증 통과나 로그인 성공을 주장하지 않습니다.

실제 로그인은 `logged_in`을 확인해야 합니다. Debian 업데이트는 `succeeded`일 때만 Robot PASS입니다. 연결·import 문제로 실행이 시작되지 못하면 Robot 로그도 확인하세요. 같은 출력 폴더를 재사용하면 이전 결과를 덮어씁니다.

## 새 RPA 추가 규칙

1. `rpas/<영문_snake_case_ID>/`를 만듭니다.
2. `manifest.json`에 ID, 버전, 기본 진입점, 각 Robot 파일, Python 라이브러리, 의존성, 연결 스킬을 선언합니다. 자격 증명 제출 진입점은 별도 이름으로 분리합니다.
3. `run.robot`에서 `../common.resource`와 전용 `workflow.py`를 import합니다. `Start RPA`, `Stop RPA`, `Finish RPA Task`를 기존 패키지처럼 사용합니다.
4. Python 키워드에서 세부 동작을 수행하고, Robot 파일에서 결과를 검증합니다. `Contract.Publish Result`로 짧은 결과를 발행합니다.
5. 해당 스킬의 `SKILL.md`에 패키지·Robot·Python 경로와 실행 명령을 함께 명시합니다.

```bash
.venv/bin/python scripts/validate_rpas.py
.venv/bin/python scripts/run_rpa.py debian_update --dryrun
.venv/bin/python -m robot --dryrun --outputdir artifacts/rpa-packages-dryrun rpas
.venv/bin/python -m unittest discover -s tests -v
```

파일 검증 스크립트는 패키지 ID, 기본 진입점, 파일 경계·존재 여부, 자격 증명 유형과 출력 규약을 검사합니다. `manifest.schema.json`도 제공하므로 외부 도구에서 JSON Schema 검증을 추가할 수 있습니다. dry-run은 VM을 조작하지 않으며, 실제 작업 성공의 증거는 아닙니다. 표준 실행기의 dry-run 기본 출력은 `artifacts/rpas-dryrun/<id>/`로 분리해 실제 실행 기록을 덮어쓰지 않습니다.

## 녹화 확장 지점

Robot의 작업·키워드 시작/종료 경계를 녹화 시작·종료나 타임스탬프 기록에 연결할 수 있도록 실행 진입점을 통일했습니다.

```bash
.venv/bin/python scripts/run_rpa.py firefox_launch --listener my_recorder.py
```

`--listener`에는 사용자가 구현·설치한 Robot listener를 전달합니다. **현재 동영상 녹화나 수동 조작을 Robot 파일로 바꾸는 매크로 녹화기는 구현하지 않았습니다.** Python 내부의 세부 동작을 별도 타임라인으로 남기려면 해당 라이브러리에도 계측을 추가해야 합니다. SPICE 영상 녹화는 기존 세션의 화면을 재사용해야 하며, 별도 SPICE 클라이언트 연결은 제어 연결을 대체할 수 있습니다. 개인 계정 입력 구간은 녹화·자동 캡처 대상에서 제외하세요.

[Robot listener 공식 문서](https://robotframework.org/robotframework/latest/RobotFrameworkUserGuide.html#listener-interface)

## AI로 실패한 RPA 보정

`$spice-rpa-repair`는 대상 패키지의 Robot 진입점과 Python 라이브러리를 유지하면서 좌표·OCR 앵커·타이밍을 보정하는 개발 스킬입니다. [SKILL.md](../.agents/skills/spice-rpa-repair/SKILL.md)를 따릅니다. 먼저 `summary.json`과 실패 키워드를 확인하고, UI 변화가 확인된 경우에만 새 OCR·YOLO 근거로 수정합니다. 시스템 오류나 인증 대기를 좌표 문제로 취급하지 않습니다.

보정은 최대 2회 시도하며, 테스트·dry-run 결과와 실제 VM 재검증 여부를 별도로 기록합니다. 기존 성공 검증을 제거하거나 CAPTCHA를 풀지 않습니다. 자세한 명령은 [메인 README](../README.md#실패한-rpa의-ai-보정)에 있습니다.

## 사용자가 직접 만들거나 Recorder로 가져오기

- 빈 RPA 틀: `.venv/bin/python scripts/new_rpa.py my_task --guest-os windows11`
- 코드 기록 변환: `.venv/bin/python scripts/convert_recording.py ~/naver_login_rpa --id my_recorded_task --guest-os windows11`
- [전체 설명](../docs/RECORDING_CONVERSION.md) 및 `$spice-recording-convert` 스킬을 제공합니다.

Windows는 Win+R, Debian GNOME은 Alt+F2 같은 공통 실행기를 사용하고 바탕화면 아이콘 시작은 피합니다. 생성기는 기존 폴더를 덮어쓰지 않습니다. 기본 상태는 검토/구현 대기로, VM에 입력하지 않습니다. 원시 `recording.local.json`은 Git에 포함되지 않으므로 공유받은 쪽에서는 재생성하거나 정리된 동작을 작성해야 합니다.

## MCP와 모델 상주

[MCP 서버](../docs/VM_MCP.md)가 패키지를 호출할 수도 있습니다. VM별 호환 목록은 `config/vm-mcp.json`에서 관리하며, SPICE 주소는 실제 libvirt VM에서 확인합니다. [모델 워커](../docs/MODEL_BACKGROUND.md)는 첫 실제 연결에서 자동 시작해 RPA 종료 후에도 유지됩니다. dry-run이나 변환은 모델/VM을 시작하지 않습니다.

Hyper-V는 [별도 백엔드 폴더](../backends/hyperv/README.md)입니다. 이 폴더의 SPICE `common.resource`를 Hyper-V Robot 작업에서 import하지 않습니다.
