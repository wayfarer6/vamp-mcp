# 원격 MCP와 Windows PDF 출력 재현

Ubuntu 컨트롤러가 SSH stdio로 하이퍼바이저 호스트의 MCP 서버를 실행합니다. Robot Framework가 서버에 화면 캡처·조합키·텍스트·마우스 입력을 요청하고, 로컬 YOLO·OCR 워커가 필요한 화면을 확인합니다. PDF는 출력 후 별도 파일 교환으로 가져와 서명·제작자·내용·SHA-256을 검사합니다. 텍스트 계층이 없는 출력은 PDF를 렌더링해 OCR로 검증합니다.

## 테스트 구성

- Ubuntu + AMD Ryzen 7 5800H + NVIDIA에서 libvirt 세션 KVM 실행.
- 외부 Windows 11 Pro VM: RAM 8192MiB, 1소켓·8코어·1스레드, `host-passthrough`와 SVM 노출.
- Windows 호스트: VirtualBox 7.2.22와 같은 버전 Oracle Python SDK, Node 22.23.5, Python 3.12.
- 중첩 Debian: RAM 3072MiB·2 vCPU·24GiB 디스크. 원본 DVD에서 테스트 계정과 Openbox 자동 로그인을 지정한 전용 ISO를 생성.
- 공개 랩 계정은 `vboxuser` / `password123!`. 개인 업무 데이터나 실제 ERP 계정은 사용하지 않음.

## 원격 서버

Linux 원격 서버는 다음처럼 실행합니다. SSH 로그인 셸이 기본 PATH에 Node를 넣지 않는다면 절대 실행 경로를 지정합니다.

```bash
ssh -T -o BatchMode=yes you@linux-host \
  '/absolute/node /absolute/vamp-mcp/backends/remote_ssh/server.mjs --backend kvm --libvirt-uri qemu:///session'
```

Windows 네이티브 원격 서버는 PowerShell에서 실행합니다. 확장 프로그램의 POSIX 자동 업로더와는 별도 설정입니다. Windows SSH 키와 ACL 설정은 [Microsoft의 키 인증 문서](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)를 참고하세요. 테스트 포트 포워딩은 Ubuntu 루프백에만 바인딩합니다.

```powershell
& 'C:\path\node.exe' 'C:\vamp-mcp\backends\remote_ssh\server.mjs' `
  --backend virtualbox --repo 'C:\vamp-mcp' `
  --python 'C:\vamp-mcp\.venv-virtualbox\Scripts\python.exe' `
  --vboxmanage 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
```

일반 SSH MCP 클라이언트에서는 위 PowerShell 명령을 UTF-16LE Base64로 인코딩해 `powershell.exe -NoProfile -EncodedCommand <값>`을 원격 명령으로 전달할 수 있습니다. 비밀번호는 명령에 넣지 않습니다.

`remote_vm_send_keys.keys`는 순차 키 입력이고 `hotkey`는 `['super','r']`나 `['ctrl','p']` 같은 동시 조합키입니다. VirtualBox 마우스 입력에는 `--repo` 및 일치하는 Python SDK가 필요합니다. 좌표는 캡처한 게스트 화면의 0..1 비율입니다.

## PDF와 녹화

[RPA 사용법](../rpas/windows_print_pdf/README.md)에 따라 실행합니다. 테스트 송장에는 번호 `VAMP-2026-001`과 합계 KRW 192,500이 들어 있습니다. 실제 ERP 연결은 이 시나리오에 포함하지 않습니다.

두 게스트 화면은 1920×1080으로 고정합니다. Robot listener `spice_recording.RecordingListener:2560:1440:False`는 원본을 확대하지 않고 QHD 캔버스에 여백을 추가합니다. 결과 JSON의 `guest_dimensions`와 `padded`로 구분합니다. 영상 최종화 뒤 전체 프레임 디코딩 검사와 해시 확인을 수행해야 합니다.

## 모델과 비용의 범위

Linux Python MCP 서버는 시작 시 두 워커를 미리 띄우고 종료 뒤에도 유지합니다. `VAMP_PRELOAD_MODELS=0`이면 사전 로드를 끌 수 있으며, 실제 추론 시에는 필요한 워커를 시작합니다. 원격 Node 서버와 Windows 네이티브 서버가 자체적으로 Windows용 OCR·YOLO를 설치했다는 뜻은 아닙니다. 이번 원격 구성에서는 Ubuntu 컨트롤러가 모델 추론을 수행합니다.

RPA 재실행 자체에는 LLM API 호출이 없습니다. 로컬 추론, VM, 전력·실행 시간, 최초 작업 작성 및 UI 변경 시 보정 비용은 남습니다. 유료 CUA 대비 절감률을 수치로 주장하려면 별도 동일 작업 비교가 필요합니다.

## 확인한 결과

2026-11-16, 중첩 Windows 랩과 현재 Ubuntu 호스트에서 확인했습니다.

| 경로 | 실제로 확인한 결과 |
| --- | --- |
| Ubuntu SSH → KVM/Windows | MCP 초기화·목록·화면·조합키·원격 클릭, Microsoft Print to PDF 파일 생성 및 PDF 렌더링 OCR/해시 검증 |
| Ubuntu SSH → Windows 네이티브 MCP → VirtualBox/Debian | 설치된 Linux 바탕화면, 키보드로 Firefox 실행, SDK 클릭 뒤 페이지 문구 변경의 OCR 검증 |
| VSIX의 0.1.8 원격 서버 → Windows | 실제 stdio 초기화·VM 목록·기동, SDK 포인터 이동 요청 성공 및 FHD 캡처. 이동 요청 성공은 별도의 앱 성공 판정으로 세지 않음 |
| 화면과 영상 | 두 게스트 FHD 1920×1080, Robot listener의 QHD 2560×1440 여백 캔버스, 2fps, MP4 전체 디코딩 검사 |
| Windows 설치 재실행 | PowerShell 5.1의 Python 인자 따옴표 문제와 ISO 유래 읽기 전용 파일 문제를 수정하고 실제 `configured` 및 PyAutoGUI/pynput 메타데이터 검증 |

Windows 초기 재부팅에서는 업데이트가 종료를 지연했고, Edge 최초 설정 화면도 인쇄를 가로막았습니다. 실제 초기 설정을 마친 테스트 프로필을 사용합니다. 원격 로그인 세션의 디스플레이 변경 결과만으로 물리 콘솔 해상도를 판단하지 않고, 재부팅 후 실제 게스트 캡처와 WMI 1920×1080을 별도로 확인했습니다. 새 KVM VM에도 FHD 비디오 설정과 Windows VGA 메모리 64MiB를 적용합니다.

[Windows 원격 영상 메타데이터](media/windows-remote-fhd-qhd.json), [PDF 출력 영상 메타데이터](media/remote-windows-print-pdf.json), [PDF 검증 결과](media/remote-windows-print-pdf-verification.json)를 공개합니다. 실제 업무 ERP, 물리 Windows 호스트, Windows 네이티브 모델 워커 이식은 이 검증에 포함하지 않습니다.

릴리스 검사: Python 84개·확장 34개 테스트, 두 RPA dry-run, Windows 호스트 원격 입력과 PDF 최초 실행·재실행의 실제 Robot 검증을 통과했습니다. [요약 증거](media/remote-validation-summary.json). 재실행은 `VERIFY_OCR:False`로 초기 송장 화면 OCR·YOLO만 생략하며, 프린터 확인과 PDF 내용 검증은 유지합니다. 유료 CUA나 다른 에이전트와의 비용 비교 실험은 아닙니다.

## 영상 타임스탬프

- Windows 호스트 원격 입력: 00:00 게스트 터미널 입력과 Firefox 실행, 00:42 클릭 전 문구 OCR, 00:51 SDK 마우스 클릭, 00:54 변경된 문구 OCR. 전체 약 64초.
- Windows PDF 출력: 00:00 Win+R 및 Edge 실행, 00:11 송장 화면 OCR·YOLO, 00:33 프린터 확인 및 인쇄, 01:03 실제 PDF 렌더링 OCR·해시 검사. 전체 약 68초.
- PDF 재실행: 초기 송장 화면 OCR·YOLO를 생략하고 프린터와 출력 PDF는 다시 검증. 전체 약 44초. 검사항목이 다른 두 실행의 시간이며 LLM 비용 비교 수치가 아님.
