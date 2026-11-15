# Hyper-V / VMConnect 백엔드 — Experimental / Windows 테스트용

기존 `rpas/`는 Linux QEMU/KVM + SPICE 계열입니다. 이 폴더는 **Windows 호스트의 Hyper-V 경로**를 별도로 관리합니다. 현재 `windows-RPA`라는 게스트도 Ubuntu/KVM에서 실행한 것이며, Hyper-V 호스트에서 검증한 VM을 뜻하지 않습니다.

현재 구현 범위:

- Windows PowerShell Hyper-V 모듈로 정확한 VM 이름을 조회합니다.
- `--start-vm`을 지정한 경우에만 꺼진 VM을 기동합니다.
- 관리자가 아니면 정상 Windows UAC의 `runas`로 승인을 요청합니다.
- 관리자 프로세스가 `vmconnect.exe <server> <VMName>`을 실행합니다.
- 짧은 JSON과 Robot 보고서를 저장합니다.

**Ubuntu에서 코드를 작성했으며 Windows/Hyper-V에서 실행 검증하지 않았습니다. 사용자가 Windows에서 테스트할 코드입니다.** RDP 화면 스트림·키보드·마우스 제어 어댑터는 아직 구현하지 않았습니다. VMConnect 창 실행과 실제 게스트 접속/로그인 성공은 별개입니다.

## Windows 호스트에서 준비

Hyper-V 기능과 관리 도구, 실행 가능한 Windows PowerShell/Hyper-V 모듈이 필요합니다. 저장소 루트의 PowerShell에서:

```powershell
py -m venv .venv-hyperv
.\.venv-hyperv\Scripts\python.exe -m pip install -r backends\hyperv\requirements.txt
```

## Python으로 실행

```powershell
# 이미 실행 중인 VM 연결
.\.venv-hyperv\Scripts\python.exe backends\hyperv\scripts\vmconnect.py --vm "Windows 11"

# 꺼져 있으면 기동한 뒤 연결
.\.venv-hyperv\Scripts\python.exe backends\hyperv\scripts\vmconnect.py --vm "Windows 11" --start-vm

# 다른 Hyper-V 서버의 VM: 별도 서버 접근 권한도 필요
.\.venv-hyperv\Scripts\python.exe backends\hyperv\scripts\vmconnect.py --vm "Windows 11" --server HOSTNAME
```

`Windows 11`은 실제 Hyper-V VM 이름으로 바꾸세요. UAC 승인은 사용자가 직접 합니다. 스크립트는 UAC를 자동 승인하거나 비밀번호를 저장하거나 시스템 보안 설정을 변경하지 않습니다. PowerShell 명령은 Unicode/인자 전달을 위해 인코딩하며 VM 이름을 실행 코드로 보간하지 않습니다.

이미 관리자 PowerShell이라면 `.ps1`을 직접 실행할 수도 있습니다. 해당 호스트의 스크립트 실행 정책을 따라야 하며, 이 코드가 영구 실행 정책을 변경하지는 않습니다.

```powershell
.\backends\hyperv\scripts\Open-HyperVConsole.ps1 -VMName "Windows 11" -StartVM -ResultPath "$PWD\artifacts\hyperv\console-result.json"
```

## Robot으로 실행

```powershell
.\.venv-hyperv\Scripts\python.exe -m robot --variable "VM_NAME:Windows 11" --variable START_VM:True --outputdir artifacts\hyperv-console backends\hyperv\rpas\console\run.robot
```

빈 VM 이름은 UAC 전에 차단합니다. 결과는 `summary.json`, 실제 관리자 작업 결과는 `native-result.json`, 보고서는 `report.html`입니다. Python CLI의 기본 결과 파일은 `artifacts/hyperv/console-result.json`입니다.

`status: launch_requested`는 Hyper-V에서 VM의 Running 상태를 확인하고 VMConnect 프로세스를 시작했다는 뜻입니다. **`guest_connection_verified: false`이므로 게스트 로그인이나 화면 연결 성공을 주장하지 않습니다.** UAC 거절은 `elevation_or_launch_rejected`, 결과 파일 대기 시간 초과는 `launch_unverified`, PowerShell 오류는 `error`입니다. 시간 초과 후에는 기존 콘솔/UAC 상태를 확인하고 중복 기동하지 마세요.

## RDP 확장 방향

Hyper-V Enhanced Session은 RDP 기반입니다. 일반 RDP나 VMConnect Enhanced Session을 통해 자동화하려면 RDP 화면 수신과 입력을 다룰 어댑터를 추가해야 합니다. `vmconnect.exe`를 켰다고 기존 `SpiceInputsChannel` API를 사용할 수 있는 것은 아닙니다. 영상 영역/배율을 확보한 뒤 공통 OCR·YOLO를 연결하고, OS별 Robot 작업은 유지하는 구조로 확장합니다. 프로그램 기동은 Windows Win+R을 사용하며 바탕화면 아이콘 좌표에 의존하지 않습니다.

Linux용 `scripts/model_service.py`는 별도 백그라운드 모델 프로세스용이며 Windows 네이티브 런타임으로 포팅했다고 주장하지 않습니다. Hyper-V RDP 어댑터를 붙일 때 모델 서비스 연결 방식도 별도 설계해야 합니다.

공식 문서: [VMConnect](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/virtual-machine-connection), [Enhanced Session/RDP](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/use-local-resources-virtual-machine-connection).
