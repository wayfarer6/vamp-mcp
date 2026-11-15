# windows_naver_recorded

Generated from `naver_login_rpa` without executing source code.

- Guest: `windows11`, 1920×1080; source space: `guest`.
- Review `conversion.json` and the private `recording.local.json` before replay.
- `run.robot` controls the order; `workflow.py` and `recording_runtime.py` execute SPICE input.
- Default run returns `needs_review` without connecting to the VM.
- Explicit replay: `.venv/bin/python scripts/run_rpa.py windows_naver_recorded --var ALLOW_REPLAY:True --var SPICE_URI:<actual-guest-uri>`
- This refined Naver package verifies login-screen arrival with YOLO+OCR; it never claims an account was signed in.
- `recording.local.json` is excluded from Git because recorded keystrokes can contain credentials. Regenerate from a local source on a new checkout.
- See [conversion guide](../../docs/RECORDING_CONVERSION.md) for refinement and credential replacement.


## 추가한 목적 검증

이 패키지의 최종 목표는 **네이버 로그인 화면 도달**입니다. `workflow.py`의 `Verify Naver Login Reached`는 YOLO+OCR로 ID·비밀번호·로그인 버튼, 위치 관계와 `nid.naver.com`을 함께 검사합니다. 실제 계정을 입력하거나 로그인 제출을 수행하는 패키지가 아닙니다. 기본 `LANGUAGES`는 `ko,en`입니다.


## 실제 검증 기록

2026-11-15 Windows KVM 게스트에서 원본의 80개 동작을 한 번 재생해 로그인 화면에 도달했습니다. 처음에는 제목 NAVER와 ID placeholder가 한 YOLO 영역으로 합쳐져 정확 문자열 검증이 실패했습니다. 개별 OCR reading으로 필드를 찾도록 수정한 뒤 클릭을 다시 재생하지 않고 현재 화면을 재검사해 ID·비밀번호·로그인 영역과 도메인을 확인했습니다. 실제 자격 증명은 입력/제출하지 않았습니다.

원래 실패 기록: `artifacts/windows-naver-recorded-live/`; 수정 후 읽기 전용 확인: `artifacts/windows-naver-recorded-verification/`. 이 증거는 로컬 artifacts이며 Git에 포함하지 않습니다.
