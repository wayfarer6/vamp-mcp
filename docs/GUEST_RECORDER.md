# GUI 동작 레코더 설치와 저장

`third_party/pyautogui-recorder`에는 PyAutoGUI-Recorder 원본을 보존합니다. 상류 `axel-magard/PyAutoGUI-Recorder`, SHA `6cd48a3bee4ef4dd382e3484feaa4360a37a0a5d`, **GPL-3.0**입니다. 원본 소스/이미지/LICENSE는 수정하지 않았고, MIT 설치기가 별도 게스트 프로그램으로 실행합니다.

GUI 레코더는 클릭과 키 입력을 Python으로 남깁니다. 기록을 검토하고 RPA로 변환하면 AI가 다음 작업에서 패키지 ID로 다시 실행할 수 있습니다. [재사용 흐름](WORKFLOWS.md)

Windows 11을 쓸 때는 설치 ISO·라이선스를 직접 준비하고 정품 인증도 사용자가 해야 합니다. 레코더 설치에 Windows 라이선스는 포함되지 않습니다.

## 게스트 설정은 HTTP(포트 8421)로 배포

VAMP는 이제 ISO를 xorriso로 리마스터링하지 않습니다. `guest_setup/`의 레코더·Vault 보조 스크립트를 호스트 파이썬 표준 라이브러리 HTTP 서버로 8421 포트에 열고, 게스트가 wget/curl로 같은 파일을 내려받습니다. 플랫폼별 설치 미디어를 따로 만들 필요가 없습니다.

```bash
python3 scripts/script_server.py start
# 게스트(Debian/Ubuntu, VirtualBox NAT 기준)
wget -qO- http://10.0.2.2:8421/setup.sh | sh
# 전체(레코더+Vault)
wget -qO- http://10.0.2.2:8421/setup.sh | sh -s -- --all
```

Windows 게스트에서는 `powershell -ExecutionPolicy Bypass -Command "irm http://10.0.2.2:8421/setup.ps1 | iex"`를 실행합니다. libvirt 기본 NAT 네트워크에서는 호스트가 `192.168.122.1`입니다. MCP는 `vm_script_server_start/status/stop`을 제공하고, `vm_guest_bootstrap`은 서버를 먼저 띄운 뒤 해당 명령을 입력합니다. 서버는 준비된 폴더만 제공하고(목록 없음) 기본 30분 뒤 스스로 중지합니다. 스크립트 전달·다운로드는 설치 완료를 뜻하지 않으므로 게스트 화면이나 설정 로그로 확인합니다.

## 새 VirtualBox VM

MCP `vm_create`는 OS 설치 ISO를 감지해 VirtualBox unattended 설치를 시작하고, 후처리 훅에서 호스트 HTTP 서버(8421)의 `postdeb.sh`/`postwin.ps1`을 내려받아 레코더를 설치합니다. 무인 설치를 지원하지 않는 ISO는 순정 설치기로 부팅하므로 사용자가 화면에서 설치를 마친 뒤 같은 HTTP 명령을 실행합니다. 사용자에게 호스트 ISO 경로를 물어 한 번 호출하면 설치 절차는 AI 없이 계속됩니다. 기본 계정은 **vboxuser / password123!**이며 공개 정보입니다.

- Debian: postinstall 스크립트가 GNOME/Xorg, Python/Tk 의존성을 설치하고 `vboxuser`의 `Desktop/RPA-Recorder`와 전용 venv/실행기를 만듭니다. 녹화를 위해 새 VM의 GDM Wayland를 비활성화합니다. sudo 권한은 OS 패키지 설치 단계에만 사용하며, 레코더는 사용자 계정으로 실행합니다.
- Windows 11: 첫 로그인 후처리(`postwin.ps1`)가 HTTP(8421)에서 받은 묶음을 `C:\ProgramData\RPA-Recorder-Setup`에 풀고 `vboxuser` Startup 실행기를 둡니다. 해당 사용자의 **최초 바탕화면 로그인 시** winget/Python 설치, 실제 바탕화면 경로 확인, `RPA-Recorder` 폴더/venv/실행기 구성을 수행합니다. 성공 시 Startup 실행기를 제거합니다. winget/네트워크/첫 로그인 상태에 따라 실패할 수 있으며 실제 장비 검증 전입니다.

레코더가 임의로 녹화를 시작하지는 않습니다. 초기 OS 설치 성공·레코더 설치 완료는 아직 자동 검증하지 않으므로 MCP의 verified 필드는 false로 남습니다. OS/패키지 설치에 인터넷이 필요합니다. **VM 내부 레코더용 venv**와 **호스트 VAMP용 venv**는 별개입니다.

## 기존 Windows/Debian VM에서 수동 설치

가장 간단한 방법은 게스트 안에서 HTTP 명령을 실행하는 것입니다.

```bash
wget -qO- http://10.0.2.2:8421/setup.sh | sh
```

오프라인 미디어가 필요하면 예전처럼 ISO를 만들 수도 있습니다(이 경로는 xorriso를 쓰지 않고 pycdlib를 사용합니다).

```bash
.venv/bin/python -m pip install -r guest_setup/requirements.txt
.venv/bin/python scripts/build_recorder_media.py
```

결과 `artifacts/recorder-setup.iso`를 VM의 가상 DVD에 연결합니다. VirtualBox에서는 MCP `vm_prepare_recorder`가 미디어 생성과 빈 슬롯 연결을 지원합니다. 연결하려면 정확한 `vm`, `controller`, `port`, `device`를 지정하며 VM은 전원 꺼짐 상태여야 합니다. 기존 디스크/미디어를 교체하지 않습니다.

Windows에서는 사용자 계정으로 `setup-win.cmd`를 실행합니다(HTTP 경로는 `setup-win.cmd` 또는 `setup.ps1`). Python3.12/winget이 필요하며 자동 설치를 시도합니다. Debian에서는 **일반 데스크톱 사용자/X11 세션**에서 `sh setup.sh`를 실행합니다. OS 패키지 설치 시 sudo가 필요합니다. 홈/바탕화면은 해당 사용자 설정에서 확인하고 설치하며 사용자 녹화 파일은 덮어쓰지 않습니다.

SPICE/KVM MCP 브랜치에서도 `vm_recorder_media`로 같은 ISO를 만들 수 있습니다. 이 도구는 **호스트에서 ISO 생성까지만** 합니다. libvirt 또는 VM 관리자로 미디어를 연결한 다음 기존 VM 키보드 도구로 해당 사용자 세션에서 설치기를 실행해야 합니다. 현재 VM 자동 생성/무인 설치 기능은 VirtualBox용입니다. Hyper-V 자동 레코더 설치는 구현하지 않았습니다.

## 녹화 → RPA 변환

1. VM 바탕화면의 `RPA-Recorder` 폴더에서 Windows `Start-Recorder.cmd`, Debian `start-recorder.sh`를 실행합니다.
2. VAMP UI에서 Start recording → 작업 → Stop → Save Python. `recordings/naver_login.py` 같은 Python 파일로 저장합니다. 비밀번호/인증정보는 녹화하지 않습니다.
3. Python 파일을 호스트로 복사합니다. VirtualBox Guest Additions와 `VAMPRecords` 공유 폴더가 게스트에 연결돼 있다면 해당 폴더에 바로 저장할 수 있습니다.
4. VS Code에서 **RPA Library → Create → Recorded script**로 파일을 추가합니다. **VirtualBox**를 선택하고 녹화 당시 해상도인 1920×1080을 입력합니다. 기록과 예상 결과를 검토한 뒤 **Save RPA**로 저장합니다. [RPA Library에서 등록하고 재생하는 방법](USER_GUIDE.md#2-vm에서-녹화한-스크립트를-목록에-넣기)

독립 Robot Framework 패키지가 필요하면 호스트에서 `recording_converter.py`를 실행합니다. 게스트에서 녹화한 파일에는 `--coordinate-space guest`를 사용합니다. 패키지를 검토한 뒤 재생할 VirtualBox VM UUID와 예상 결과 문구를 지정합니다. Windows 메모장 예제는 1920×1080 VirtualBox 게스트에서 5개 동작을 재생하고 호스트 OCR로 상태 표시줄을 확인했습니다. [변환과 실행 예제](RECORDING_CONVERSION.md#b-게스트-안에서-기록한-pyautogui-코드-변환)

녹화기는 입력 사이의 대기 시간을 저장합니다. 마지막 입력으로 앱이 열리는 작업이라면 검토한 파일에서 화면이 표시될 시간을 확보한 뒤 결과를 판정하세요.

Windows·Debian 게스트의 저장·공유 결과는 [검증 기록](VALIDATION.md)에 있습니다. 새 OS 무인 설치부터 녹화, VSIX 등록과 재생까지 이어지는 화면 검증은 [#19](https://github.com/wayfarer6/vamp-mcp/issues/19)에서 추적합니다.
