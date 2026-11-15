---
name: spice-captcha-handoff
description: Detect CAPTCHA or additional verification instructions through multilingual OCR in a SPICE VM, stop automation, guide the user to complete it manually, and recheck afterward. Use when login RPA returns needs_user_captcha or needs_user_verification.
---

Work from `/home/ssh1032007/spice_kvm_based_rpa` or the checkout containing this skill. `rpa.py check-verification` captures the current guest frame and runs local PaddleOCR in Korean, English, Japanese and Chinese. It does not navigate, type or click. Inspect the returned JSON, not a multimodal view, when OCR-only operation is requested.

The login RPA checks for challenge instructions before credential entry and after submission. For `needs_user_captcha` or `needs_user_verification`, stop automated input immediately and tell the user:

“보안 확인 화면이 감지되어 자동화를 멈췄습니다. VM 창에서 CAPTCHA나 추가 인증을 직접 완료한 뒤 ‘완료’라고 알려주세요. 완료 후 제가 화면 상태를 다시 확인하겠습니다.”

Leave the page as it is. Disconnecting the RPA releases its session lock so the user can reconnect their viewer if needed. Do not keep polling, reload the page, resubmit credentials, click challenge controls, extract challenge characters, answer a challenge, or route the challenge to another model/service.

After the user explicitly reports completion, run `.venv/bin/python rpa.py check-verification` once. If challenge text is still detected, report it and keep the handoff active. `no_challenge_text` means no instruction phrase was recognized; it is not proof that the challenge is gone or login succeeded. Before resuming, require positive OCR evidence of the expected next screen. A visible logout control can support login success; a verified login form can support credential entry only when the user requested that step. Do not navigate back to the login URL just to recheck a challenge, since that can discard the user's progress.

The detector matches instructional phrases such as CAPTCHA, “I'm not a robot”, 보안문자, 画像認証 and 图形验证码, not the challenge solution. Purely graphical challenges, missing fonts and low-quality OCR can be missed. For uncertain screens, report an unverified state rather than assuming clearance.
