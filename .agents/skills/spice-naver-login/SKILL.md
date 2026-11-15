---
name: spice-naver-login
description: Open the Naver login page in a SPICE VM, detect the ID/password fields with YOLO and OCR, request credentials through a local private dialog, and submit through SPICE. Use when asked to run the visual Naver login RPA or handle its needs_credentials state.
---

Work from `/home/ssh1032007/spice_kvm_based_rpa` or the checkout containing this skill. Use `.venv/bin/python`; PaddleOCR runs in `.venv-ocr`. The default endpoint is `spice://127.0.0.1:5900`.

Run `.venv/bin/python rpa.py login` to open Firefox, navigate to Naver's English login page, and detect the form. This does not enter credentials or submit. Inspect `artifacts/login/state.json` and `artifacts/login/ui.annotated.png`.

The deterministic detector requires all three OCR labels (ID/username, password, sign in), vertical field/button alignment, a unique matching form, OCR confidence ≥0.7, and visible `nid.naver.com` in the browser address. The output must be `needs_credentials` with `origin_verified: true` before filling anything. If detection fails, inspect the current image and stop rather than guessing field coordinates. The English locale avoids missing guest CJK fonts; recognition of Korean/Japanese/Chinese remains available through `--languages ko,en,ja,zh`.

When the user requested login execution and the form is ready, explain: “로그인 화면에 도착했습니다. 호스트의 보안 입력창에 ID와 비밀번호를 입력하면 제가 SPICE로 VM의 로그인 입력란에 넣고 로그인 버튼을 누르겠습니다.” Then run `.venv/bin/python rpa.py login --prompt-credentials`. In a noninteractive process it opens a host Zenity form with a hidden password field; in a local terminal it uses getpass. Keep the command running while the user enters the credentials. No secrets need to appear in chat, command arguments, Robot variables, or files.

If the current execution environment already supplies the authorized account through `NAVER_ID` and `NAVER_PASSWORD`, use `rpa.py login --use-env`. Do not print those variables, read unrelated credentials, put them into shell history, or echo them into the tool transcript. The Robot example uses the same environment lookup internally.

The submit routine verifies that the form has not changed, fills each detected field via SPICE physical keys, clicks the detected submit button once, and checks the result using temporary OCR files that are removed. It does not persist a screenshot containing the entered ID. Do not add screenshots or generic Robot input keywords around credential entry.

Only report successful login for `logged_in` (a visible logout control was recognized). `submitted_unverified` means submission happened but success is unproven. `needs_user_captcha` or `needs_user_verification` means the user must finish CAPTCHA/OTP or another verification in the guest. Do not auto-retry credentials or bypass verification. When only asked to build the RPA, validate through form detection and leave credential submission for an authorized execution.

The current key backend accepts printable ASCII with a US guest keyboard layout. Validate before entering either field; do not claim CJK password entry support. Avoid using the host mouse/keyboard through PyAutoGUI: it is only for guest image matching. Do not control the VM concurrently with the user or a second SPICE client.

For either handoff state, apply the adjacent `spice-captcha-handoff/SKILL.md`: stop automated input, ask the user to complete the challenge in the VM, and recheck only after they report completion. The `check-verification` CLI performs OCR only and does not navigate or resubmit.
