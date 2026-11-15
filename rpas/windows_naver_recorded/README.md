# windows_naver_recorded

Generated from `naver_login_rpa` without executing source code.

- Guest: `windows11`, 1920×1080; source space: `guest`.
- Review `conversion.json` and the private `recording.local.json` before replay.
- `run.robot` controls the order; `workflow.py` and `recording_runtime.py` execute SPICE input.
- Default run returns `needs_review` without connecting to the VM.
- Explicit replay: `.venv/bin/python scripts/run_rpa.py windows_naver_recorded --var ALLOW_REPLAY:True --var SPICE_URI:<actual-guest-uri>`
- No application success is claimed unless an expected OCR text is configured; otherwise result is `replayed_unverified`.
- `recording.local.json` is excluded from Git because recorded keystrokes can contain credentials. Regenerate from a local source on a new checkout.
- See [conversion guide](../../docs/RECORDING_CONVERSION.md) for refinement and credential replacement.


## 추가한 목적 검증

이 패키지의 최종 목표는 **네이버 로그인 화면 도달**입니다. `workflow.py`의 `Verify Naver Login Reached`는 YOLO+OCR로 ID·비밀번호·로그인 버튼, 위치 관계와 `nid.naver.com`을 함께 검사합니다. 실제 계정을 입력하거나 로그인 제출을 수행하는 패키지가 아닙니다. 기본 `LANGUAGES`는 `ko,en`입니다.
