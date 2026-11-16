<p align="center">
  <img src="vscode-extension/icon.png" width="128" height="128" alt="VAMP 박쥐와 VM 아이콘">
</p>

# VAMP · Virtual Agent Machine Platform

**VM-isolated GUI RPA & Encrypted Vault Execution for AI Agents**

Start in VS Code’s **VAMP** sidebar: **RPA Library** to create/find/export workflows, **Open VM Manager** for VirtualBox/KVM/Hyper-V, and **Browse Credentials** for your encrypted vault. **Create** lets you name and describe a VM recording; **Create with AI** asks questions and proposes searchable metadata. Enable **VAMP RPA Library** MCP so agents can search and reuse reviewed skills before repeating CUA or multimodal analysis.

[User guide — every button and workflow](docs/USER_GUIDE.md) · [UI audit](docs/UI_AUDIT.md)


GUI 작업을 한 번 기록해 두고, 다음에는 AI가 필요한 RPA를 골라 실행하도록 만드는 프로젝트입니다.

[VAMP 0.1.8](https://github.com/wayfarer6/vamp-mcp/releases/tag/v0.1.8) · [Vault 0.1.5](https://github.com/wayfarer6/vamp-mcp/releases/tag/vamp-vault-v0.1.5) · [다운로드](https://github.com/wayfarer6/vamp-mcp/releases) · [VS Code 확장](https://marketplace.visualstudio.com/items?itemName=wayfarer6.vamp-mcp-tools) · [문서](docs/README.md) · [실행 영상](docs/DEMOS.md) · [Script Hub](https://wayfarer6.github.io/vamp-script-hub/) · [로드맵](docs/ROADMAP.md)

## 만든 이유

네이버 로그인 페이지를 여는 일만 해도 브라우저 실행, 주소 입력, 화면 확인이 반복됩니다. 이 과정을 매번 AI가 화면을 보며 판단하고 코드를 다시 읽게 하면 토큰을 계속 쓰게 됩니다.

사용자가 직접 조작하거나 CUA(화면을 보고 컴퓨터를 조작하는 AI)가 수행한 GUI 작업을 기록하고, 검토한 기록을 Robot Framework·Python RPA로 묶어 두려 합니다. 이후에는 AI가 작업 설명과 입력값만 보고 패키지를 골라 실행하고, 결과 요약을 받으면 됩니다. 좌표나 입력 순서 같은 세부 구현은 로컬 코드에 두고, 필요할 때만 로그와 화면을 확인하는 방식으로 토큰 비용을 줄이는 것이 목적입니다.

정상 재실행은 로컬 검증 후 상태와 증거 경로만 반환하고, 실패할 때 필요한 OCR·YOLO·화면만 확인합니다. 인식 결과 전문이나 이미지를 LLM에 계속 보내면 토큰이 발생하므로 [짧은 결과 반환 원칙](docs/LOW_TOKEN_AUTOMATION.md)을 스킬과 MCP 안내문에 포함했습니다.

하루 동안 Codex와 바이브 코딩으로 만들었습니다. 아직 거친 부분과 빠진 기능이 많습니다. 현재 시험한 환경은 KVM/VNC·SPICE와 VirtualBox이며, 토큰 절감량을 측정한 상태는 아닙니다.

### 왜 컨테이너(Docker)가 아닌 가상머신(VM)인가?

많은 에이전트 프로젝트가 가벼운 Docker 컨테이너를 먼저 시도하지만, VAMP는 의도적으로 하이퍼바이저 기반 가상머신(VirtualBox, KVM, Hyper-V)을 선택했습니다:

1. **진짜 Windows GUI 및 엔드포인트 소프트웨어 지원**: 사내 ERP, 공공 행정 포털, 레거시 데스크톱 업무 소프트웨어 및 드라이버는 호스트 커널을 공유하는 리눅스 컨테이너 안에서는 동작하지 않습니다. 완전한 Windows 데스크톱 OS 환경이 필수적입니다.
2. **게스트 장치 기반 입력**: 호스트 마우스를 움직이는 대신 하이퍼바이저의 키보드·USB Tablet API로 게스트에 입력합니다. 실제 앱의 입력 반응과 업무 성공 여부는 게스트에서 검증합니다.
3. **가상 스토리지 및 Removable USB 에뮬레이션**: 외부 하드웨어 보안 토큰이나 암호화 키스토어를 게스트 시스템에 '이동식 USB 드라이브'로 인식시키거나 VeraCrypt VHD 볼륨을 보조 블록 장치로 패스스루하려면 하이퍼바이저 레벨의 하드웨어 스토리지 컨트롤러 에뮬레이션이 필요합니다.
4. **하드웨어 가상화(VT-x) 레벨의 격리**: 에이전트의 오동작이나 악의적인 스크립트로부터 사용자 호스트 환경을 원천 차단하기 위해, 컨테이너 네임스페이스보다 격리 신뢰도가 높은 하드웨어 샌드박스를 사용합니다.

## 기록한 작업을 다시 쓰는 흐름

```mermaid
flowchart LR
    U[사용자 수동 조작 · CUA] --> R[GUI 동작 기록]
    R --> V[검토 · 변환 · 화면 검증]
    V --> P[재사용할 RPA 패키지]
    A[다음 작업을 받은 AI] -->|설명과 입력값으로 선택| P
    P --> L[로컬 VM에서 실행]
    L --> S[결과 요약 · 로그 · 실행 이력]
    S --> A
    L -. 필요할 때 .-> I[스크린샷 · OCR · UI 인식]
    I -. 확인 결과 .-> A
```

현재 지원하는 기록 변환은 PyAutoGUI 코드에서 SPICE용 RPA를 만드는 경로입니다. 임의의 CUA 기록을 모두 자동 변환하거나, 같은 기록을 VirtualBox에서 바로 재생하는 부분은 아직 연결하지 못했습니다. [예시와 현재 범위](docs/WORKFLOWS.md)

## 주요 기능

| 기능 | 할 수 있는 일 |
| --- | --- |
| GUI 작업 기록·재사용 | 클릭과 키 입력을 저장하고, 검토한 작업을 Robot/Python 패키지로 실행 |
| 로컬 화면 제어 | VM 화면 캡처, 키보드·마우스 입력, 선택적 OCR·UI 영역 인식 |
| 기록·로그 확인 | 녹화 소스, 실행 요약, Robot 로그·보고서와 SQLite 실행 이력 확인 |
| 필요한 화면만 보기 | 현재 화면이나 저장한 스크린샷을 확인하고, 켜 둔 실행 영상은 로컬에서 재생 |
| VS Code 실시간 VM 뷰어 | QEMU VNC 화면을 WebSocket으로 스트리밍하고, 보기 전용 탭과 외부 VNC 접속 정보 표 제공 |
| KVM MCP | VM 생성·기동·전원·스냅샷 관리, 화면·입력, Robot 시나리오 실행 |
| VirtualBox MCP | VS Code에서 VM 조회·기동, ISO 설치 시작, 해상도·공유폴더·스냅샷 도구 사용 |
| 원격 SSH MCP | SSH로 연결한 다른 컴퓨터의 VM을 조회·기동·정지하고 화면은 스크린샷으로 확인 (실시간 화면 없음) |
| VAMP Vault MCP | KeePassXC·VeraCrypt 기반 자격증명/인증서 격리 보관 및 사이드바 GUI |

OCR·UI 인식은 저장소에서 별도로 설치합니다. VSIX에는 VirtualBox MCP와 실시간 VNC 뷰어가 들어 있습니다. KVM MCP는 로컬 저장소의 Python 환경을 연결하며, VM 디스크·ISO·YOLO·PaddleOCR 모델은 VSIX에 포함하지 않습니다. [구성도](docs/MCP_ARCHITECTURE.md) · [로그·스크린샷 조회](docs/EXECUTION_HISTORY.md)

## VAMP Script Hub — 커뮤니티 RPA 스크립트 카탈로그

[VAMP Script Hub](https://wayfarer6.github.io/vamp-script-hub/)는 VAMP 사용자가 검토한 RPA 스크립트를 모아 둔 정적 사이트입니다. 스크립트마다 PyAutoGUI 소스, 입력 계약, 검증 기준, `rpa_run_saved` 호출 예시가 함께 공개되고, VirtualBox·KVM과 Windows 11·Debian/Ubuntu 조합으로 걸러 볼 수 있습니다. 저장소 안의 사본은 [`docs/hub/`](docs/hub/)에 있습니다.

멀티모달 CUA는 같은 로그인 화면이나 목록 화면을 실행할 때마다 다시 읽고 판단합니다. 허브의 스크립트는 그 판단을 이미 기록으로 남긴 것이라, 에이전트는 `rpa_search`로 맞는 항목을 찾고 `rpa_run_saved`에 입력값만 넘겨 재생하면 됩니다. 화면 인식과 코드 생성에 쓰던 토큰을 아끼는 것이 목적이며, 절감량을 비교 측정한 수치는 아직 없습니다.

### 스크립트 공유와 연동

1. 게스트에서 작업 하나를 기록하고, 비밀번호·PIN·토큰 입력 전에 멈춥니다.
2. VS Code **RPA Library → Create**에서 이름, 설명, 사용 조건, 입력 이름, 기대 결과를 채우고 검토한 뒤 **Export ZIP**을 누릅니다. ZIP에는 파일별 SHA-256 체크섬이 담긴 `VAMP_EXPORT.json`이 들어 있으며 `.git` 이력은 포함되지 않습니다.
3. 내보낸 폴더를 `vamp-script-hub` 저장소의 `scripts/<id>/`에 넣어 풀 리퀘스트를 열거나, 사이트의 **Submit a script**에서 이슈로 제출합니다. 생성기는 VAMP와 같은 규칙으로 입력 이름과 `${name}` 자리표시자를 검사합니다.
4. 사용하는 쪽은 VS Code에서 **VAMP RPA Library** MCP를 켜고 `rpa_search` → `rpa_details` → `rpa_run_saved` 순서로 호출합니다. 정확한 VM UUID, 선언된 모든 입력, `confirmed:true`가 필요합니다.
5. `completed_unverified`는 동작 완료일 뿐 업무 성공이 아닙니다. 기대 결과를 스크린샷·OCR·파일 확인처럼 가장 저렴한 방법으로 따로 검증합니다.

기본 카탈로그는 6개 스크립트로 시작합니다: 네이버 로그인 폼 검증, 구글 검색 결과 추출, 깃허브 스타·릴리즈 확인, 슬랙 상태 설정, 노션 PDF 내보내기, 엔터프라이즈 인증서 선택 헬퍼. 사이트는 영어와 한국어를 모두 제공하며 언어 선택은 브라우저에 기억됩니다.

[허브 사이트](https://wayfarer6.github.io/vamp-script-hub/) · [저장소 안 사본](docs/hub/) · [기여 가이드](https://github.com/wayfarer6/vamp-script-hub/blob/main/CONTRIBUTING.md)


## Install the MCP servers with npm

Use the MCP servers directly from VS Code, Codex, or another stdio MCP client without installing the VS Code extensions. Requires **Node.js 22+**. There are only two packages:

- [`vamp-mcp`](https://www.npmjs.com/package/vamp-mcp): VirtualBox and KVM/libvirt control, plus the reviewed RPA library.
- [`vamp-mcp-vault`](https://www.npmjs.com/package/vamp-mcp-vault): KeePassXC credentials and optional VeraCrypt volumes.

> The npm publish requests have been accepted. The public registry currently exposes only a temporary `0.0.0-stage` placeholder; installation of the real releases is being verified. The placeholder is not an executable MCP server.

Once the real releases are available, install both packages:

```bash
npm install -g vamp-mcp@0.1.8 vamp-mcp-vault@0.1.6
```

Register them with Codex:

```bash
codex mcp add vamp -- npx -y vamp-mcp@0.1.8 virtualbox
codex mcp add vamp-vault -- npx -y vamp-mcp-vault@0.1.6
```

For KVM, replace `virtualbox` with `kvm`. For the reviewed RPA library, use `library` and set `VAMP_RPA_REGISTRY` to your catalog directory. In VS Code, use **MCP: Add Server → Command (stdio)** with the matching `npx` command, or copy the configuration examples below.

npm installation does not automatically register every client, install a hypervisor/Python/KeePassXC/VeraCrypt, create a VM, or unlock a vault. Prepare those dependencies separately. Hyper-V is excluded from this npm release. The npm packages do not include the graphical VM manager or live VS Code viewer.

[VS Code and Codex configuration](npm-package/README.md) · [Vault configuration, unlock and approval](npm-packages/vault/README.md)

## npm으로 MCP 서버 설치

> npm 게시 요청이 접수되었습니다. 현재 npm 공개 조회에는 임시 버전(`0.0.0-stage`)만 표시되어 실제 배포 버전의 설치 가능 여부를 확인 중입니다. 임시 버전은 실행 가능한 MCP 서버가 아닙니다.

VS Code 확장 없이 MCP 서버만 사용하려면 npm으로 설치할 수 있습니다. Node.js 22 이상이 필요합니다. 패키지는 **VAMP와 Vault 두 개**이며, VirtualBox와 KVM은 VAMP 안에서 선택합니다.

```bash
npm install -g vamp-mcp@0.1.8 vamp-mcp-vault@0.1.6
```

전역 설치 없이 실행할 수도 있습니다. 아래 명령은 MCP 클라이언트에 등록해서 사용하며, 단독 실행하면 표준 입력에서 MCP 요청을 기다립니다.

```bash
npx -y vamp-mcp@0.1.8 virtualbox
npx -y vamp-mcp@0.1.8 kvm
npx -y vamp-mcp@0.1.8 library
npx -y vamp-mcp-vault@0.1.6
```

Codex CLI 등록 예시:

```bash
codex mcp add vamp -- npx -y vamp-mcp@0.1.8 virtualbox
codex mcp add vamp-vault -- npx -y vamp-mcp-vault@0.1.6
```

KVM은 첫 명령의 `virtualbox`를 `kvm`으로 바꿉니다. npm 설치가 모든 클라이언트에 자동 등록해 주지는 않습니다. VirtualBox·KVM/libvirt·Python·KeePassXC·VeraCrypt와 사용할 VM은 별도로 준비해야 합니다. Vault는 DB 경로와 로컬 잠금 해제 수단을 설정해야 하며, npm 설치만으로 VS Code의 승인창이나 비밀 저장소에 자동 연결되지 않습니다. Hyper-V는 이번 npm 배포에서 제외합니다.

[VS Code·Codex 설정과 Python 준비](npm-package/README.md) · [Vault 설정·잠금 해제·승인 방식](npm-packages/vault/README.md)

## 시작하기

1. 호스트에 VirtualBox 7.x와 Python 3.11+를 설치합니다.
2. [Marketplace](https://marketplace.visualstudio.com/items?itemName=wayfarer6.vamp-mcp-tools) 또는 [Release의 VSIX](https://github.com/wayfarer6/vamp-mcp/releases)로 확장을 설치합니다.
3. 명령 팔레트에서 **VAMP: Set Up Python Environment**를 실행합니다.
4. MCP 서버 목록에서 **VAMP VirtualBox**를 시작하고 기존 VM을 조회합니다.

새 VM을 만들 때는 **VAMP: Create VM From ISO**를 사용합니다. Windows 11 설치 ISO와 유효한 라이선스는 사용자가 직접 준비하고, 정품 인증도 직접 진행해야 합니다. VAMP에는 Windows ISO·정품 인증 키·라이선스가 포함되지 않습니다. 자동 설치의 공개 설치용 키는 에디션 선택용이며 Windows를 정품 인증하지 않습니다. **`vboxuser` / `password123!`는 MCP 서버가 VM 무인 설치 과정에서 지정하는 기본 테스트 계정 정보입니다. 운영체제가 원래 제공하는 계정이 아니며, 공개된 값입니다.** 설치 시작 응답은 설치 완료를 뜻하지 않습니다.

[확장 사용법](vscode-extension/README.md) · [VirtualBox MCP 직접 연결](backends/virtualbox/README.md) · [SPICE 설치](docs/INSTALL.md) · [VM 준비사항](docs/GUEST_AUTOMATION.md)

## VS Code에서 VM 화면 보기

KVM VM의 화면은 스크린샷을 반복 조회하는 대신 **VNC(RFB) → 로컬 WebSocket 중계 → noVNC**로 실시간 표시합니다. VM의 VNC 서버는 QEMU가 제공하고, 확장은 뷰어와 중계를 담당합니다.

1. 확장 설정 `vamp.kvmRepositoryPath`에 이 저장소 경로를 지정합니다.
2. `vamp.kvmPythonExecutable`과 `vamp.kvmConfigPath`에 사용할 Python 및 VM 프로필을 지정합니다. 생략하면 저장소의 `.venv`와 `config/vm-mcp.json`을 사용합니다.
3. MCP 서버 목록에서 **VAMP KVM (VNC)**를 시작합니다.
4. **VAMP: Open KVM Viewer (Live VNC)** 명령으로 실행 중인 VM을 선택합니다.

뷰어는 기본적으로 보기 전용이며, RPA와 사용자가 같은 화면을 함께 볼 수 있습니다. 창 크기에 맞춘 화면 표시와 재연결 버튼을 제공합니다. 화면 아래에는 외부 VNC 뷰어를 위한 다음 정보와 주소 복사 버튼이 표시됩니다.

| VM 이름 | 호스트 | VNC 포트 | 접속 주소 |
| --- | --- | --- | --- |
| 선택한 VM 이름 | `127.0.0.1` | VM에서 조회한 실제 포트 | 예: `127.0.0.1:5900` |

포트는 실행 시 조회하므로 고정값을 가정하지 않습니다. VM은 한 번에 한 대씩 검증하며, 시나리오는 Robot Framework의 보고서·타임라인·MP4로 남깁니다. [KVM MCP와 재현 절차](docs/VM_MCP.md)

## 원격 호스트의 VM (SSH)

데스크톱이 다른 컴퓨터(홈 서버, 랩 장비, 클라우드 VM)에 있고 지금 쓰는 노트북이나 원격 에이전트에서 제어해야 할 때는 **VAMP Remote (SSH)** 를 사용합니다. VM을 소유한 호스트에서 원격 서버가 돌고, MCP 통신은 SSH 채널 안으로만 오갑니다. 하이퍼바이저 포트를 열지 않으며 게스트 디스크·자격증명·Vault는 원격 호스트를 떠나지 않습니다.

이 모드의 화면은 **스크린샷**입니다. 요청할 때마다 PNG 한 장을 받아 보여 주고, 실시간 스트리밍은 하지 않습니다. VM 기동·정지, 목록·상태 조회, 조합키·텍스트 입력, KVM 절대 좌표 클릭, SDK를 갖춘 VirtualBox의 클릭·이동, 검토한 RPA 재생까지 원격에서 동작합니다.

Vault도 같은 방식의 원격 기능을 가집니다. **VAMP Vault: Set Up Remote Vault (SSH)** 로 원격 호스트에 볼트 서버를 올리면 그 호스트는 `~/.vamp/vault/vault.kdbx` 라는 **자기 볼트**를 따로 가집니다. 로컬 볼트와 원격 볼트는 서버·마스터 암호·세션 캐시를 공유하지 않고, 원격 서버 A와 B도 서로 공유하지 않습니다. 에이전트에게는 **VAMP Vault (Remote) · user@host** 라는 별도 MCP 서버로 보이며, 읽기 승인과 마스터 암호는 이 컴퓨터에 남고 명령은 SSH 표준 입력으로만 전달됩니다. [원격 볼트 안내](vscode-vault-extension/README.md#remote-vaults-ssh)

1. 확장 설정에서 `vamp.remote.enabled`를 켜고 `vamp.remote.host`, `vamp.remote.username`을 지정합니다. 키는 SSH 에이전트나 `~/.ssh/config`를 그대로 씁니다.
2. **VAMP: Remote · Prepare Environment on the Remote Host** 를 실행합니다. 서버 업로드, Python venv, libvirt/QEMU 설치(비밀번호 없는 sudo가 가능할 때), `libvirtd` 기동, `libvirt` 그룹 추가를 순서대로 시도하고 안 되는 항목은 실행할 명령을 알려 줍니다.
3. VM Manager의 **Remote server · SSH** 화면에서 데스크톱을 조회·기동하고 스크린샷을 엽니다.

```bash
# 원격 호스트에서 직접 준비할 때
scripts/remote_host_setup.sh --backend kvm --repo ~/vamp-mcp --dry-run
```

[원격 설정 안내](docs/REMOTE_SETUP.md) · [원격 서버 README](backends/remote_ssh/README.md)

## 실행 영상과 문서

### 원격 제어와 Windows PDF 출력

두 VM 화면은 **FHD 1920×1080 고정**, Robot Framework 녹화 파일은 **QHD 2560×1440·2fps**입니다. 원본을 확대하지 않고 여백을 추가했으며 전체 디코딩을 검사했습니다.

[![Windows 호스트에서 SSH MCP로 Debian 제어](docs/media/windows-remote-fhd-qhd.png)](docs/media/windows-remote-fhd-qhd.mp4)

[Windows 호스트 원격 키보드·SDK 마우스 영상](docs/media/windows-remote-fhd-qhd.mp4): Ubuntu/KVM → Windows 11 호스트(1소켓·8코어·8GiB) → VirtualBox/Debian에서 실제 버튼 클릭 전후 문구를 OCR로 검증했습니다. 물리 Windows 장비 시험은 아닙니다.

[![Windows Microsoft Print to PDF RPA](docs/media/remote-windows-print-pdf.png)](docs/media/remote-windows-print-pdf.mp4)

[Ubuntu 호스트에서 Windows PDF 출력 영상](docs/media/remote-windows-print-pdf.mp4): SSH MCP로 송장을 열고 Windows의 **Microsoft Print to PDF**로 저장한 뒤, 실제 PDF 제작자·송장 번호·합계와 해시를 검증합니다. [재실행 영상](docs/media/remote-windows-print-pdf-replay.mp4) · [결과 PDF](docs/media/vamp-invoice-example.pdf) · [검증 JSON](docs/media/remote-windows-print-pdf-verification.json)

[재현 방법과 범위](docs/REMOTE_PDF_VALIDATION.md) · [PDF RPA](rpas/windows_print_pdf/README.md) · [원격 입력 RPA](rpas/remote_host_validation/README.md) · [GeekNews 소개글 초안](docs/GEEKNEWS_DRAFT.md)

### 기존 시나리오

[![키보드 입력과 OCR 시연](docs/media/keyboard-ocr.gif)](docs/media/keyboard-ocr.mp4)

[키보드·OCR](docs/media/keyboard-ocr.mp4) · [녹화 공유](docs/media/recorder-share.mp4) · [Windows 호스트 MCP](docs/media/windows-host-mcp.mp4) · [중첩 VM](docs/media/nested-windows-host.mp4) · [데모 시연 가이드](docs/DEMO_SCENARIOS.md)

실제 FHD 화면을 약 2 fps로 캡처한 뒤 여백을 더한 QHD 영상입니다. [재현 방법](docs/DEMOS.md)

| 자격증명·보안 키스토어 격리와 패스키 | [VAMP Vault 확장](vscode-vault-extension/README.md) · [게스트 볼트 설정](docs/GUEST_VAULT_SETUP.md) |
| 알아볼 내용 | 문서 |
| --- | --- |
| 작업을 기록하고 AI가 다시 실행하는 방법 | [워크플로 재사용](docs/WORKFLOWS.md) |
| RPA 작성과 녹화 변환 | [패키지 규격](rpas/README.md) · [변환 가이드](docs/RECORDING_CONVERSION.md) |
| 실행 결과·로그·영상·스크린샷 | [실행 이력](docs/EXECUTION_HISTORY.md) |
| 설치와 백엔드 구성 | [문서 목차](docs/README.md) · [아키텍처](docs/MCP_ARCHITECTURE.md) |
| 시험한 기능과 남은 문제 | [검증 기록](docs/VALIDATION.md) |
| 원격 호스트의 VM을 SSH로 제어 (스크린샷 전용) | [원격 설정 안내](docs/REMOTE_SETUP.md) |
| 원격 하이퍼바이저·클라우드 에이전트 연동 로드맵 | [아키텍처 로드맵](docs/ROADMAP.md) |

KVM MCP의 VM 생성·화면 제어·RPA 실행은 [`vm_mcp_server.py`](vm_mcp_server.py)에서 제공하며, 프로필로 VNC와 SPICE 연결을 구분합니다.

## 책임 한계와 안전한 사용 (Responsible Use)

VAMP 및 VAMP Vault는 사용자의 로컬 환경에서 자원을 절감하고 안전한 자동화를 연구하기 위한 범용 가상화 인프라 오픈소스입니다. 완전 자율 금전 거래(송금, 결제, 금융 자산 이동 등)에 사용하는 것을 권장하지 않으며, 민감한 작업은 반드시 사용자의 직접 검토와 승인(Human-in-the-loop)을 거쳐야 합니다. 본 소프트웨어를 활용하여 수행한 모든 자동화 작업, 외부 서비스 이용, 자격증명 승인 및 그에 따른 결과와 손해에 대한 최종 책임은 전적으로 사용자 본인에게 있으며, 개발자는 어떠한 금전적·법적 손실에 대해서도 책임을 지지 않습니다.

직접 작성한 코드와 문서는 [MIT](LICENSE)입니다. 게스트 레코더의 GPL-3.0 등 외부 라이선스는 [별도 고지](THIRD_PARTY_NOTICES.md)를 확인하세요.
