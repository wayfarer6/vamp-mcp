# VAMP 구성과 실행 경로

VAMP는 한 번 검토한 GUI 작업을 로컬 RPA로 보관하고, AI가 다음 요청에서 그 작업을 다시 실행하도록 만드는 프로젝트입니다. [워크플로 예시](WORKFLOWS.md)에서 기록·검토·재사용 과정을 설명합니다.

## AI가 선택하는 부분과 로컬에서 실행하는 부분

AI는 작업의 설명·입력값·성공 조건을 보고 실행할 패키지를 고릅니다. Robot과 Python이 VM 입력과 화면 검증을 맡고, 결과 요약과 상세 파일 경로를 돌려줍니다. 새 작업을 만들거나 실패 원인을 고칠 때는 코드와 화면을 더 살펴볼 수 있습니다.

```mermaid
flowchart TB
    A["AI 에이전트"]
    subgraph Host ["제어 호스트"]
        M["VAMP MCP"]
        subgraph VaultMCP ["VAMP Vault MCP"]
            VA["Vault 도구 · 사용자 승인"]
            K["KeePassXC KDBX · 볼륨 소유 에이전트 ID"]
            VC["VeraCrypt"]
            VA --> K
            VA --> VC
        end
        R["Robot 시나리오"]
        P["Python 동작 · 검증"]
        B["콘솔 어댑터"]
        O["선택적 로컬 YOLO · OCR"]
        R --> P
        P -->|키보드·마우스 입력| B
        B -->|캡처한 화면| P
        P -->|분석할 이미지| O
        O -->|탐지 영역·텍스트| P
    end
    V["VM 데스크톱"]
    C["데스크톱 컨테이너"]
    A <-->|MCP 호출 · 결과| M
    A <-->|별도 MCP 호출 · 전달 결과| VA
    M -->|작업 ID · 입력값| R
    R -->|결과 요약 · 상세 기록 경로| M
    VC --> D["할당된 암호화 볼륨"]
    D -->|보조 디스크| V
    D -->|지정된 작업 공간| C
    VA -->|승인된 값을 지정 수신기로 전달| V
    VA -->|승인된 값을 지정 수신기로 전달| C
    B <-->|하이퍼바이저 콘솔| V
    B <-->|관리형 RFB 화면 캡처·입력| C
```

Robot 시나리오와 Python 코드는 제어 호스트에서 실행합니다. VirtualBox는 호스트의 VBoxManage·SDK, SPICE는 화면·입력 채널을 사용합니다. SPICE Robot 작업은 MCP 없이도 SPICE에 연결할 수 있습니다. Podman은 지정된 컨테이너의 RFB 스트림을 호스트 Robot/Python에 프로세스 파이프로 전달합니다. 원격 VM에서는 원격 하이퍼바이저 호스트가 콘솔 캡처와 입력을 수행하고, 제어 호스트가 반환된 이미지를 분석할 수 있습니다.

## 구성 요소

| 구성 | 위치 | 역할 |
| --- | --- | --- |
| VirtualBox MCP | `backends/virtualbox/server.mjs` | 화면·입력·VM 관리·녹화 소스·실행 이력·게스트 부트스트랩 도구 24개 |
| Robot 클라이언트 | `backends/virtualbox/client.py` | Node MCP 서버 호출과 이미지 파일 저장 |
| 작업 패키지 | `rpas/<id>/`, `backends/virtualbox/rpas/<id>/` | Robot 순서, Python 구현, manifest와 작업 설명 |
| 화면 인식 | `vision.py`, `model_daemon.py` | 제어 호스트에서 캡처 이미지를 분석하는 선택적 YOLO·PaddleOCR 프로세스 |
| 게스트 준비 | `guest_setup/recorder/` | 레코더, 로그인 시 해상도 설정과 Debian 미러 설정 |
| 실행 기록 | `history.py`, `recording_listener.py` | SQLite 이력, 스크린샷과 선택적 영상 |
| VS Code 확장 | `vscode-extension/` | VirtualBox MCP 번들, 호스트 Python 환경 준비와 명령 |

## 녹화와 실행 기록

동작 레코더는 클릭·키 입력을 Python 소스로 저장합니다. 저장한 코드를 가져와 검토하고 변환해야 재생 가능한 RPA가 됩니다. 가져오기 도구는 소스를 실행하지 않습니다. 현재 자동 변환 런타임은 SPICE용이며 VirtualBox용 재생 연결은 별도로 작성해야 합니다.

실행 이력은 RPA를 돌렸을 때의 결과입니다. Robot 로그·보고서, 관찰 세션의 SQLite 이벤트, PNG와 선택적 영상이 남습니다. AI는 먼저 요약을 읽고 필요할 때 로그나 스크린샷을 확인할 수 있습니다. [기록 종류와 조회 방법](EXECUTION_HISTORY.md)

## 호스트와 게스트에 필요한 것

일반 화면 캡처와 키보드 입력은 호스트 VirtualBox를 사용합니다. 마우스 입력에는 VirtualBox 버전에 맞는 호스트 Python SDK가 필요하고, Windows 호스트는 COM Python 지원도 필요합니다. 공유폴더·게스트 파일 가져오기는 Guest Additions 지원을 사용합니다.

게스트 사후 스크립트는 `vm_guest_bootstrap`으로 키 입력을 주입해 실행할 수 있습니다(Packer의 `boot_command` 방식). Windows는 Win+R → `cmd`+Enter → 2.5초 후 포커스 클릭 → 1초 후 `powershell -ExecutionPolicy Bypass`+Enter → 1.5초 후 스크립트를 50자씩 전송하고, Debian은 화면 가운데 클릭 후 열린 터미널에 명령을 입력합니다(Ctrl+Alt+T·TTY 로그인 선택 가능). 포커스 클릭은 `VBoxManage controlvm` 서브커맨드가 아니라 vboxapi `putMouseEventAbsolute` 헬퍼를 쓰며, SDK가 없으면 클릭만 경고로 남기고 키 입력은 계속합니다. 반환값은 전달 여부이고 `verified:false`이므로, 스크립트 실행은 게스트 화면이나 로그로 따로 확인해야 합니다.

VSIX에는 VirtualBox MCP가 들어 있습니다. SPICE, YOLO와 PaddleOCR는 저장소에서 따로 설치합니다. Windows 11 게스트의 ISO와 유효한 라이선스는 사용자가 준비하고 정품 인증도 직접 진행합니다. VAMP는 Windows 이미지나 제품 키를 제공하지 않습니다.

하루 동안 Codex와 바이브 코딩으로 만든 초기 버전입니다. 시험한 환경은 KVM/SPICE와 VirtualBox 정도입니다. 토큰 비용을 줄이려는 설계이며 실제 절감량은 측정하지 않았습니다.

## Windows host validation

The current lab uses Ubuntu → Win-RPA (Windows 11 with nested virtualization) → an inner VirtualBox test VM. The VAMP Node and Python processes must execute **inside Win-RPA** to validate Windows host behavior. Inventory/setup/history checks have passed there. A diskless EFI VM is used for nested transport checks; this is not an installed Windows/Linux guest workload. Controlling Win-RPA from Ubuntu alone would only verify Linux host behavior.

From a Windows PowerShell in the repository:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/setup-host.ps1
$env:VBOXMANAGE_PATH = 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
.venv-virtualbox\Scripts\python.exe scripts/windows/host-smoke.py --vm 'EXISTING-RUNNING-VM'
```

The smoke script never creates or shuts down a VM. Without `--vm`, only inventory, setup information and SQLite history are checked. With `--vm`, it also checks information, native screen size and real screenshot capture. These checks do not prove keyboard, mouse or application success; those require scenario-specific assertions and a running installed guest. See [validation results](VALIDATION.md) for actual outcomes.

Nested virtualization is a lab arrangement, not a requirement for normal users. A normal Windows host runs VirtualBox directly. macOS hardware validation is separate.

## Host setup on all three systems

Every host script needs Python 3.11 or newer and accepts later releases without changes, because each one asks the interpreter for `sys.version_info` instead of matching version strings, so 3.15 and 3.16 work the day they are installed.

| Host | Script | Notes |
| --- | --- | --- |
| Linux | `scripts/remote_host_setup.sh [--backend kvm\|virtualbox] [--repo PATH]` | Also prepares a host reached over SSH; `--dry-run` prints the plan. |
| Windows | `scripts/windows/setup-host.ps1 [-Python PATH]` | Rejects the Microsoft Store alias; accepts 3.11 through 3.15+. |
| macOS | `scripts/macos/setup-host.sh [--python PATH] [--skip-npm]` | Finds python.org, Homebrew or `python3`; VirtualBox is optional for remote use. |

Windows guests reuse any installed Python 3.11+ (`setup-win.cmd`, `guest_setup/recorder/setup.ps1`, `setup-user.py`) and install one only when none qualifies. The recorder payload is committed as `guest_setup/recorder/recorder.zip`; the guest scripts fall back to `https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/guest_setup/recorder/recorder.zip` when the bundle is not beside them.

## Reproducing the lab recordings

The source suites are in `backends/virtualbox/rpas/demos`. `windows_host.robot` and `nested.robot` write a short PowerShell launcher to the prepared `VAMPRecords` host share. This avoids the Win+R command length limit; long repository paths and arguments stay in the launcher file. The Windows setup script must first be installed inside the lab VM. Source scripts and output files are separate from guest input transport.

For the nested menu demo, use an existing **diskless EFI lab VM** at the firmware main menu with **Boot Manager selected**. The scenario presses Enter to open Boot Manager, captures it, presses ESC, then captures the firmware main menu. OCR must find both distinct menus. `nested-smoke.py --create` is a separate explicit creation option; Robot never creates another VM. Do not point this firmware scenario at a VM with installed applications.

```bash
.venv/bin/python -m robot \
  --variable INNER_VM:VAMP-Nested-Smoke-20261115-235230 \
  --variable HOST_OUTPUT:/absolute/path/to/VAMPRecords/nested-demo \
  --outputdir artifacts/demos/nested \
  backends/virtualbox/rpas/demos/nested.robot
```

`HOST_OUTPUT` is the Linux-side shared directory; the defaults in the suite describe this lab's Windows paths and can be overridden. A fresh Windows JSON report and before/after screenshots are required. A transport response alone does not count as visual success. Failed/interrupted runs remain under `artifacts/demos`; only passing runs export MP4/GIF files to `docs/media`.

The repo-only demo code and its optional image/video dependencies are excluded from the VSIX runtime.

Before running the suites, copy the repository's `scripts/windows/*.py` and `*.ps1` files into the corresponding `scripts/windows` directory of the Windows-side checkout. `setup-host.ps1` installs the runtime dependencies there. The shared launchers call that checkout; copying the launcher alone does not deploy updated source scripts.
