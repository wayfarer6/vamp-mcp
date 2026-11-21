# VAMP video guides · 영상 모음

| Guide / 종류 | 한국어 | English |
| --- | --- | --- |
| 구간 재사용·편집·체크포인트 재개 / Reuse, edit and resume steps | [한국어 영상](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.18/reusable-steps-ko.mp4) · [자막](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.18/reusable-steps-ko.srt) | [English video](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.18/reusable-steps-en.mp4) · [Captions](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.18/reusable-steps-en.srt) |
| VM 수동 녹화와 YOLO 검토 / Manual recording and YOLO review | [한국어 영상](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.17/manual-recorder-ko.mp4) · [자막](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.17/manual-recorder-ko.srt) | [English video](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.17/manual-recorder-en.mp4) · [Captions](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.17/manual-recorder-en.srt) |
| 월말 창고 결산 · LibreOffice / Month-end warehouse close | [한국어 영상](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.16/warehouse-close-workflow-ko.mp4) · [자막](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.16/warehouse-close-workflow-ko.srt) | [English video](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.16/warehouse-close-workflow-en.mp4) · [Captions](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.16/warehouse-close-workflow-en.srt) |
| 결과 미리 보기 / Result demo · 0:30 | [30초 데모](https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/docs/media/vamp-result-ko.mp4) · [자막](media/vamp-result-ko.srt) | [30-second demo](https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/docs/media/vamp-result-en.mp4) · [Captions](media/vamp-result-en.srt) |
| 설치·AI 연결·첫 사용 / Installation, AI connection and first task | [영상](https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/docs/media/vamp-first-run-ko.mp4) · [자막](media/vamp-first-run-ko.srt) | [Video](https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/docs/media/vamp-first-run-en.mp4) · [Captions](media/vamp-first-run-en.srt) |
| VirtualBox · KVM · Hyper-V 구조 / Architecture | [영상](https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/docs/media/vamp-architecture-ko.mp4) · [자막](media/vamp-architecture-ko.srt) | [Video](https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/docs/media/vamp-architecture-en.mp4) · [Captions](media/vamp-architecture-en.srt) |
| 실제 VM 생성·게스트 화면 / VM creation and guest consoles | [실습 영상](https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/docs/media/vamp-vm-lab-ko.mp4) · [자막](media/vamp-vm-lab-ko.srt) | [Lab video](https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/docs/media/vamp-vm-lab-en.mp4) · [Captions](media/vamp-vm-lab-en.srt) |
| 로그 감사 / Audit logs | [영상 · 2:08](media/vamp-audit-log-ko.mp4) · [자막](media/vamp-audit-log-ko.srt) | [Video · 1:51](media/vamp-audit-log-en.mp4) · [Captions](media/vamp-audit-log-en.srt) |
| SQLite 감사 화면 / Search runs in VS Code | [실습 · 1:00](media/vamp-sqlite-audit-ko.mp4) · [자막](media/vamp-sqlite-audit-ko.srt) | [Walkthrough · 0:47](media/vamp-sqlite-audit-en.mp4) · [Captions](media/vamp-sqlite-audit-en.srt) |

## 감사 로그 따라 보기 · Read the audit log

**한국어.** KVM에 연결된 AI에게 “가상 머신 목록을 보여 줘”라고 요청하세요. Linux KVM 원격 MCP 서버를 실행한 계정으로 작업 폴더를 여세요. 영상 **0:32**에서 파일 위치를, **0:52**에서 실제 로그 두 줄을 확인할 수 있습니다. 서버를 `--workdir`로 실행했다면 아래 첫 줄의 경로를 해당 디렉터리로 바꾸세요.

**English.** Ask your KVM-connected AI to list the virtual machines. On the Linux KVM host, open the work directory as the user running the remote MCP server. Jump to **0:25** for the file location or **0:44** for the two observed rows. If the server was started with `--workdir`, substitute that directory on the first line.

```sh
cd "${VAMP_REMOTE_WORKDIR:-$HOME/.vamp/remote}"
tail -n 2 tool-audit.jsonl
stat -c '%a %n' tool-audit.jsonl
```

| 확인한 내용 | Observed behavior |
| --- | --- |
| Linux KVM에서 VM 목록 조회는 `returned`, 잘못된 테스트 ID로 상태 조회는 `error`로 남았습니다. 별도 감사 호출은 0회였고 두 행에는 시각·도구·결과만 있었습니다. | Two ordinary calls produced two rows with a timestamp, tool and outcome. The list request returned a response. An invalid status lookup produced an error. File mode was `600`. |
| 임시 Vault를 사용한 테스트에서 대상에 전달할 수 없는 경우에도 `credential_resolved`가 남았습니다. 마운트는 해당 환경의 볼륨 목록에서 확인하세요. | The temporary Vault test recorded credential resolution even when the destination was unavailable. A delivery receipt and an observed mount are separate evidence. |
| 마지막 장면은 촬영 당시 CLI 개발판의 **Run history**입니다. v0.3.15에서 출시된 통합 감사 화면은 [SQLite 감사 실습](media/vamp-sqlite-audit-ko.mp4)에서 확인하세요. | The final chapter shows **Run history** as it appeared in the earlier CLI development build. The [SQLite walkthrough](media/vamp-sqlite-audit-en.mp4) shows the unified audit panel shipped in v0.3.15. |

KVM 및 Vault 검증에 사용한 소스 / Source used for the KVM and Vault checks: [6e90a7b](https://github.com/wayfarer6/vamp-mcp/tree/6e90a7bf06b991f6084e8aef311505f7fb2752f4).

## 한국어 실습

**00:00–00:30**에는 VirtualBox 게스트와 VS Code의 연결 화면이 나옵니다. **00:30**부터 같은 환경에서 따라 할 수 있습니다. **01:53**에 KVM, **02:21**에 Hyper-V 장면이 시작됩니다. 설치 대기 시간은 편집했습니다. [촬영에 사용한 GitHub 릴리스 v0.3.13](https://github.com/wayfarer6/vamp-mcp/releases/tag/v0.3.13)

**내 PC에서 실행하는 Claude Code나 Codex에는 아래 문장을 그대로 보내세요.**

```text
https://github.com/wayfarer6/vamp-mcp
이 Windows PC에 GitHub 공식 릴리스의 VAMP MCP를 설치해 줘. 배포 파일의 SHA-256을 RELEASE-SHA256SUMS와 대조하고 지금 쓰는 AI에 연결해 줘. VirtualBox VM 목록을 조회해서 연결을 확인해 줘.
```

1. **준비.** Windows 호스트에 VirtualBox 7을 설치합니다. 촬영에서는 v0.3.13의 MCP 패키지와 VSIX를 사용했습니다. 같은 버전으로 따라 하려면 AI에게 버전을 지정하세요. 편집기에서 화면을 보려면 관리자 권한으로 VS Code를 열고 **Extensions: Install from VSIX**에서 릴리스의 확장을 설치한 뒤 창을 다시 로드하세요.
2. **원본.** AI에 `vm_golden_images`로 완료된 Debian 이미지를 찾아 달라고 하세요. 각자 표시되는 이미지 ID를 사용합니다. 촬영에는 이전에 설치를 마친 원본이 쓰였습니다. 처음 설치한다면 **VAMP: Open VM Manager → VirtualBox**에서 Debian 설치 ISO와 새 이름을 지정하고 **Create and Start**를 선택하세요. 게스트 설치가 완료되어야 가져오기를 시작할 수 있습니다. 같은 호스트와 같은 VAMP 데이터 폴더를 사용하세요.
3. **생성.** “그 이미지로 `VAMP-Release-VBox-1121`이라는 새 VM을 만들고, 승인 전에 원본과 새 이름을 보여 줘.” 본인 PC에 그 이름이 있으면 다른 이름을 고르세요. 미리보기를 확인하고 승인하면 `vm_golden_image_import`가 `imported`와 새 `vm_id`를 반환합니다.
4. **확인.** “방금 받은 VM ID로 `vm_start`를 GUI 모드로 실행해 줘.” Debian 화면이 뜨면 VS Code에서 **VAMP: Open VM Manager → VirtualBox → 같은 이름 → Start / View Screen**을 누르세요. 영상에서는 편집기에 **Connected**와 바탕화면이 함께 표시됩니다.

## English walkthrough

**00:00–00:30** shows the VirtualBox result. **00:30** starts the verified Windows follow-along. The KVM chapter starts at **01:35** and Hyper-V at **01:58**. Installation waits are condensed. [GitHub release used for the recording](https://github.com/wayfarer6/vamp-mcp/releases/tag/v0.3.13)

**Paste this into Claude Code or Codex running on your PC.**

```text
https://github.com/wayfarer6/vamp-mcp
Install VAMP MCP on this Windows PC from the official GitHub release. Verify the downloaded package against RELEASE-SHA256SUMS, connect it to this AI client, and list my VirtualBox VMs to confirm the connection.
```

1. Install VirtualBox 7 on Windows. To match the recording, ask for v0.3.13. To view the guest inside the editor, run VS Code as administrator, use **Extensions: Install from VSIX** to install the released extension, then reload the window.
2. Ask the AI to list completed Debian images with `vm_golden_images`. Use your own image ID. The recording starts with an installed golden image. On a fresh host, open **VAMP: Open VM Manager → VirtualBox**, select the Debian installer ISO, give the VM a new name and finish **Create and Start** first. Use the same host and VAMP data directory in the MCP client and the extension.
3. Ask, “Create a VM named `VAMP-Release-VBox-1121` from this image. Show me the source and the new name before I confirm.” Pick a different name if it already exists. After approval, `vm_golden_image_import` returns `imported` and a new `vm_id`.
4. Ask, “Start that VM ID in GUI mode with `vm_start`.” After the guest desktop appears, choose **VAMP: Open VM Manager → VirtualBox → the same name → Start / View Screen**. The verified end state shows **Connected** and the guest desktop inside the editor.

## 촬영 환경 / Recording evidence

| Backend | 한국어 | English |
| --- | --- | --- |
| VirtualBox | Windows 11. 배포된 MCP로 골든 이미지를 가져와 부팅한 뒤, 같은 VM의 Debian 바탕화면을 배포된 VSIX에서 열었습니다. | Windows 11. The released MCP imported the golden image and booted it. The released VSIX opened the same VM’s Debian desktop. |
| KVM | Ubuntu / WSL 2, 실제 `/dev/kvm`, `qemu:///session`. 배포된 MCP가 ISO에서 빌드했고, 빌드 게스트의 Debian 환영 화면을 확인했습니다. 배포 VM은 VNC에서 부트 화면이 보인 뒤 중첩 KVM 하드웨어 오류로 일시 정지했습니다. 배포 VM 로그인은 미검증입니다. | The released MCP built from ISO on Ubuntu / WSL 2 with `/dev/kvm` and `qemu:///session`. The build guest reached the Debian welcome screen. The deployed VM displayed its boot screen over VNC, then paused with a nested KVM hardware error. Login on the deployed VM was unverified. |
| Hyper-V | Windows 11, 내부 스위치와 WinNAT, Debian DVD. 첫 실행은 Windows가 RAM 3072 MB를 할당하지 못해 중단됐습니다(`0x800705AA`). 다른 게스트를 멈추고 2048 MB로 새로 생성하자 VAMP가 설치, 게스트 설정, 재부팅 후 시작을 확인했습니다. 같은 이름의 배포 VM을 VMConnect로 열어 Debian 환영 화면을 촬영했습니다. | Windows 11, internal switch with WinNAT and Debian DVD. Windows could not allocate 3072 MB in the first run (`0x800705AA`). With the other guests stopped and a fresh 2048 MB request, VAMP verified installation, guest setup and startup after reboot. VMConnect showed the deployed guest’s Debian welcome screen. |

KVM과 Hyper-V에서는 릴리스 MCP의 `vm_create`에 각각 `backend=kvm`, `backend=hyperv`를 지정했습니다. Linux에서는 로컬 VNC, Windows에서는 VMConnect로 게스트 화면을 열었습니다. 촬영용 ISO는 Debian 13.7 amd64 DVD-1입니다.

On KVM and Hyper-V, the release MCP received `vm_create` with the corresponding backend and a Debian 13.7 amd64 DVD-1 ISO. The KVM viewer connected to local VNC. On Windows, the v0.3.13 console helper opened the external VMConnect window.

[설치 명령과 첫 실행 실습 / First-run guide](FIRST_RUN.ko.md) · [VM Manager user guide](USER_GUIDE.md) · [Hyper-V backend](../backends/hyperv/README.md)

## 릴리즈별 추가 실습 · More recorded guides

| 실습 / Guide | 한국어 | English |
| --- | --- | --- |
| Debian · MCP |  [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/01A-Debian-MCP-QHD-ko.mp4) | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/01A-Debian-MCP-QHD-en.mp4) |
| Windows 11 · MCP |  [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/01B-Windows11-MCP-QHD-ko.mp4) | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/01B-Windows11-MCP-QHD-en.mp4) |
| Debian · VS Code |  [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/02A-Debian-VSCode-QHD-ko.mp4) | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/02A-Debian-VSCode-QHD-en.mp4) |
| Windows 11 · VS Code |  [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/02B-Windows11-VSCode-QHD-ko.mp4) | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/02B-Windows11-VSCode-QHD-en.mp4) |
| Podman · VirtualBox |  [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/03-Podman-VirtualBox-QHD-ko.mp4) | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/03-Podman-VirtualBox-QHD-en.mp4) |
| Windows 메모장 검증 / Notepad check |  [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/04-Windows-VirtualBox-Notepad-QHD-ko.mp4) | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/04-Windows-VirtualBox-Notepad-QHD-en.mp4) |
| ERP 화면 재생 / ERP replay |  [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/05-VirtualBox-ERP-Replay-QHD-ko.mp4) | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/05-VirtualBox-ERP-Replay-QHD-en.mp4) |
| 테스트 VM에서 녹화 수정 / Scratch repair |  [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/06-VirtualBox-Scratch-Repair-QHD-ko.mp4) | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.10/06-VirtualBox-Scratch-Repair-QHD-en.mp4) |
| ERP 사전 연습 / Rehearsal |  [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/07-ERP-Rehearsal-QHD-ko.mp4) | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/07-ERP-Rehearsal-QHD-en.mp4) |
| 화면 변경 후 설치본 재생 / Changed-layout replay |  [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/08-Installed-MCP-ERP-v2-QHD-ko.mp4) | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/08-Installed-MCP-ERP-v2-QHD-en.mp4) |
| 팝업 복구 / Modal recovery |  [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/09-Modal-Recovery-QHD-ko.mp4) | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/09-Modal-Recovery-QHD-en.mp4) |
| ERP 제작부터 재실행 / End-to-end ERP |  [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/10-ERP-Continuous-QHD-ko.mp4) | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/10-ERP-Continuous-QHD-en.mp4) |
| 설치 실습 / Installation guide | — | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/11-VAMP-Install-Guide-X-en.mp4) |
| 개요 / Overview | — | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.11/14-VAMP-Overview-en.mp4) |
| AI 연결 · VAMP MCP & Vault |  [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.12/15-VAMP-MCP-Vault-AI-Walkthrough-QHD-ko.mp4) | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.12/15-VAMP-MCP-Vault-AI-Walkthrough-QHD-en.mp4) |
| 수동 녹화 / Manual RPA |  [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.12/16-VAMP-Manual-RPA-Guide-QHD-ko.mp4) | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.12/16-VAMP-Manual-RPA-Guide-QHD-en.mp4) |
| WSL2 원격 MCP / Remote MCP |  [한국어](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.13/17-VAMP-WSL-Remote-MCP-Guide-QHD-ko.mp4) | [English](https://github.com/wayfarer6/vamp-mcp/releases/download/v0.3.13/17-VAMP-WSL-Remote-MCP-Guide-QHD-en.mp4) |
