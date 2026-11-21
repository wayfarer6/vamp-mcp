# Recorded click verification · 녹화 클릭 검증

**한국어.** 게스트 녹화기에서 저장할 때 버튼 글자(예: 저장) 또는 전용 탐지 클래스(예: `yolo:save-icon`)를 지정합니다. 기존 녹화는 소스를 검토하고 아래 주석을 추가하여 새 리비전을 저장하세요. 대상이 비어 있는 기존 녹화는 기본 설정에서 해당 클릭 전에 멈춥니다.

**English.** Enter the visible label or a specific detector class when saving a guest recording. A reviewed recording may also specify its target in a trailing comment. The converter reads the source as data.

```python
import pyautogui
pyautogui.click(430, 250)  # vamp-target {"ocr":"저장"}
pyautogui.click(525, 250)  # vamp-target {"yolo":"save-icon"}
```

| Guest observation | Replay |
| --- | --- |
| One exact label or class, score ≥ selected minimum, in the recorded area | Move to the target, compare a second capture of its region, then press. |
| Missing target, score below minimum, or changed pixels after moving | Read one fresh frame and repeat the check once. A second failure stops later input. |
| Duplicated label, changed resolution, target too far away, unavailable detector or missing reviewed target | Stop immediately. |
| Verification explicitly disabled | Send the recorded coordinates. Other configured replay and approval checks still apply. |

The score is the detector output. Actual success depends on the application, recording and screen. The comparison uses the full score before display rounding. A YOLO class must be supported by the configured local model. Generic icons require a reviewed specific detector or an OCR label.

**설정.** VS Code 명령 팔레트에서 **VAMP: Find and Export RPA** → **Recorded click verification**을 엽니다. 백분율을 입력하고 저장하면 해당 카탈로그의 이후 실행에 적용됩니다. 체크를 해제하고 저장하면 좌표 재생을 사용합니다. 실패한 실행의 재시작은 이미 완료한 작업을 반복할 수 있으므로 시작 화면을 확인하세요.

**MCP.** Read the catalog setting with `rpa_click_settings({})`. To save a user-requested default, call it with `{"minimum_percent":95,"user_requested":true}`. For one run, add `{"click_minimum_percent":95,"click_setting_user_requested":true}` to the usual `rpa_run_saved`, `kvm_rpa_run` or `remote_rpa_run` arguments. Zero disables verification. A run override expires at the end of that run. After a block, report the reason and score and ask the user how to proceed. The system does not automatically lower the threshold or switch to coordinate replay.

**VeraCrypt (Windows).** 기본 볼륨, 연결된 KeePassXC 항목, WSL 배포판과 빈 마운트 폴더를 한 번 설정하면, 승인된 마운트마다 저장된 키를 CLI 표준입력으로 전달합니다. Vault 잠금 해제와 볼륨 키는 별개의 단계입니다. [Vault setup](../vscode-vault-extension/README.md)
