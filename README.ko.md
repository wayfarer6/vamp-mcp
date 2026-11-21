<p align="center">
  <img src="vscode-extension/icon.png" width="140" height="140" alt="VAMP 로고">
</p>

<h1 align="center">VAMP · Virtual Agent Machine Platform</h1>

<p align="center">
  <strong>내 하드웨어의 가상머신(VM)에서 AI 컴퓨터 유즈 에이전트를 실행하세요.</strong>
</p>

<p align="center">
  <a href="https://github.com/wayfarer6/vamp-mcp/actions/workflows/ci.yml"><img src="https://github.com/wayfarer6/vamp-mcp/actions/workflows/ci.yml/badge.svg?branch=main" alt="main 브랜치 CI 상태"></a>
  <a href="https://github.com/wayfarer6/vamp-mcp/releases"><img src="https://img.shields.io/github/v/release/wayfarer6/vamp-mcp?style=flat-square&color=8A2BE2" alt="최신 릴리즈"></a>
  <a href="https://www.npmjs.com/package/vamp-mcp"><img src="https://img.shields.io/npm/v/vamp-mcp?style=flat-square&label=vamp-mcp&color=CB3837" alt="npm vamp-mcp"></a>
  <a href="https://www.npmjs.com/package/vamp-mcp-vault"><img src="https://img.shields.io/npm/v/vamp-mcp-vault?style=flat-square&label=vamp-mcp-vault&color=CB3837" alt="npm vamp-mcp-vault"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=wayfarer6.vamp-mcp-tools"><img src="https://img.shields.io/badge/VS%20Code-vamp--mcp-007ACC?style=flat-square&logo=visual-studio-code&logoColor=white" alt="VS Code 확장"></a>
  <a href="https://wayfarer6.github.io/vamp-script-hub/"><img src="https://img.shields.io/badge/커뮤니티-Script%20Hub-blueviolet?style=flat-square" alt="Script Hub"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="라이선스: MIT"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <a href="docs/USER_GUIDE.md">사용자 가이드</a> · <a href="https://wayfarer6.github.io/vamp-script-hub/">스크립트 허브</a> · <a href="docs/ROADMAP.md">로드맵</a>
</p>

---

## 30초 만에 보는 VAMP

**“월말 창고 결산 해줘”로 실행해 보세요.** Codex가 검토된 GUI RPA를 찾으면 LibreOffice Calc가 가상 품목 네 개의 결산 엑셀을 만듭니다. 데모에서는 파일을 다시 열고 수식 24개와 기말 재고 금액을 확인합니다. [한국어 영상](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.16/warehouse-close-workflow-ko.mp4) · [실습·등록 방법](examples/warehouse-close/README.md) · [완성된 엑셀](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.16/warehouse-close-2026-11.xlsx)

**VM에서 직접 녹화하기.** 게스트에서 레코더를 열고, 나중에 YOLO 검증을 추가하려면 버튼 캡처를 켜세요. **Save Python**으로 공유 폴더에 저장하면 호스트에서 원본을 확인할 수 있습니다. 에이전트가 재사용하려면 RPA Library에서 검토하고 저장하세요. 수동 시연만으로 폴백 코드는 자동 생성되지 않으며, 클릭 검증에 실패하면 재생이 멈춥니다. [한국어 영상](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.17/manual-recorder-ko.mp4) · [자막](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.17/manual-recorder-ko.srt)

VAMP VS Code 확장에서 VirtualBox 게스트를 열고 Debian 화면이 연결되는 과정을 보여 줍니다.

[![데모 미리보기: VAMP에서 VirtualBox 게스트를 이름으로 열고 Debian 화면 연결을 확인](docs/media/vamp-demo-preview-ko.gif)](https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/docs/media/vamp-result-ko.mp4)

[▶ 한국어 데모 보기 (0:30)](https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/docs/media/vamp-result-ko.mp4)

[한국어·영어 영상 모음](docs/VM_LAB.md)에서 30초 결과 데모, 설치와 AI 연결, 구조 소개, 실제 VM 생성과 게스트 화면 실습을 종류별로 볼 수 있습니다.

Linux KVM에서 자동으로 남은 로그 두 줄을 열고, 호출 결과와 Vault 자격 증명 조회 기록을 해석하는 방법을 확인하세요. [감사 로그 영상 · 한국어 2:08](docs/media/vamp-audit-log-ko.mp4)

VS Code에서 스크립트와 에이전트로 실행을 찾고, 한 실행의 대기·검증 완료 기록을 여는 과정입니다. [SQLite 감사 화면 실습 · 한국어, 1:00](docs/media/vamp-sqlite-audit-ko.mp4) · [GUI·CLI 라이브러리 분리 설계안](docs/WORKFLOW_LIBRARY_DESIGN.md)

## 오늘 만든 자동화를, 내일은 주문 번호만 바꿔 쓰세요

오늘은 대형 모델과 함께 ERP에서 주문을 CSV로 내보내는 절차를 만들고, 결과 파일에 요청한 주문 번호가 들어 있는지 확인하는 방법까지 저장합니다. 내일은 소형 모델에 **“주문 1042도 같은 방식으로 내보내 줘”**라고 요청하세요. 소형 모델이 RPA Library에서 작업을 찾아 MCP로 새 주문 번호를 전달하면, VAMP가 내 기기에서 절차를 실행하고 CSV를 확인합니다.

**동료에게는 검토한 워크플로를 공유할 수 있습니다.** GUI RPA의 특정 버전을 소스 ZIP으로 내보내면 동료도 코드와 입력 항목을 살펴보고 자기 기기의 호환 환경에서 자기 주문 번호로 재사용할 수 있습니다. 공유할 때는 비밀번호와 실제 주문 데이터를 제외하세요. 같은 작업을 할 때마다 대형 모델이 클릭 순서나 명령을 다시 계획하는 횟수가 줄어 반복 실행 비용을 아낄 수 있습니다.

**VAMP 0.3.15에서는 GUI 녹화와 함께 Python·Playwright 워크플로를 저장하고 실행할 수 있습니다.** RPA Library에서 주문 내보내기 예제를 가져와 내 VM에서 사용할 버전을 검토하세요. 이후 주문 번호만 바꿔 실행하면 생성된 CSV와 검증 결과를 확인할 수 있습니다. CLI 실행기는 VirtualBox·KVM·Hyper‑V의 Linux 게스트를 지원합니다. [GUI RPA 사용법](docs/WORKFLOWS.md) · [CLI 설치 및 주문 예제](docs/CLI_WORKFLOWS.md)

```mermaid
flowchart TD
    A["대형 모델과 작업 절차·성공 조건 작성"] --> G["GUI RPA · 현재 지원"]
    A --> C["Python 또는 Playwright 워크플로"]
    G --> L["내 기기에서 버전 검토·저장"]
    C --> L
    L --> M["내 소형 모델이 작업 ID와 입력값으로 호출"]
    L --> P["검토한 버전 공유"]
    P --> T["동료가 자기 기기에서 검토·설정"]
    T --> N["동료의 소형 모델이 자기 입력값으로 호출"]
    M --> R["각 기기의 VAMP가 실행하고 결과 검증"]
    N --> R
    R --> DB["현재 프로필의 SQLite 감사 기록"]
    V["Vault 자격 증명 조회·전달 및 마운트"] --> DB
    DB --> Q["MCP 조회 · 시간 / 스크립트 / 에이전트"]
    DB --> U["VS Code 감사 화면 · 실행 상세"]
```

AI 서비스의 API 요금이 오르거나 서비스가 종료되어도, 실행 환경을 유지하고 MCP를 지원하는 다른 소형 모델을 연결하면 저장한 작업을 이어갈 수 있습니다. 스크립트를 어떻게 고치고 누구와 공유할지는 사용자가 결정합니다.

**모델을 바꿔도, 만들어 둔 업무 절차는 내 기기에 남습니다.**

## 어떤 에이전트가 어떤 스크립트를 실행했나요?

**VAMP: Open Audit Log**를 열면 최근 24시간의 기록을 실행별로 볼 수 있습니다. 기간, 스크립트 이름·UUID, 에이전트 ID, 활동 종류를 조합해 조회하고 행을 선택해 개별 사건을 확인하세요. 한 화면의 시간 입력은 현지 시간이며 MCP는 시간대가 포함된 ISO 시각을 받습니다.

AI에게 “오늘 오전 9시부터 10시까지 `orders-agent`가 주문 내보내기 스크립트를 실행한 기록과 검증 결과를 찾아줘”라고 요청하세요. 모델은 `audit_search`로 찾고 `audit_run_details`로 상세를 엽니다. 같은 에이전트를 재시작 후에도 추적하려면 전용 MCP 서버의 환경 변수 `VAMP_AGENT_ID=orders-agent`를 지정하세요. 별도 설정이 없으면 MCP 서버 프로세스에 세션 ID를 자동 부여합니다. [SQLite 위치·프로필·조회 예제](docs/AUDIT_LOG.md)

### 녹화한 버튼을 클릭 전에 확인하기

녹화를 저장할 때 클릭한 버튼의 글자 또는 YOLO 전용 클래스 이름을 입력하세요. 재생할 때는 매 클릭 직전에 게스트 화면을 확인하며, 기본 인식 점수는 90%입니다. **RPA Library → Recorded click verification**에서 1~100%로 바꾸거나 검사를 끌 수 있습니다. AI에게 “이번 실행만 95%로 해줘”라고 해도 됩니다. [인식 실패 시 동작과 MCP 사용 예](docs/RECORDED_CLICKS.md)

## 처음이라면 AI에게 설치를 부탁해 보세요

내 PC에서 명령을 실행할 수 있는 **Claude Code 또는 Codex**에 아래 문장을 붙여 넣으세요.

```text
https://github.com/wayfarer6/vamp-mcp
내 Windows PC에 최신 공식 릴리스로 VAMP MCP를 설치해 줘. 파일 해시를 확인하고
지금 쓰는 AI에 연결한 뒤, 이 PC에서 사용하는 VirtualBox 또는 Hyper-V의
가상머신 목록을 조회해서 연결됐는지 보여 줘.
```

[![한국어 영상 내려받기 · AI에게 VAMP 설치 부탁하기](docs/media/vamp-first-run-ko.jpg)](https://github.com/wayfarer6/vamp-mcp/raw/refs/heads/main/docs/media/vamp-first-run-ko.mp4)

[한국어 영상 내려받기 · 3분 51초](https://github.com/wayfarer6/vamp-mcp/raw/refs/heads/main/docs/media/vamp-first-run-ko.mp4) · [웹 채팅용 프롬프트, 설치 명령, 주문 CSV 실습](docs/FIRST_RUN.ko.md)

다음 영상 · [VAMP MCP 구조 소개 (3분 04초)](https://github.com/wayfarer6/vamp-mcp/raw/refs/heads/main/docs/media/vamp-architecture-ko.mp4)에서 VirtualBox, KVM, Hyper-V의 VM 관리와 게스트 화면 경로를 비교합니다.

**영어 음성·자막판** · [설치와 AI 연결, 주문 내보내기 (3분 02초)](https://github.com/wayfarer6/vamp-mcp/raw/refs/heads/main/docs/media/vamp-first-run-en.mp4) · [VirtualBox·KVM·Hyper-V 구조 (1분 53초)](https://github.com/wayfarer6/vamp-mcp/raw/refs/heads/main/docs/media/vamp-architecture-en.mp4).

## How to use

**지원 호스트:** Windows와 Linux입니다. macOS는 지원 대상에서 제외합니다.

**Windows의 Hyper-V (실험적 지원).** Hyper-V를 활성화한 뒤 **VM Manager → Connection → Virtualization platform → Hyper-V**를 선택하세요. VAMP에서 VM을 생성하고 목록을 조회하거나 VMConnect를 열 수 있으며, 지원되는 Windows 게스트와 파일도 주고받을 수 있습니다. 게스트 화면은 VMConnect에서 여세요. Hyper-V에서는 내장 화면 뷰어와 저장된 데스크톱 작업 재생을 아직 지원하지 않습니다. [Hyper-V 설정 및 MCP 도구](backends/hyperv/README.md)

**Windows에서 VAMP 및 VAMP Vault MCP 서버를 실행하려면 관리자 권한이 필요합니다.** `vamp-mcp` CLI는 호스트 UAC 승인을 받아 서버를 별도 관리자 프로세스로 시작할 수 있습니다. 서버 명령을 직접 실행할 때는 관리자 터미널을 사용하세요. VS Code 확장이 제공하는 MCP 서버를 쓰려면 VS Code를 **관리자 권한으로 실행**하세요. Windows가 관리자 권한을 부여하지 않은 경우 서버를 직접 실행하면 시작 단계에서 종료됩니다.

기여하려면 [기여 가이드](CONTRIBUTING.md)와 [AI 에이전트 기여 지침](AGENTS.md)을 참고하세요.

호스트 PC를 계속 사용하면서 게스트에서 GUI 자동화를 실행할 수 있습니다. 저장된 RPA는 화면과 결과 파일을 로컬에서 확인할 수 있으며, 탐색이나 예외 대응 중 외부 에이전트의 클라이언트가 화면을 요청하면 그 데이터가 전달될 수 있습니다. Vault의 비밀값은 승인된 게스트 연결을 통해 전달할 수 있습니다.

SSH를 통한 원격 GUI 자동화는 [WSL2 원격 MCP 워커 가이드](docs/WSL2_REMOTE_WORKER.md)를 참고하세요.

WSL2 원격 MCP 설치·사용 영상 ([English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.13/17-VAMP-WSL-Remote-MCP-Guide-QHD-en.mp4) · [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.13/17-VAMP-WSL-Remote-MCP-Guide-QHD-ko.mp4)).

[VAMP 영어 소개 영상](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/14-VAMP-Overview-en.mp4)에서 시스템 구조와 시작 방법을 확인할 수 있습니다. [영어 설치 가이드](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/11-VAMP-Install-Guide-X-en.mp4)는 Windows 호스트에서 MCP 패키지와 VSIX를 설치하는 화면부터 VirtualBox에서 Debian이 부팅되는 과정까지 안내합니다.

- AI에서 VAMP MCP와 Vault 사용 ([영어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.12/15-VAMP-MCP-Vault-AI-Walkthrough-QHD-en.mp4) · [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.12/15-VAMP-MCP-Vault-AI-Walkthrough-QHD-ko.mp4))
- 수동 RPA 제작 및 재생 ([영어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.12/16-VAMP-Manual-RPA-Guide-QHD-en.mp4) · [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.12/16-VAMP-Manual-RPA-Guide-QHD-ko.mp4))

[Windows VirtualBox 메모장 검증 한국어 영상](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/04-Windows-VirtualBox-Notepad-QHD-ko.mp4)과 [영어 영상](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/04-Windows-VirtualBox-Notepad-QHD-en.mp4)에서 Robot Framework가 1920×1080 게스트의 메모장을 열고 상태 표시줄의 `Windows (CRLF)`를 확인하는 과정을 볼 수 있습니다.

- Podman · Debian / VirtualBox 구성 영상 ([한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/03-Podman-VirtualBox-QHD-ko.mp4) · [영어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/03-Podman-VirtualBox-QHD-en.mp4))
- [한국어·영어 영상 제작용 Robot Framework 코드](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/VAMP-setup-editions-robot-source.zip)
- [Robot Framework 코드 및 QA 결과](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/VAMP-v0.3.10-demo-source-and-qa.zip)
- [VirtualBox에서 녹화하고 Python 스크립트를 VS Code RPA Library에 등록](docs/USER_GUIDE.md#2-vm에서-녹화한-스크립트를-목록에-넣기)
- [Windows 메모장 예제 녹화](examples/notepad_recording.py)로 [VirtualBox, SPICE 또는 VNC 게스트용 독립 Robot Framework 패키지 만들기](docs/RECORDING_CONVERSION.md#b-게스트-안에서-기록한-pyautogui-코드-변환)
- [재생·수정 시연용 독립 데모 ERP](https://github.com/wayfarer6/vamp-demo-erp)
- VirtualBox ERP 재생 검증 영상 ([한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/05-VirtualBox-ERP-Replay-QHD-ko.mp4) · [영어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/05-VirtualBox-ERP-Replay-QHD-en.mp4))
- VirtualBox 스크래치 복구 검증 영상 ([한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/06-VirtualBox-Scratch-Repair-QHD-ko.mp4) · [영어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/06-VirtualBox-Scratch-Repair-QHD-en.mp4))
- Codex ERP 리허설 편집본. 실제 게스트 녹화와 검토한 소스 포함 ([한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/07-ERP-Rehearsal-QHD-ko.mp4) · [영어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/07-ERP-Rehearsal-QHD-en.mp4))
- [Codex ERP Robot Framework 검증 자료](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/vamp-erp-codex-scratch-evidence.zip)에 검증 시나리오, 실행 보고서, 예제 CSV가 들어 있습니다.
- ERP 화면 변경 후 설치형 MCP로 재생하는 장면 ([영어 화면](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/08-Installed-MCP-ERP-v2-QHD-en.mp4) · [한국어 화면](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/08-Installed-MCP-ERP-v2-QHD-ko.mp4)).
- 테스트 모달 복구 5단계 시연 ([영어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/09-Modal-Recovery-QHD-en.mp4) · [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/09-Modal-Recovery-QHD-ko.mp4)).
- Codex 작성부터 설치형 MCP 재실행까지 담은 ERP 연속 시연 및 자막 ([영어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/10-ERP-Continuous-QHD-en.mp4) · [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/10-ERP-Continuous-QHD-ko.mp4)).
- [ERP 실행 결과와 비교 측정 방법](docs/ROADMAP.md#observed-erp-run)
- [검토된 VirtualBox 시나리오를 실행하고 MCP 채팅에서 CSV 받기](docs/USER_GUIDE.md#채팅에서-erp-csv-받기) (현재 소스 빌드)
- [Vault MCP 또는 VS Code에서 마운트된 VeraCrypt 컨테이너의 파일을 복호화된 사본으로 내보내기](vscode-vault-extension/README.md#export-a-file-from-a-mounted-container) (현재 소스 빌드)

## 💡 왜 VAMP인가요?

ERP에서 매일 주문을 내보낼 때 바뀌는 것은 주문 번호입니다. VAMP는 검토한 작업과 결과 확인 절차를 내 기기에 저장합니다. 다음 실행에서는 MCP를 지원하는 모델에 새 주문 번호만 건네면 됩니다. GUI 작업은 게스트 화면에서 버튼을 확인하고, CLI 작업은 연결한 Linux 게스트 안에서 스크립트를 실행합니다. 화면을 매번 외부 비전 API로 보내는 호출을 줄일 수 있고, 저장한 절차는 팀원과 공유할 수 있습니다.

---

## ⚖️ 기존 방식과의 비교

| 비교 항목 | 화면 기반 CUA | 고정 녹화 RPA | VAMP 저장 RPA |
| --- | --- | --- | --- |
| 비전 토큰 비용 | 화면을 모델에 전달한 횟수와 공급자 사용량에 따라 달라짐 | 고정 재생 중에는 모델 API 호출 없음 | 로컬 재생과 검증에는 공급자 비전 토큰이 들지 않음. AI 보조 수정은 별도로 측정. |
| 실행 시간 | 화면을 판단하는 모델 호출 포함 | 스크립트 입력과 대기 시간 포함 | 게스트 입력, 대기 시간, 설정한 로컬 검사 포함 |
| 화면 배치 변경 후 | 입력 전에 바뀐 화면을 확인할 수 있음 | 불일치를 감지하려면 시작 화면과 결과 검사를 별도로 구현해야 함 | 설정한 시작 화면과 다르면 입력 전에 멈추고 해당 단계의 수정을 요청할 수 있음 |

| Windows VirtualBox ERP 검증 | 소요 시간 | 확인한 결과 |
| --- | ---: | --- |
| 기존 화면 배치에서 저장된 RPA 재생 | 35.97초 | 동작 17개 실행 및 예상 주문 3건이 담긴 새 CSV 확인 |
| 격리 VM 검증과 검토를 마친 RPA 재생 | 54.44초 | 동작 30개 실행 및 새 CSV의 SHA-256 일치 확인 |
| 두 화면 배치를 검증한 Robot Framework 시나리오 | 239.05초 | CSV 2개 일치 및 이전 녹화 재생 시 입력 0건 확인 |

별도 비교 시험에서는 방식과 배치별로 3회씩 실행했습니다. VAMP 저장 RPA는 v1의 CSV 3개를 모두 검증했고 v2에서는 세 번 모두 입력 전에 멈췄습니다. 고정 키보드 재생은 v2에서 CSV 3개 모두 내용 검증에 실패했고, 화면 기반 CUA는 두 배치에서 받은 CSV 6개를 모두 검증했습니다. [시간 중앙값과 증빙](docs/ROADMAP.md#matched-erp-comparison)

---

## ⚡ 핵심 아키텍처 & 기능

### 게스트 제어와 VM 관리

VirtualBox, KVM, Hyper-V는 VM 생성·관리 백엔드입니다. 게스트 화면의 GUI 녹화 재생은 VirtualBox와 로컬 VNC를 제공하는 KVM에서 지원합니다. Hyper-V에서는 VMConnect로 화면을 열 수 있습니다. Python·Playwright CLI 워크플로는 세 백엔드의 Linux 게스트 모두에서 검토한 버전을 SSH로 전달해 rootless Podman 안에서 실행합니다. [CLI 게스트 준비와 예제](docs/CLI_WORKFLOWS.md)

### 화면 검증과 Vault

GUI 재생을 실행하는 호스트의 OCR·YOLO 워커가 게스트 화면을 분석합니다. VAMP Vault는 별도 MCP 서버이며 사용자 승인과 KeePassXC 항목의 볼륨 파일 연결을 확인합니다. Windows의 관리형 마운트는 저장한 키를 WSL VeraCrypt CLI의 표준입력으로 전달합니다. 최초 설정과 Vault 잠금 해제 후에는 승인된 마운트마다 볼륨 키를 다시 입력할 필요가 없습니다. [화면 검증](docs/RECORDED_CLICKS.md) · [Vault 설정](vscode-vault-extension/README.md)

### 📦 게스트 초기 설정

VirtualBox는 빌드 NAT에서 사후 설정 파일을 받습니다. Hyper-V의 Windows 게스트는 선택한 가상 스위치의 호스트 IPv4를 사용하고, Debian 게스트는 오프라인 응답 미디어로 설치한 뒤 고정 네트워크 프로필을 사용합니다. QEMU 기본 빌드 NAT의 호스트 주소는 `10.0.2.2`이며, 배포된 libvirt VM의 네트워크와는 별개입니다. [VM MCP 설정 및 오류 진단](docs/VM_MCP.md)

Hyper-V에서 Debian 골든 이미지를 만들기 전에 WinNAT를 구성한 전용 내부 스위치를 준비하고 게스트에 사용할 고정 IP를 예약하세요. 이전 빌드가 Default Switch의 DHCP 또는 네트워크 preseed 단계에서 멈췄다면 오프라인 응답 ISO를 사용해 새로 빌드하세요. 골든 이미지 내보내기 폴더와 실행용 VM 디스크는 별도로 보관하세요. [Debian Hyper-V 설정 및 복구](backends/packer/debian-hyperv/README.md)

---

## 🚀 빠른 시작

### 1. VS Code 없이 MCP 사용

Node.js 22 이상을 준비하고 MCPB를 지원하는 클라이언트에서 VAMP 번들을 설치하세요. Vault도 쓸 경우 별도 Vault 번들을 추가합니다. Windows의 MCPB 실행에는 관리자 권한으로 시작한 호스트가 필요합니다. 수동으로 받을 때는 릴리즈의 `SHA256SUMS`와 파일 해시를 대조하세요. [VAMP MCP](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.wayfarer6%2Fvamp-mcp/versions/latest) · [Vault MCP](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.wayfarer6%2Fvamp-mcp-vault/versions/latest) · [GitHub Releases](https://github.com/wayfarer6/vamp-mcp/releases)

### 2. VS Code 확장 사용

1. [GitHub 릴리즈](https://github.com/wayfarer6/vamp-mcp/releases)에서 VSIX 파일 두 개를 받아 **Extensions: Install from VSIX**로 설치한 뒤 VS Code를 다시 로드합니다.
2. **VAMP** 사이드바에서 **Open VM Manager**로 VM을, **Open Containers**로 Podman 목록과 데스크톱을, **RPA Library**로 검토한 워크플로를 관리합니다. 자격증명은 별도의 **VAMP Vault**에서 관리합니다.
3. WSL은 [수동 설정 가이드(영문)](vscode-extension/CONTAINERS_WSL.md)를, rootless Podman과 noVNC는 [컨테이너 데스크톱 문서](docs/CONTAINER_DESKTOP.md)를 참고하세요.

Windows 호스트 PowerShell 실행 정책 및 별도의 Hyper-V/CIM 권한 확인은 [Windows 호스트 안내](docs/INSTALL.md#windows-powershell-host)를 참고하세요.

### 작업 기록, 재생, 수정

1. 게스트 초기 설정을 마치고 기록과 재생에 같은 게스트 해상도를 사용합니다. Windows VirtualBox 설치는 초기 설정 후 1920×1080을 사용합니다.
2. **RPA Library**에서 검토된 워크플로를 먼저 찾습니다. 새로 만들려면 게스트에서 작업을 기록하고, 동작을 검토해 민감한 입력을 제거한 뒤 저장합니다. 독립 Robot Framework 패키지는 [PyAutoGUI 변환 가이드](docs/RECORDING_CONVERSION.md)를 참고하세요.
3. 선택한 게스트에서 검토된 작업을 재생합니다. 기대 화면이나 결과 파일을 확인한 뒤 성공 여부를 판단합니다.
4. 화면이 달라졌다면 관련 영역을 확인하고 필요한 동작만 수정합니다. 별도 VirtualBox 게스트에서 수정본을 시험한 뒤 검증된 버전을 검토하고 다시 사용합니다. [기록 및 수정 흐름](docs/WORKFLOWS.md)을 참고하세요.

Windows VirtualBox 또는 로컬 VNC를 사용하는 KVM 게스트에서 UAC 창이 나타날 수 있는 작업을 재생할 때는 `pause_on_uac`를 켜세요. 기록 해상도와 게스트 화면은 모두 1920×1080이어야 합니다. VAMP는 로컬 OCR로 게스트 화면을 확인하고 운영자 확인이 필요하면 재생을 멈춥니다. 게스트 콘솔에서 승인한 뒤 같은 실행을 이어가려면 `uac_wait_seconds`와 대상 앱에서만 보이는 고유한 `uac_resume_text`도 설정하세요. [게스트 UAC 재생 절차](docs/WORKFLOWS.md#guest-uac-replay)를 참고하세요.

---

## 🏗️ 아키텍처 개요

```mermaid
flowchart TD
    subgraph Host ["호스트 머신"]
        Agent["AI 에이전트 / MCP 클라이언트"]
        MCP["VAMP MCP (vamp-mcp)"]
        subgraph VaultService ["VAMP Vault MCP (vamp-mcp-vault)"]
            Vault["Vault 도구 · 사용자 승인"]
            DB["KeePassXC KDBX · 자격 증명과 볼륨 소유 에이전트 ID"]
            VC["VeraCrypt"]
            Vault --> DB
            Vault -->|승인된 Windows 마운트| WSL["WSL VeraCrypt CLI"]
            WSL --> VC
            Vault --> VC
        end
        HTTP["Postinstall Script 서버 :8421"]
        RPA["Robot Framework / Python RPA 실행기"]
        Vision["로컬 YOLO / OCR 워커"]
        Desktop["데스크톱 어댑터"]

        Agent <-->|MCP Stdio 프로토콜| MCP
        Agent <-->|MCP stdio · 도구 호출과 결과| Vault
        MCP --> HTTP
        UI["VS Code · RPA Library"]
        Catalog["검토한 워크플로와 클릭 설정"]
        CLI["CLI 실행기 · SSH"]
        Audit["프로필별 SQLite 감사 기록"]
        MCP --> Catalog
        UI --> Catalog
        Catalog --> RPA
        Catalog --> CLI
        RPA --> Audit
        CLI --> Audit
        Vault --> Audit
        Audit --> Query["MCP 감사 조회 · VS Code 감사 화면"]
        RPA -->|검증을 켠 녹화 클릭| Guard{"기준 점수 이상인 대상이 하나이고 포인터 이동 후에도 안정적인가?"}
        Guard -->|통과| Desktop
        Guard -->|입력 중단| Audit
        RPA -->|키보드 또는 검사를 끈 클릭| Desktop
        Desktop -->|캡처한 화면| RPA
        RPA -->|분석할 이미지| Vision
        Vision -->|탐지 영역·텍스트| RPA
    end

    subgraph Infrastructure ["가상화 추상화 레이어"]
        Packer["Packer (골든 이미지 프로비저닝)"]
        Vagrant["Vagrant & DesktopAdapter"]
        MCP --> Packer
        MCP --> Vagrant
        Packer -->|골든 이미지| Vagrant
        Vagrant -->|VirtualBox / KVM / Hyper-V| VM
    end

    VM["격리된 VM 데스크톱"]
    Container["격리된 데스크톱 컨테이너"]
    CLI --> GuestJob["Linux 게스트 · rootless Podman · 스크립트와 결과 검사"]
    Disk["할당된 VeraCrypt 볼륨"]
    VC --> Disk
    Disk -->|보조 디스크| VM
    Disk -->|지정된 작업 공간| Container
    Vault -->|승인된 자격 증명을 지정 수신기로 전달| VM
    Vault -->|승인된 자격 증명을 지정 수신기로 전달| Container
    Desktop <-->|콘솔 화면 캡처·입력| VM
    Desktop <-->|관리형 RFB 화면 캡처·입력| Container
```

Robot Framework와 Python RPA, 로컬 YOLO·OCR 워커는 제어 호스트에서
실행합니다. 사람이 VM 콘솔을 조작하듯 데스크톱 어댑터가 대상 화면을
캡처하고 키보드·마우스 입력을 보냅니다. 원격 VM은 SSH를 통해 원격
하이퍼바이저 호스트에 콘솔 캡처·입력을 요청하고, 받은 화면은 제어 호스트에서
분석할 수 있습니다. 지원하는 조작은 데스크톱 백엔드에 따라 달라집니다.

MCP 클라이언트는 데스크톱 제어에 VAMP MCP를, 자격 증명과 암호화 볼륨 관리에
VAMP Vault MCP를 각각 호출합니다. 사용자 승인 후 `vault_deliver_credential`은
지정된 수신기에 값을 직접 전달하고 MCP 호출에는 전달 결과를 반환합니다.

---

### 화면을 확인한 순간과 클릭하는 순간이 다를 때 (TOCTOU)

ERP에서 **저장** 버튼을 정확히 읽었어도, 마우스를 그쪽으로 옮기는 동안 도움말이 버튼을 덮거나 목록이 갱신될 수 있습니다. 예전 좌표로 클릭하면 다른 주문을 선택할 수 있습니다. 이처럼 **확인한 시점**(time of check)과 **실제 사용하는 시점**(time of use) 사이에 상태가 바뀌는 문제를 TOCTOU라고 합니다. 인식 점수 99%는 첫 화면을 읽은 모델의 점수입니다. 다음 순간의 화면까지 보장하지는 않습니다. [TOCTOU 정의](https://cwe.mitre.org/data/definitions/367.html)

1. **첫 화면에서 대상을 찾습니다.** 검토한 녹화의 OCR 글자 또는 YOLO 전용 클래스와 맞는 후보가 하나인지, 점수가 기준(기본 90%) 이상인지, 녹화 위치와 가까운지 확인합니다.
2. **포인터를 옮긴 뒤 다시 캡처합니다.** 같은 해상도에서 버튼과 클릭 위치 주변의 픽셀을 첫 화면과 비교합니다. 영역이 그대로일 때만 버튼을 누릅니다. 연속 클릭도 누를 때마다 확인합니다.
3. **화면이 바뀌면 클릭을 보류합니다.** 대상 누락·낮은 점수·호버 후 영역 변화는 새 화면으로 한 번 더 검사합니다. 두 번째에도 실패하거나 같은 후보가 여러 개이면 이후 입력을 멈춥니다. 사용자가 좌표 재생을 명시적으로 선택하면 이 시각 검사를 건너뜁니다.

두 번째 캡처와 입력 전송 사이에도 짧은 간격이 있고, 똑같이 보이는 버튼이 다른 주문을 가리킬 수 있습니다. 주문 내보내기의 성공 조건은 **클릭 후 새 CSV에 요청한 주문 번호가 있는지**처럼 별도로 확인하세요. [클릭 검사 구현](backends/library/click_guard.py) · [호버 예외 설계안](docs/HOVER_TARGETS.md)

### 프로젝트 코드 위치

| 기능 | 찾아갈 곳 |
| --- | --- |
| 녹화와 변환 | [vamp-recorder.py](guest_setup/recorder/vamp-recorder.py) · [recording_converter.py](recording_converter.py) |
| GUI 재생과 클릭 검증 | [replay.py](backends/library/replay.py) · [click_guard.py](backends/library/click_guard.py) |
| CLI 워크플로와 실행 | [cli-catalog.cjs](backends/library/cli-catalog.cjs) · [cli-runs.cjs](backends/library/cli-runs.cjs) |
| 감사 저장 및 화면 | [audit.cjs](backends/common/audit.cjs) · [audit-panel.cjs](backends/common/audit-panel.cjs) |
| Vault MCP와 마운트 | [server.mjs](vscode-vault-extension/backends/vault/server.mjs) · [vault_cli.mjs](vscode-vault-extension/src/vault_cli.mjs) |
| VS Code와 MCP 배포 | [vscode-extension](vscode-extension) · [registry](registry) |

## 🌐 커뮤니티 스크립트 허브

바퀴를 다시 발명하지 마세요. **[VAMP Script Hub](https://wayfarer6.github.io/vamp-script-hub/)**에서 이미 검증된 커뮤니티 RPA 스크립트를 바로 이용할 수 있습니다:
- 주요 포털 자동 로그인 (네이버, 구글, 깃허브, 슬랙)
- 기업용 전자결재 및 PDF 인쇄 자동화
- 데이터 수집 및 상태 업데이트 정기 작업

---

## 🔒 책임 한계와 안전한 사용 (Responsible Use)

VAMP는 로컬 자동화 및 보안 인프라 연구를 위해 제작된 오픈소스입니다.
- **사용자 승인**: 민감한 작업에는 명시적 사용자 확인이 필요합니다.
- **격리된 샌드박스**: 게스트 VM 내부에서 실행된 스크립트와 에이전트 조작의 최종 책임은 사용자 본인에게 있습니다.
- **오픈소스 라이선스**: 코드는 [MIT 라이선스](LICENSE)를 따릅니다. 타사 구성 요소는 해당 라이선스를 준수합니다 ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
