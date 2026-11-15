# GUI 동작 레코더 설치와 저장

`third_party/pyautogui-recorder`에는 PyAutoGUI-Recorder 원본을 보존합니다. 상류 `axel-magard/PyAutoGUI-Recorder`, SHA `6cd48a3bee4ef4dd382e3484feaa4360a37a0a5d`, **GPL-3.0**입니다. 원본 소스/이미지/LICENSE는 수정하지 않았고, MIT 설치기가 별도 게스트 프로그램으로 실행합니다.

GUI 레코더는 클릭과 키 입력을 Python으로 남깁니다. 기록을 검토하고 RPA로 변환하면 AI가 다음 작업에서 패키지 ID로 다시 실행할 수 있습니다. [재사용 흐름](WORKFLOWS.md)

Windows 11을 쓸 때는 설치 ISO·라이선스를 직접 준비하고 정품 인증도 사용자가 해야 합니다. 레코더 설치에 Windows 라이선스는 포함되지 않습니다.

## 새 VirtualBox VM

MCP `vm_create`는 OS 설치 ISO를 감지하고 전용 레코더 ISO를 추가한 뒤 VirtualBox unattended 설치를 시작합니다. 사용자에게 호스트 ISO 경로를 물어 한 번 호출하면 설치 절차는 AI 없이 계속됩니다. 기본 계정은 **vboxuser / password123!**이며 공개 정보입니다.

- Debian: postinstall 스크립트가 GNOME/Xorg, Python/Tk 의존성을 설치하고 `vboxuser`의 `Desktop/RPA-Recorder`와 전용 venv/실행기를 만듭니다. 녹화를 위해 새 VM의 GDM Wayland를 비활성화합니다. sudo 권한은 OS 패키지 설치 단계에만 사용하며, 레코더는 사용자 계정으로 실행합니다.
- Windows 11: postinstall이 `C:\ProgramData\RPA-Recorder-Setup`에 설치 파일을 복사하고 `vboxuser` Startup 실행기를 둡니다. 해당 사용자의 **최초 바탕화면 로그인 시** winget/Python 설치, 실제 바탕화면 경로 확인, `RPA-Recorder` 폴더/venv/실행기 구성을 수행합니다. 성공 시 Startup 실행기를 제거합니다. winget/네트워크/첫 로그인 상태에 따라 실패할 수 있으며 실제 장비 검증 전입니다.

레코더가 임의로 녹화를 시작하지는 않습니다. 초기 OS 설치 성공·레코더 설치 완료는 아직 자동 검증하지 않으므로 MCP의 verified 필드는 false로 남습니다. OS/패키지 설치에 인터넷이 필요합니다. **VM 내부 레코더용 venv**와 **호스트 VAMP용 venv**는 별개입니다.

## 기존 Windows/Debian VM에서 수동 설치

```bash
.venv/bin/python -m pip install -r guest_setup/requirements.txt
.venv/bin/python scripts/build_recorder_media.py
```

결과 `artifacts/recorder-setup.iso`를 VM의 가상 DVD에 연결합니다. VirtualBox에서는 MCP `vm_prepare_recorder`가 미디어 생성과 빈 슬롯 연결을 지원합니다. 연결하려면 정확한 `vm`, `controller`, `port`, `device`를 지정하며 VM은 전원 꺼짐 상태여야 합니다. 기존 디스크/미디어를 교체하지 않습니다.

Windows에서는 사용자 계정으로 미디어의 `setup-win.cmd`를 실행합니다. Python3.12/winget이 필요하며 자동 설치를 시도합니다. Debian에서는 **일반 데스크톱 사용자/X11 세션**에서 `sh /미디어/경로/setup.sh`를 실행합니다. OS 패키지 설치 시 sudo가 필요합니다. 홈/바탕화면은 해당 사용자 설정에서 확인하고 설치하며 사용자 녹화 파일은 덮어쓰지 않습니다.

SPICE/KVM MCP 브랜치에서도 `vm_recorder_media`로 같은 ISO를 만들 수 있습니다. 이 도구는 **호스트에서 ISO 생성까지만** 합니다. libvirt 또는 VM 관리자로 미디어를 연결한 다음 기존 VM 키보드 도구로 해당 사용자 세션에서 설치기를 실행해야 합니다. 현재 VM 자동 생성/무인 설치 기능은 VirtualBox용입니다. Hyper-V 자동 레코더 설치는 구현하지 않았습니다.

## 녹화 → RPA 변환

1. VM 바탕화면의 `RPA-Recorder` 폴더에서 Windows `Start-Recorder.cmd`, Debian `start-recorder.sh`를 실행합니다.
2. VAMP UI에서 Start recording → 작업 → Stop → Save Python. `recordings/naver_login.py` 같은 Python 파일로 저장합니다. 비밀번호/인증정보는 녹화하지 않습니다.
3. Python 파일을 호스트로 가져온 뒤 [변환 안내](RECORDING_CONVERSION.md)에 따라 `scripts/convert_recording.py`를 실행합니다. 게스트 안에서 녹화했으므로 host viewport 변환이 필요하지 않습니다.
4. 변환된 Robot/Python RPA의 시작 절차는 Windows Win+R / GNOME Alt+F2로 정리하고, 화면 해상도/배율 및 OCR 성공 판정을 검증합니다.

현재 변환 런타임은 SPICE 실행용입니다. **VirtualBox용 동일 녹화 재생 변환은 아직 연결하지 않았습니다.** VirtualBox Robot 패키지는 `backends/virtualbox/rpas` 아래 따로 작성하며 키보드/화면 도구를 호출할 수 있습니다. 상류 GUI 자체의 Play 기능과 AST 기반 호스트 변환기는 별개입니다. 기존 Windows·Debian VM의 저장·공유 검증은 [검증 기록](VALIDATION.md)에 있습니다. 새 OS 무인 설치부터 레코더 준비까지의 전체 완료는 아직 검증하지 않았습니다.
