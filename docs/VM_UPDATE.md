# Debian VM apt update RPA 실행 가이드

`debian_update` 패키지를 호출하면 로컬 SPICE·OCR 코드가 Debian의 패키지 목록을 갱신하고 결과를 요약해 반환합니다. 상세 구현을 매번 읽지 않고 작업을 다시 쓰는 예시입니다.

```bash
cd /home/ssh1032007/spice_kvm_based_rpa
.venv/bin/python scripts/run_rpa.py debian_update
```

구성: `rpas/debian_update/run.robot` → `rpas/debian_update/workflow.py` → 공통 SPICE/OCR 엔진. 결과는 `artifacts/rpas/debian_update/summary.json`, 전체 OCR 기록은 그 아래 `update/result.json`에 저장됩니다. [패키지 규격 README](../rpas/README.md)에 변수·보고서·확장 방법을 정리했습니다. 아래는 계속 사용할 수 있는 기존 CLI의 상세 실행법입니다.

호스트 터미널에서 RPA를 실행하면 SPICE 키보드 입력으로 게스트 Debian의 터미널을 열고 `su root` → `apt update`를 수행합니다. 화면 상태와 실행 결과는 로컬 PaddleOCR 텍스트로 판별합니다. AI 서비스나 멀티모달 화면 판독 없이도 실행할 수 있습니다.

## 1. 실행 전 준비

[설치 절차](INSTALL.md)로 `.venv`와 `.venv-ocr`를 준비한 뒤 호스트 터미널에서 저장소로 이동합니다. 아래 경로와 VM 주소는 개발 환경의 예시입니다.

```bash
cd /home/ssh1032007/spice_kvm_based_rpa
```

- `debian13` VM이 실행 중이고 Debian GNOME 데스크톱에 로그인되어 있어야 합니다. 잠금 화면은 먼저 해제하세요.
- 예시 SPICE 주소는 `spice://127.0.0.1:5900`입니다. 실제 VM 주소를 확인해 설정 파일과 실행 인자를 맞추세요.
- 게스트 키보드는 US 영문 입력 상태로 두세요.
- 실행 중에는 VM에 직접 키보드·마우스 입력을 하지 마세요. 다른 RPA도 동시에 실행하지 마세요.
- 새 SPICE 연결은 기존 virt-manager 뷰어 연결을 대체할 수 있습니다. 실행 중 뷰어를 재연결하면 RPA가 끊길 수 있습니다.
- PyAutoGUI import에 필요한 호스트 GUI 세션의 `DISPLAY`, `XAUTHORITY`를 사용할 수 있는 터미널에서 실행하세요. `sudo`로 호스트 RPA를 실행할 필요는 없습니다.

설치가 안 된 다른 호스트에서는 [설치 절차](INSTALL.md)를 먼저 따르세요. 이 업데이트 작업에는 YOLO 모델이나 GPU가 필요하지 않으며, OCR은 별도 Python 3.12 환경의 CPU로 실행됩니다. OCR 모델은 최초 실행 시 다운로드될 수 있습니다.

## 2. VM 설정 확인

[config/sandbox-vm.json](../config/sandbox-vm.json)이 현재 공개 테스트 VM 설정입니다.

| 항목 | 값 |
| --- | --- |
| VM 이름 | `debian13` |
| SPICE 주소 | `spice://127.0.0.1:5900` |
| 게스트 호스트명 | `debian` |
| 관리자 계정 | `root` |
| 공개 테스트 비밀번호 | `password123!` |

이 비밀번호는 소유자의 요청으로 Git에 공개 기록한 테스트 자격 증명입니다. 스크립트가 파일에서 읽으므로 실행할 때 비밀번호를 다시 입력하지 않습니다.

## 3. 가장 간단한 실행

```bash
.venv/bin/python rpa.py vm-update
```

활성화 명령(`source .venv/bin/activate`)은 생략해도 됩니다. 콘솔에는 짧은 요약 JSON만 출력되며, 상세 결과는 `artifacts/vm-update/result.json`에 저장됩니다. 여러 OCR 단계를 처리하므로 실행 중 출력이 한동안 없을 수 있습니다.

실행 흐름은 다음과 같습니다.

1. SPICE 입력·화면 채널에 연결합니다.
2. `Ctrl+Alt+T`를 누르고 OCR로 터미널을 확인합니다. 열리지 않으면 `Alt+F2`에서 `gnome-terminal --maximize`를 실행합니다.
3. 셸 명령 실행 결과로 현재 UID를 검사합니다.
4. 일반 사용자라면 `su root`를 입력하고 OCR로 `Password:`를 확인한 뒤 설정 비밀번호를 입력합니다.
5. root 프롬프트와 UID 확인 결과를 OCR로 검증합니다.
6. `apt update` 출력을 게스트 `/tmp/spice-rpa-apt-<실행식별자>.log`에 기록하고 마지막 16줄과 종료 결과 표식을 화면에 출력합니다.
7. OCR로 성공·경고·실패를 판별하고, 명령이 끝났으면 `exit`로 root 셸을 나옵니다.

표식은 8진수 이스케이프로 출력합니다. 화면에 입력 명령이 에코된 것만으로 성공했다고 판정하지 않습니다. `apt update`는 패키지 목록 갱신이며, 패키지 업그레이드나 재부팅은 수행하지 않습니다.

## 4. 결과 확인

기본 반환값은 다음 형태입니다. `events`와 전체 OCR 텍스트는 콘솔에 출력하지 않습니다.

```json
{
  "status": "succeeded",
  "verification": "ocr_only",
  "command": "apt update",
  "root_verified": true,
  "root_shell_exited": true,
  "details_path": "/home/ssh1032007/spice_kvm_based_rpa/artifacts/vm-update/result.json"
}
```

실패·경고·검증 불가 상태에는 최대 300자의 `error_summary`가 추가됩니다. root 셸 종료를 확인하지 못한 단계에서는 `root_shell_exited`가 `null`입니다. 요약은 `artifacts/vm-update/summary.json`, 전체 단계별 기록은 기존 `artifacts/vm-update/result.json`에 저장됩니다. Robot 라이브러리 반환값도 동일한 요약 형식입니다.

```bash
# 저장된 요약 확인: VM 작업을 다시 실행하지 않음
.venv/bin/python -m json.tool artifacts/vm-update/summary.json

# 디버깅: VM 업데이트를 실행하고 콘솔에도 전체 OCR 기록 출력
.venv/bin/python rpa.py vm-update --full-result
```

전체 기록만 확인하려면 아래 명령을 사용하세요. VM 작업을 다시 실행하지 않습니다.

```bash
.venv/bin/python -m json.tool artifacts/vm-update/result.json
```

| `status` | 의미 |
| --- | --- |
| `succeeded` | apt 종료 상태 0의 성공 표식을 OCR로 확인 |
| `completed_with_warnings` | 성공 표식은 확인했지만 저장소 관련 경고도 검출 |
| `failed` | apt의 실패 표식을 확인 |
| `terminal_not_verified` | 터미널을 확인하지 못함 |
| `shell_execution_not_verified` | 셸의 확인 명령 결과를 읽지 못함 |
| `password_prompt_not_verified` | 숨김 비밀번호 입력 프롬프트를 확인하지 못함 |
| `root_authentication_not_verified` / `root_identity_not_verified` | root 인증·UID 검증 실패 |
| `timed_out_unverified` | 제한 시간 내 종료 표식을 확인하지 못함 |

`verification`은 `ocr_only`, root 검증 후에는 `root_verified`가 `true`로 기록됩니다. 정상적으로 완료된 흐름에서는 `root_shell_exited`로 일반 사용자 셸 복귀 확인 여부도 기록합니다. 상세 파일의 `events`에는 단계별 OCR 텍스트와 캡처 파일 경로가 있습니다.

**CLI 프로세스의 종료 코드 0만으로 apt 성공을 판단하지 마세요.** 현재 CLI는 `status: failed` 결과도 JSON으로 출력하고 정상 종료할 수 있습니다. `status`를 확인해야 합니다. 연결 오류 등은 Python 예외로 종료됩니다.

## 5. Robot Framework로 실행

```bash
.venv/bin/python -m robot --outputdir artifacts/update-run tests/vm_update.robot
```

이 예시는 `status == succeeded`일 때만 PASS입니다. apt가 실패하거나 경고 상태이면 Robot도 FAIL입니다. 보고서는 `artifacts/update-run/report.html`, 실행 로그는 `artifacts/update-run/log.html`입니다. OCR 증거는 기본 `artifacts/vm-update/`에 저장됩니다.

## 6. 실행 옵션과 증거 보관

```bash
# 결과를 별도 폴더에 보관하고, apt 결과 대기 시간을 600초로 설정
.venv/bin/python rpa.py vm-update --timeout 600 --output artifacts/vm-update-manual-01

# 다른 설정 파일을 사용할 때: 연결 주소와 설정 파일의 uri가 일치해야 함
.venv/bin/python rpa.py --uri spice://127.0.0.1:5901 vm-update --config config/my-sandbox-vm.json

# 사용 가능한 옵션만 확인; VM에는 연결하지 않음
.venv/bin/python rpa.py vm-update --help
```

기본 출력 폴더를 반복 사용하면 같은 이름의 결과·증거 파일을 덮어씁니다. 실행별 기록이 필요하면 매번 다른 `--output` 폴더를 지정하세요. `--timeout`은 apt 결과 확인 루프의 제한 시간이며, 연결·터미널 열기·인증·개별 OCR 처리 시간을 모두 포함한 전체 제한 시간은 아닙니다.

## 7. 초기 검증에서 확인된 오류

2026-11-15 초기 실행에서는 root 전환과 apt 실행을 OCR만으로 확인했지만, apt 결과는 `failed`였습니다.

```text
The repository 'cdrom://[Debian GNU/Linux 13.7.0 ...] trixie Release' does not have a Release file.
```

이 기록은 설치 DVD 저장소 설정이 남아 있던 초기 환경의 오류입니다. 이후 사용자는 성공 결과를 보고했으므로 현재 결과는 새 실행의 summary.json으로 확인하세요. 이 상태에서 실행하면 같은 오류와 Robot FAIL이 다시 나올 수 있습니다. RPA는 저장소 설정을 자동 수정하지 않습니다. 해당 실행의 게스트 로그는 `/tmp/spice-rpa-apt-qrfpzy.log`입니다.

## 8. 중단·연결 문제

- `Another RPA session controls this SPICE endpoint`: 기존 작업이 끝난 뒤 실행하세요.
- `SPICE channel closed`: 다른 뷰어가 연결을 가져갔는지 확인하세요.
- 터미널·root 검증 실패: 단계별 `*.ocr.json`과 `result.json`을 확인하세요. 비밀번호는 자동 재시도하지 않습니다.
- 타임아웃이나 `Ctrl+C` 중단: 호스트 RPA가 끝나도 게스트 apt 명령이나 root 셸은 남아 있을 수 있습니다. VM에서 현재 명령의 상태를 먼저 확인한 뒤 재실행하세요.

관련 구현: [vm_update.py](../vm_update.py), [Robot 예시](../tests/vm_update.robot), [VM 업데이트 스킬](../.agents/skills/spice-vm-update/SKILL.md).
