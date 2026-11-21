# Recorded click verification · 녹화 클릭 검증

### Add YOLO checks after a manual demonstration

1. In the guest recorder, select **Keep button crops in this guest for later YOLO review** and start recording. Click the button yourself or run your own PyAutoGUI script on the same desktop. Stop and choose **Save Python**. The save dialog reports how many click images are available. Up to 120 crops, including any nearby text, stay in the guest account under `~/.vamp/recorder-captures`.
2. Later, choose **Generate YOLO draft** in the same guest account and open the exact saved recording. **Yes** adds checks to a copy of the recording. **No** lets you select your own Python source. Its single-line literal PyAutoGUI clicks must match the recorded guest coordinates, buttons and order. Review each image and enter a specific class supported by the installed detector. A blank skips the click. Cancel discards the draft.
3. Review the new `*_yolo_*.py` in RPA Library and save it as a skill. VAMP converts the annotations to runtime checks. A crop alone does not train the detector. Check the final application state separately. **Manual recording does not generate fallback code.** With verification enabled, a failed check stops replay.
4. In VirtualBox, call `vm_recording_share` with `action="inspect"` and the same VM identifier used to prepare the share to list raw files. Search registered skills with `rpa_search`. Set `language="ko"` or `"en"` on `vm_recording_share` or `rpa_details` for the manual recording notice. The default returns both.

### 수동 시연 뒤에 YOLO 검증 추가하기

게스트 레코더에서 **Keep button crops in this guest for later YOLO review**를 선택하고 녹화를 시작하세요. 직접 버튼을 누르거나 같은 데스크톱에서 PyAutoGUI 코드를 실행한 뒤 **Stop → Save Python**을 누릅니다. 저장 창에서 캡처 수를 확인하세요. 주변 글자가 들어갈 수 있는 이미지가 최대 120개까지 게스트 계정에 보관됩니다.

나중에 같은 계정에서 **Generate YOLO draft**로 저장한 원본을 엽니다. **Yes**는 녹화본의 복사본에, **No**는 별도로 선택한 스크립트의 복사본에 검증을 붙입니다. 별도 스크립트는 한 줄짜리 리터럴 클릭의 좌표·버튼·순서가 녹화와 일치해야 합니다. 각 이미지를 보고 모델이 지원하는 구체적인 클래스 이름을 입력하세요. 빈칸은 건너뛰기, 취소는 초안 폐기입니다. 새 파일을 RPA Library에서 검토하고 저장하세요. **수동 시연만으로 폴백 코드는 생성되지 않습니다.** 검증을 켠 상태에서 대상 확인에 실패하면 재생이 멈춥니다. 업무 성공 여부는 별도의 결과 검사로 확인하세요.

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
