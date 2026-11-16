# VAMP Guest Vault & Passkey Setup Guide

이 문서는 VAMP 에이전트 가상머신(VirtualBox, KVM, Hyper-V) 프로비저닝 후 게스트 OS에 **RPA 레코더**, **KeePassXC(패스키 지원)**, **VeraCrypt CLI**, 그리고 **단일 `vault.vhd` 보조 디스크 연결**을 구성하는 표준 절차를 정리합니다.

---

## 1. 아키텍처 개요

1. **단일 VHD 디스크 (`vault.vhd`)**:
   - 호스트에서 단일 VHD 포맷으로 볼트 디스크를 생성하고 그 안에 암호화된 VeraCrypt 컨테이너(`vault.hc`)를 저장합니다.
   - **KVM**: `-drive file=vault.vhd,format=vpc` (QEMU 네이티브 VPC 드라이버)
   - **VirtualBox**: `VBoxManage storageattach <VM> --storagectl SATA --port 1 --device 0 --type hdd --medium vault.vhd`
   - **Hyper-V**: `Add-VMHardDiskDrive -VMName <VM> -ControllerType SCSI -Path vault.vhd`
2. **게스트 사후 설치 훅 (`setup-all.ps1` / `setup-all.sh`)**:
   - RPA 레코더 설치: PyAutoGUI, Tkinter, 가상환경 구성
   - KeePassXC 설치 및 Native Messaging Host 등록: Chrome/Edge 브라우저 확장과 연동해 패스키(Passkey)를 게스트 브라우저에서 투명하게 사용
   - VeraCrypt CLI 설치 및 `/m rm` 마운트 헬퍼 등록: `Mount volume as removable media` 플래그로 마운트하여 윈도우 및 금융 보안 프로그램이 이를 '이동식 USB 플래시 드라이브'로 인식하도록 보장

---

## 2. 게스트 실행 방법

### Windows 게스트
게스트 데스크톱 사용자 세션에서 PowerShell로 실행합니다:
```powershell
powershell -ExecutionPolicy Bypass -File .\guest_setup\setup-all.ps1
```

- 완료 후 바탕화면에 `RPA-Recorder` 및 `VAMP-Vault\Mount-Vault-USB.cmd`가 생성됩니다.
- `Mount-Vault-USB.cmd`를 실행하면 연결된 VHD 드라이브(`D:\` 등)에서 `vault.hc`를 자동 감지하고 `/m rm` 플래그로 가상 외장 USB로 마운트합니다.

### Linux 게스트
게스트 데스크톱 사용자 세션에서 실행합니다:
```bash
sh ./guest_setup/setup-all.sh
```

---

## 3. 금융권 공인인증서(NPKI) 및 패스키 동작 원리

- **공인인증서(NPKI)**: 은행/증권사 보안 모듈은 일반 하드디스크나 네트워크 공유 폴더를 '이동식 디스크'로 인식하지 않습니다. VeraCrypt의 `/m rm` (Removable media) 옵션으로 마운트함으로써 가상 드라이브에 외장 USB 속성이 부여되어 인증서 선택창의 **'이동식 디스크'** 탭에 정상 노출됩니다.
- **패스키(Passkeys)**: KeePassXC는 v2.8+부터 WebAuthn/FIDO2 패스키 저장을 지원합니다. 게스트 브라우저(Chrome/Edge/Firefox)에 `KeePassXC-Browser` 확장을 설치하고 `setup-guest-vault.ps1`이 등록한 Native Messaging Host와 연결되면, 브라우저의 패스키 인증 팝업이 게스트 KeePassXC로 전달되어 자동으로 서명됩니다.
