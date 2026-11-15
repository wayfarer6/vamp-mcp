---
name: spice-naver-login
description: "Run the Naver login RPA package: Robot entrypoints call Python YOLO/OCR field detection and SPICE credential input, with a private user credential dialog and CAPTCHA handoff."
---

Work from `/home/ssh1032007/spice_kvm_based_rpa` or the checkout. The package is `rpas/naver_login/`: `manifest.json`, `run.robot`, `login.robot`, `workflow.py`. Robot owns task order/branching; Python owns field coordinates, vision and credential input. Read `rpas/README.md` for its contract.

## Detect without submitting

Run `.venv/bin/python scripts/run_rpa.py naver_login`. This selects `run.robot` and only detects the form. Read `artifacts/rpas/naver_login/summary.json` first; full empty-form evidence is under `artifacts/rpas/naver_login/login/`.

Detection requires OCR of ID/username, password and sign in, vertical field/button geometry, one matching form, OCR confidence ≥0.7 and visible `nid.naver.com`. Require `needs_credentials` with `origin_verified: true`. On failure inspect permitted evidence and stop instead of guessing coordinates. English locale avoids missing guest CJK fonts; `--var LANGUAGES:ko,en,ja,zh` enables multilingual inspection.

## Submit only for an authorized login request

When credentials are needed, explain: “로그인 화면에 도착했습니다. 호스트의 비공개 입력창에 ID와 비밀번호를 입력하면 제가 SPICE로 VM 입력란에 넣고 로그인 버튼을 누르겠습니다.”

Run `.venv/bin/python scripts/run_rpa.py naver_login --entry login --var CREDENTIAL_SOURCE:prompt`. This explicitly selects `login.robot`. Python uses getpass in a local terminal or Zenity in a noninteractive process; keep the command running while the user enters credentials. Do not pass private passwords through Robot variables, command arguments or generic desktop-write keywords.

If the execution environment already supplies the authorized `NAVER_ID` and `NAVER_PASSWORD`, use `--entry login` without the prompt variable. Do not print these values, probe other credentials or write them into files/history. The public VM root test password is unrelated to private Naver credentials.

Python checks the unchanged form before filling, clicks submit once and checks post-submit OCR using temporary files that are removed. Do not add screenshots, video recording or generic argument logging around credential entry. ASCII/US keyboard input is currently required; CJK recognition is not CJK input support.

## Completion and user handoff

Report success only for `logged_in` based on recognized logout UI. `submitted_unverified` means success was not proven. `needs_user_captcha`/`needs_user_verification` publishes a handoff result and SKIPs the Robot task so the user can act; it is not a successful login.

Apply `spice-captcha-handoff/SKILL.md` for either handoff. Stop input, ask the user to complete it in the VM, and recheck only after they report completion. Do not navigate back to the login URL for a challenge recheck, auto-retry credentials or solve CAPTCHA.

The existing `rpa.py login` CLI remains compatible. Prefer the package's `.robot` entrypoints for new work and future task-level recording hooks.
