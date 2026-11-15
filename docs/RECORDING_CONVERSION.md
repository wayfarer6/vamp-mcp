# 수동 작성과 Recorder → Robot/SPICE 변환

이 도구들은 일반 사용자도 실행할 수 있는 공개 Python CLI입니다. AI 없이 폴더를 만들거나 기록을 변환하고, 필요한 부분만 직접 수정할 수 있습니다. requirements는 기존 설치 안내를 따릅니다. 명령은 저장소 루트의 호스트 터미널에서 실행합니다.

## A. 직접 RPA 폴더 만들기

```bash
.venv/bin/python scripts/new_rpa.py my_windows_task --guest-os windows11
# Debian GNOME용
.venv/bin/python scripts/new_rpa.py my_debian_task --guest-os debian
```

`rpas/<id>/`에 다음 파일이 생성됩니다. 기존 폴더는 덮어쓰지 않습니다.

| 파일 | 수정할 내용 |
| --- | --- |
| `manifest.json` | 이름·버전·진입점·의존성 |
| `run.robot` | 작업 순서·분기·성공 검증 |
| `workflow.py` | 프로그램 기동, 좌표, SPICE 입력, OCR·YOLO 처리 |
| `README.md` | 개별 RPA 사용법 |

초기 상태는 `not_configured` + SKIP이며 VM에 연결하지 않습니다. Robot 파일의 안내에 따라 `Spice.Connect Spice`, 전용 Python 키워드와 긍정적인 성공 검증을 추가하세요. Python의 `Launch Program` 키워드는 이미 공통 실행기를 사용하도록 작성되어 있습니다.

**Windows는 Win+R → 실행 명령, Debian GNOME은 Alt+F2 → 실행 명령을 우선 사용하세요.** 바탕화면 아이콘은 사용자별로 다르므로 프로그램 시작 좌표로 쓰지 않습니다. 프로그램을 여는 동작과 실제로 열렸는지 확인하는 동작은 구분해야 합니다.

```bash
.venv/bin/python scripts/run_rpa.py my_windows_task --dryrun
.venv/bin/python scripts/run_rpa.py my_windows_task --var SPICE_URI:spice://127.0.0.1:5900
```

두 번째 명령도 템플릿을 수정하기 전에는 SKIP입니다. `SPICE_URI`는 실제 대상 VM 주소로 바꾸세요.

## B. 게스트 안에서 기록한 PyAutoGUI 코드 변환

Windows VM 안에서 Recorder를 실행하고 프로그램을 Win+R로 여는 것부터 기록하세요. 기록 당시 게스트 해상도, Windows 배율, 브라우저 확대율을 메모하고 재생 시에도 유지합니다. 기록 파일을 호스트로 복사합니다. 확장자가 없어도 Python 코드이면 읽습니다.

이번 입력 파일은 `/home/ssh1032007/naver_login_rpa`이며 다음 명령으로 변환했습니다.

```bash
.venv/bin/python scripts/convert_recording.py ~/naver_login_rpa \
  --id windows_naver_recorded \
  --guest-os windows11 --coordinate-space guest --width 1920 --height 1080
```

이 패키지는 이미 생성되어 있습니다. 다시 변환하려면 `--id windows_naver_recorded_v2`처럼 새 이름을 사용하세요. 원본과 기존 수동 수정 파일은 덮어쓰지 않습니다.

### 생성 결과

```text
rpas/windows_naver_recorded/
├── manifest.json
├── run.robot                  # Robot 순서·반복·정리·성공 확인
├── workflow.py                # Python 실행/검증 어댑터
├── conversion.json            # 원본 해시·통계·주의 사항; 원문 문자열 없음
├── recording.local.json       # 좌표·키 이벤트·대기; 로컬 전용, Git 제외
└── README.md
```

변환기는 원본을 import·실행·eval하지 않고 AST와 리터럴 인자만 해석합니다. 80개 동작을 변환했고 `cmd` → Windows/Super, `shift_r` → 오른쪽 Shift로 정규화했습니다. 원본의 Win+R 시작도 확인했습니다. 기록 끝에 해제되지 않은 키 1개가 있어 정리 단계에서 남은 키를 해제하도록 했습니다. 좌표는 게스트 원본 픽셀 그대로 유지했습니다.

지원: `keyDown`, `keyUp`, `press`, `hotkey`, ASCII `write`/`typewrite`, 명시적 x/y의 클릭·더블/오른쪽/가운데 클릭, `moveTo`, `scroll`, `time.sleep`/`pyautogui.sleep`. 모듈 별칭과 단순 `__main__` 가드도 지원합니다. 동적 인자·임의 Python문·루프·함수 호출·드래그·시간을 지정한 마우스 이동 등은 현재 자동 변환하지 않고 중단합니다. 지원하지 않는 동작을 조용히 버리지 않습니다.

### 먼저 확인하고 재생하기

```bash
.venv/bin/python scripts/run_rpa.py windows_naver_recorded --dryrun
# 기본 실행: needs_review + SKIP, VM에 연결하지 않음
.venv/bin/python scripts/run_rpa.py windows_naver_recorded

# 실제 주소 확인: VM이 실행 중이어야 함
virsh -c qemu:///system domdisplay windows-RPA

# 내용을 검토한 뒤 명시적으로 활성화. 아래 포트는 실제 조회 결과로 대체
.venv/bin/python scripts/run_rpa.py windows_naver_recorded \
  --var ALLOW_REPLAY:True --var SPICE_URI:spice://127.0.0.1:5900
```

해상도가 기록과 다르거나 절대 좌표를 보낼 CLIENT 모드가 아니면 입력 전에 중단합니다. 해상도 일치만으로 Windows/Debian 구분이나 배율 일치를 보장하지 않으므로 VM 주소와 화면 상태도 확인하세요. 재생 중에는 VM을 직접 조작하지 마세요.

일반 변환 패키지는 입력만 끝나면 `replayed_unverified`를 반환합니다. `EXPECTED_TEXT`를 지정하면 임시 화면의 OCR로 기본 확인을 할 수 있지만, 한 단어가 보이는 것만으로 모든 업무 성공을 보장하지는 않습니다.

이번 `windows_naver_recorded`에는 **네이버 로그인 화면 도달** 전용 검증을 별도로 추가했습니다. YOLO 영역과 OCR을 결합해 ID·비밀번호·로그인 문구의 위치 관계, 브라우저의 `nid.naver.com`, 해당 대상 중 최소 하나의 YOLO 영역을 함께 확인합니다. 홈페이지에도 로그인 버튼이 있으므로 버튼 하나만으로 성공 처리하지 않습니다. `login_submitted: false`이며 실제 계정 로그인 성공을 뜻하지 않습니다. CAPTCHA 문구가 검출되면 사용자 인계로 멈춥니다.

### 조금 손볼 곳

1. `conversion.json`의 경고를 확인하고 현재 VM의 해상도·배율과 맞춥니다.
2. 기록의 클릭 위치를 `recording.local.json`에서 조정하거나 Python의 OCR·YOLO 대상 찾기로 교체합니다. 고정 대기는 가능한 경우 예상 화면을 기다리는 조건으로 바꿉니다.
3. 프로그램 기동이 바탕화면 클릭이면 Win+R/Alt+F2로 바꿉니다. 기록에 이미 공통 실행기가 있으면 그대로 유지합니다.
4. 계정·비밀번호를 입력한 구간은 키 이벤트까지 포함해 제거하고 전용 자격 증명 루틴으로 바꿉니다. 런타임의 `{"op":"write_env","env":"NAVER_PASSWORD"}` 형식도 사용할 수 있지만 입력란 검증과 제출·인계 절차는 별도로 유지해야 합니다.
5. 마지막에 실제 목표 화면의 긍정적인 검증을 추가합니다. `executed`나 `replayed_unverified`를 그냥 `succeeded`로 바꾸지 않습니다.

Robot은 현재 데이터 파일의 이벤트 개수를 읽어 순서대로 호출하므로, 데이터에서 이벤트를 추가·삭제해도 고정 인덱스 목록을 다시 만들 필요는 없습니다. 더 높은 수준의 작업으로 정리하려면 이벤트 반복을 프로그램 기동·페이지 이동·폼 확인 같은 Python 키워드 호출로 나누면 됩니다.

### 기록 데이터와 공유

키를 하나씩 누른 기록도 비밀번호를 재구성할 수 있습니다. 원본·실제 입력 데이터는 자동으로 Git에 추가하지 않습니다. `recording.local.json`은 권한 0600으로 만들고 `.gitignore`에서 제외합니다. 다른 사람이 Git만 clone하면 이 로컬 데이터는 없으므로 자신의 기록에서 재생성하거나, 민감 내용을 제거한 공유용 동작을 직접 작성해야 합니다. 이 단계의 자동 생성 결과는 **로컬에서 검토할 초안**입니다.

## C. 호스트 뷰어 위에서 기록했다면

뷰어 창 전체가 아닌 **실제 게스트 영상 영역**의 `LEFT TOP WIDTH HEIGHT`가 필요합니다. 타이틀바·도구모음·검은 여백을 제외하고 Recorder와 같은 좌표 단위로 측정하세요.

```bash
.venv/bin/python scripts/convert_recording.py ~/host_recording.py \
  --id my_host_recording --guest-os windows11 --coordinate-space host \
  --viewport 100 80 1280 720 --width 1920 --height 1080
```

이 수치는 예시이며 실제 영역으로 바꿔야 합니다. 변환식은 `guest_x = (host_x - LEFT) × guest_width / WIDTH`이고 y도 같습니다. 영역 밖 클릭은 거부합니다. DPI/논리 픽셀이 섞여 있거나 녹화 중 창이 움직인 경우에는 이 단일 변환으로 복원할 수 없으므로 다시 기록하거나 구간별로 보정해야 합니다.

## AI에게 맡길 때

`$spice-recording-convert` 스킬을 사용합니다.

> 홈 폴더의 naver_login_rpa를 실행하지 말고 정적 분석해서 Windows용 Robot/SPICE 패키지로 변환해줘. Windows는 Win+R을 사용하고, 좌표·대기·성공 검증을 검토해줘.

실패한 좌표를 이후 보정할 때는 `$spice-rpa-repair`로 최신 OCR·YOLO 근거를 확인합니다. 변환 자체는 AI API를 호출하지 않습니다. 동영상/매크로를 직접 기록하는 Recorder도 이 프로젝트에서 새로 구현한 것은 아니며, 사용자가 제공한 코드 파일을 변환합니다.
