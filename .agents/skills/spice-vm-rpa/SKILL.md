---
name: spice-vm-rpa
description: Control an authorized SPICE VM desktop through Robot Framework, guest screenshots, YOLO UI detection and Korean, English, Japanese, Chinese PaddleOCR. Use for visual VM interaction without installing an automation agent in the guest.
---

Use the repository at `/home/ssh1032007/spice_kvm_based_rpa`, or the checkout containing this skill. Run commands from its root with `.venv/bin/python`. The OCR worker uses `.venv-ocr` (Python 3.12); do not import Paddle into the SPICE process. Read `README.md` for installation and command options if needed.

## Observe and act

- Inspect the active VM endpoint before connecting. The current Debian VM is `debian13`, `spice://127.0.0.1:5900`. A new SPICE connection may replace an existing viewer. Do not reboot or reconfigure the VM to reconnect.
- Capture with `.venv/bin/python rpa.py capture`. View the returned guest PNG with the image viewing tool.
- Analyze with `.venv/bin/python rpa.py analyze --languages ko,en,ja,zh`. This saves `artifacts/ui.json` and `artifacts/ui.annotated.png`. Inspect both. `elements` contain numbered YOLO regions, OCR-only text, coordinates in native guest pixels, click centers, confidence, and alternative language readings.
- YOLO identifies candidate UI regions, not accessible roles or button meanings. Infer a button's purpose using its text and the screenshot. An empty text label is unknown, not permission to guess.
- To click a unique visible label, use `.venv/bin/python rpa.py click-text '확인'`. This refreshes detection, requires an exact unique match and OCR confidence of at least 0.7, and checks that the target crop has not changed. If it is ambiguous or stale, inspect a fresh screenshot and choose a coordinate only when the target is clear.
- Coordinate clicks: `.venv/bin/python rpa.py click 800 500`. Coordinates are relative to the guest screen, never the virt-manager window. Do not reuse coordinates after layout changes.
- Keys: `.venv/bin/python rpa.py hotkey ctrl l`; `.venv/bin/python rpa.py write 'about:blank'`; `.venv/bin/python rpa.py hotkey enter`. Text entry assumes a US keyboard layout and supports ASCII; OCR recognition of CJK does not imply CJK text entry.
- Capture after each meaningful action and verify the visible result. Stop after two failed attempts at the same action and inspect the reason before proceeding. Keep actions within the user's requested task.

## Robot Framework

Run `.venv/bin/python -m robot --outputdir artifacts tests/launch_firefox.robot` for the Firefox launch scenario. This opens the GNOME Run dialog with Alt+F2 and types `firefox` over SPICE. Review the final screenshot as well as Robot's report; a successful input sequence alone does not prove the intended application opened.

Import `spice_robot.py` as a Robot library for `Analyze Guest UI`, `Click Guest Text`, `Click Guest Image`, `Guest Hotkey`, `Guest Write`, and `Capture Guest Screen` keywords. PyAutoGUI performs template matching on guest frames only; never call its host keyboard or mouse functions.

## Runtime boundaries

YOLO chooses CUDA when Torch reports it available, otherwise CPU; `--device cpu` forces CPU. PaddleOCR uses CPU in the isolated environment. First use downloads recognition models; later runs use the cache. Do not describe models as trained on this VM or claim automation is undetectable.

Absolute clicks require SPICE CLIENT mode. Relative motion is available through `Guest Move Relative` in SERVER mode, but guest pointer acceleration prevents a guaranteed pixel mapping. Do not simulate precise absolute clicks by assuming homing or split deltas eliminate acceleration error.
