# VirtualBox RPA (Ubuntu 호스트에서 기존 VM 검증)

SPICE/KVM과 별도로 동작하는 호스트용 백엔드입니다. 원본 [chryaner/mcp-virtualbox](https://github.com/chryaner/mcp-virtualbox)의 화면·입력 구현을 실제 호출합니다. VM 게스트에 RPA 에이전트를 설치하지 않습니다. Windows/Linux 호스트에서 사용하도록 작성했으며, 현재 Ubuntu 호스트의 Win-RPA/Windows 11과 Debian-RPA/Debian 13에서 실행·입력·해상도·공유 녹화·Robot 이력을 검증했습니다. 실제 새 VM 생성과 스냅샷 촬영·복원은 사용자 요청에 따라 실행하지 않았습니다. Windows/macOS 호스트는 별도 테스트 전입니다.

## 설치

VirtualBox 7.x, Node.js 22 이상, Python 3.11 이상을 호스트에 설치하세요. VM은 VirtualBox 관리자에서 먼저 생성합니다. 기존 Python venv를 써도 되고 다음처럼 별도로 만들 수 있습니다.

```bash
python3 -m venv .venv-virtualbox
.venv-virtualbox/bin/python -m pip install -r backends/virtualbox/requirements.txt
cd third_party/mcp-virtualbox
npm ci --ignore-scripts
npm run build
cd ../..
```

Windows에서는 `python -m venv .venv-virtualbox`, `.venv-virtualbox\Scripts\python.exe`를 사용하세요. Node와 VBoxManage가 PATH에 있어야 하며, 다른 경로면 `VBOXMANAGE_PATH` 환경 변수에 VBoxManage 실행 파일의 절대 경로를 지정합니다. 마우스 클릭은 별도로 VirtualBox SDK의 호스트 Python 바인딩(`vboxapi`)과 VM의 **USB Tablet** 설정이 필요합니다. `PYTHON_PATH`는 이 SDK를 import할 수 있는 호스트 Python 실행 파일을 가리킵니다. SDK를 설치한 Python과 RPA venv가 달라도 됩니다. 키보드/스크린샷에는 마우스 SDK가 필요하지 않습니다. Guest Additions의 게스트 명령 실행이나 SSH는 사용하지 않습니다.

## 실시간 관전: separate 기본값

```bash
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_list
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_start --args '{"vm":"Windows11-RPA"}'
```

기본 기동은 `VBoxManage startvm <VM> --type separate`입니다. [Oracle 문서](https://docs.oracle.com/en/virtualization/virtualbox/7.0/user/vboxmanage.html)는 이를 VM 실행 프로세스와 UI를 분리하는 detachable UI로 설명합니다. 최초 표시 동작은 VirtualBox 버전/호스트 UI에 따라 확인하세요. **처음부터 항상 창이 숨겨진다고 가정하지 않습니다.**

VirtualBox 관리자에서 실행 중 VM을 선택하고 **표시(Show)**로 관전합니다. 관전 창을 닫을 때는 **Detach / 백그라운드에서 계속 실행**에 해당하는 동작을 선택하세요. 종료/전원 끄기/상태 저장을 선택하면 RPA가 계속 실행될 수 없습니다. 버전별 표시 문구가 다를 수 있습니다. 이 백엔드는 창을 닫거나 Robot 작업이 끝났다는 이유로 VM을 종료하지 않습니다. 이미 실행 중이면 새 VM을 시작하거나 프런트엔드를 바꾸지 않습니다.

입력과 캡처는 관전 창의 호스트 좌표가 아니라 VM의 화면을 사용합니다. 관전 창 이동·크기 변경은 RPA 좌표에 영향을 주지 않습니다. 사람이 같은 VM에 직접 입력하면 자동화 입력과 충돌하므로 관전 중에는 입력을 피하세요. 특별히 필요하면 `vm_start`의 `type`을 `gui` 또는 `headless`로 지정할 수 있습니다.

## 화면·키보드·마우스 / Robot

```bash
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_screen_info --args '{"vm":"Windows11-RPA"}'
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_screenshot --args '{"vm":"Windows11-RPA"}' --screenshot artifacts/virtualbox/screen.png
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_keyboard_scancode --args '{"vm":"Windows11-RPA","keys":"win+r"}'
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_keyboard_type --args '{"vm":"Windows11-RPA","text":"firefox https://www.naver.com"}'
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_keyboard_scancode --args '{"vm":"Windows11-RPA","keys":"enter"}'
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_mouse_click --args '{"vm":"Windows11-RPA","x":800,"y":500}'
.venv-virtualbox/bin/python -m robot --outputdir artifacts/virtualbox/robot --variable VM_NAME:Windows11-RPA backends/virtualbox/rpas/observe/run.robot
```

PowerShell에서 JSON 인자 전달이 달라지면 Python/Robot 라이브러리에서 dict를 전달하는 방식을 사용하세요. 비밀번호를 CLI 인자에 넣지 마세요. ASCII 키보드 입력 예제이며 다국어 문자 입력은 게스트 키보드 레이아웃/IME와 함께 별도 검증해야 합니다. 관전 예제는 자동 기동하지 않으며 이미 실행 중인 VM의 스크린샷을 저장합니다. `completed`는 도구 호출 완료이고 앱 실행/로그인 성공을 뜻하지 않습니다.

화면 PNG는 기존 `vision.py` YOLO/OCR에 전달할 수 있습니다. 모델은 기존 [백그라운드 프로세스](../../docs/MODEL_BACKGROUND.md)를 사용합니다. VirtualBox 전용 네이버 로그인/업데이트 시나리오와 화면 성공 판정은 아직 검증하지 않았습니다. Windows 앱은 Win+R, GNOME은 Alt+F2 같은 공통 실행기로 시작하세요. 각 RPA는 이 백엔드의 `rpas/<id>/` 아래 `.robot`, `workflow.py`, `manifest.json`으로 구성합니다. 루트 SPICE 실행기 `scripts/run_rpa.py`의 manifest와 혼용하지 않습니다.

## AI/MCP 연결

MCP 클라이언트 설정에서 경로를 실제 절대 경로로 바꾸세요. npm 실행 메시지가 프로토콜에 섞이지 않도록 Node로 직접 실행합니다.

```json
{
  "mcpServers": {
    "virtualbox-rpa": {
      "command": "node",
      "args": ["/absolute/path/spice_kvm_based_rpa/backends/virtualbox/server.mjs"],
      "env": {"VBOXMANAGE_DEBUG":"false"}
    }
  }
}
```

19개 도구: `vm_run_observation`, `vm_run_history`, `vm_run_artifact`, `vamp_setup`, `vm_snapshot`, `vm_recording_share`, `vm_import_recording`, `vm_configure_display`, `vm_insert_guest_additions`, `vm_create`, `vm_prepare_recorder`, `vm_list`, `vm_info`, `vm_start`, `vm_screenshot`, `vm_screen_info`, `vm_keyboard_scancode`, `vm_keyboard_type`, `vm_mouse_click`. 상류 전체 서버의 VM 삭제/게스트 명령/SSH 도구는 이 엔트리에서 등록하지 않습니다. Python CLI는 스크린샷을 파일로 저장해 큰 base64를 JSON에 출력하지 않습니다. 직접 MCP의 스크린샷 도구는 상류 형식대로 image 콘텐츠를 반환합니다. Python 도구 호출마다 경량 Node 서버를 실행하며 YOLO/OCR 모델 프로세스는 별개로 유지됩니다.

## 출처와 라이선스

원본: **chryaner/mcp-virtualbox**, revision `b51349126d34824cb211d412fc815f1e2e4ed2a5`, MIT, Copyright (c) 2026 mcp-virtualbox contributors. [원본 LICENSE](../../third_party/mcp-virtualbox/LICENSE) 전문을 보존합니다. [PROVENANCE.json](../../third_party/mcp-virtualbox/PROVENANCE.json)에 원본 파일 해시와 로컬 변경 내역을 기록합니다. 본 프로젝트의 결합 코드도 루트 MIT를 따릅니다. MIT는 저작권/허가 고지 보존 조건으로 사용·수정·배포·판매를 허용합니다.

VirtualBox 제품·SDK·Extension Pack과 YOLO 모델의 별도 라이선스는 이 MIT 고지로 바뀌지 않습니다. 하이퍼바이저/Extension Pack 바이너리는 포함하지 않습니다. [외부 고지](../../THIRD_PARTY_NOTICES.md)를 확인하세요.

## 사용자 실제 테스트 순서

VM 목록/정보 → `separate` 시작 → 관리자 Show → 관전 창 detach 후에도 VM 실행 중인지 확인 → 화면 캡처 → Win+R 입력 → 마우스 좌표 확인 순서로 진행하세요. VM의 실제 해상도가 1920×1080인지 확인한 뒤 기존 좌표를 적용합니다. 시작 성공만으로 부팅·웹페이지 로딩 성공을 판정하지 않습니다. 종료는 사용자가 직접 결정합니다.

## ISO에서 한 번에 생성·무인 설치

```bash
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_create --args '{"iso_path":"/absolute/path/debian-amd64.iso"}'
# 이름/사양을 지정할 수도 있습니다.
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_create --args '{"iso_path":"/absolute/path/Win11.iso","name":"VAMP-Windows11","memory_mb":8192,"image_index":1}'
```

AI는 먼저 사용자에게 **VirtualBox 호스트의 ISO 파일 경로**를 받고 이 도구를 한 번 호출합니다. 감지한 Debian amd64/Windows11 x64만 초기 프로필에서 허용합니다. 기본 계정 **vboxuser**, 비밀번호 **password123!**는 공개 샌드박스 기본값이며 Linux root/Windows 관리자에도 동일 비밀번호가 적용될 수 있음을 고지합니다. `installation_started` 이후 설치기는 AI 없이 계속 실행됩니다. `separate`로 관전하며, 결과의 `installation_verified`와 `recorder_installed_verified`는 실제 검증 전 false입니다.

Windows ISO에 따라 에디션 image_index 및 정당한 product_key가 필요할 수 있습니다. 기존 VM 이름/폴더는 덮어쓰지 않습니다. 오류 발생 시 `vamp-install.json`과 일부 생성된 VM/디스크를 보존합니다. 재실행 전에 원인을 확인하고 새 이름 또는 수동 정리를 선택하세요. 실행 도중 호스트의 MCP 클라이언트가 취소되면 이미 시작한 VM은 남아 있을 수 있습니다. OS 설치 전체 완료가 아니라 7분 이내의 호스트 준비/설치 시작 단계만 기다립니다.

[Oracle unattended 문서](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/vboxmanage.html)를 기준으로 버전별 password 플래그를 선택합니다. 레코더는 전용 DVD 미디어와 post-install hook을 연결합니다. 자세한 라이선스·동작은 [게스트 레코더 안내](../../docs/GUEST_RECORDER.md)에 있습니다.

게스트 OS 자체 **1920×1080 / 배율 100%** 및 호스트 관전 **View → Scaled Mode** 설정은 [해상도 안내](../../docs/VM_DISPLAY.md)를 참고하세요. Windows Guest Additions ISO 삽입은 스크립트로, 설치/UAC 승인과 재부팅은 사용자가 수행합니다.

[초기 설정·매 로그인 해상도·GUI 녹화 공유·스냅샷 안내](../../docs/GUEST_AUTOMATION.md)를 추가했습니다. Debian 네트워크 미러를 자동 설정하고, Windows는 생성 전에 별도 선택과 라이선스 고지를 합니다.

[Robot Listener·영상·SQLite 실행 이력](../../docs/EXECUTION_HISTORY.md)을 참고하세요.
