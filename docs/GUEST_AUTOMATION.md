# VAMP 게스트 초기 설정·녹화·세션 보존

## 최초 실행과 VM 생성 전 확인

VS Code의 첫 안내 또는 `VAMP: First-Time VM Setup`에서 호스트 VirtualBox 설치를 확인합니다. 없으면 [공식 다운로드](https://www.virtualbox.org/wiki/Downloads)를 안내합니다. AI가 호스트 설치를 맡는 경우 OS·권한·드라이버·실행 중 VM을 먼저 확인하고 사용자가 요청한 범위에서 설치합니다. 실행 중인 VM이 있는데 하이퍼바이저 패키지를 임의 교체하지 않습니다.

기본 게스트는 Debian GNOME입니다. ISO와 사양을 정하면 무인 설치 스크립트가 진행합니다. Windows는 별도로 선택했을 때만 생성합니다. Windows 전용 보안 프로그램을 쓰는 업무라면 해당 환경을 준비해야 합니다.

Windows 11 설치 ISO와 유효한 라이선스는 사용자가 직접 구해야 합니다. VAMP에는 Windows ISO·제품 키·라이선스가 포함되지 않으며, 설치 후 설정 → 시스템 → 정품 인증도 사용자가 진행합니다. 인증 우회 기능은 제공하지 않습니다. 공개 테스트 비밀번호는 OS 라이선스를 대신하지 않습니다.

현재 관찰한 VirtualBox 사양을 `backends/virtualbox/profiles.json`에 기록했습니다.

| 프로필 | RAM | CPU | 동적 디스크 최대 용량 | 기준 |
| --- | --- | --- | --- | --- |
| Windows 11 | 4096 MB | 2 | 256000 MiB (250 GiB) | Win-RPA |
| Debian | 2048 MB | 2 | 256000 MiB (250 GiB) | Debian-RPA |
| Ubuntu GNOME | 2048 MB | 2 | 256000 MiB | Debian 리소스 재사용; 실제 Ubuntu VM 미검증 |

가상 디스크 최대 용량이 즉시 전부 할당되는 것은 아닙니다. ISO는 호스트 파일 경로를 지정해야 합니다. 기본 계정 `vboxuser / password123!`는 공개 테스트용입니다.

생성 없이 사전 검사만 하려면 MCP `vm_create`의 `preflight_only:true`를 사용합니다. ISO 감지 오류/무인 설치 미지원은 준비 완료가 아닙니다. 현재 Ubuntu 배포판 VirtualBox에서 Debian 13.7 DVD ISO의 `DetectIsoOS()`가 `NS_ERROR_NOT_IMPLEMENTED`를 반환하는 경우를 확인했으므로, 지원 가능한 호스트 빌드/ISO를 확인하기 전 실제 생성 성공을 주장하지 않습니다.

## Debian: 첫 로그인과 CD-ROM 저장소 제거

`guest_setup/recorder/configure-debian-mirrors.py`는 게스트의 `/etc/os-release`에서 설치된 codename을 읽고 CD-ROM 저장소를 제거합니다. Debian 13에서는 다음을 사용합니다.

- `https://deb.debian.org/debian`: `trixie`, `trixie-updates`
- `https://security.debian.org/debian-security`: `trixie-security`

공식 keyring 검증을 유지하며 설치된 릴리스를 다른 버전으로 올리지 않습니다. 변경 전 APT 설정은 작은 파일 백업으로 보존합니다. VM 스냅샷을 생성하는 것은 아닙니다. 새 VM은 post-install 단계에서 설정 후 `apt-get update`를 수행합니다.

이미 설치된 VM은 일반 사용자에게 sudo 권한이 없을 수 있습니다. `su root` 후 설치 스크립트의 `install-debian-root.sh vboxuser`를 실행하면 네트워크 미러·필수 패키지·사용자 레코더 설치를 순서대로 수행합니다.

VAMP는 ISO를 xorriso로 리마스터링하지 않고, `guest_setup/`을 호스트 파이썬 HTTP 서버(8421)로 제공합니다. 게스트 root 터미널에서 다음처럼 같은 스크립트를 내려받아 실행할 수 있습니다(VirtualBox NAT 기준, libvirt 기본 NAT는 `192.168.122.1`).

```bash
# 호스트: python3 scripts/script_server.py start
# 게스트 root 터미널
wget -qO /tmp/vamp-setup.tar.gz http://10.0.2.2:8421/vamp-guest-setup.tar.gz
mkdir -p /opt/vamp-setup && tar -xzf /tmp/vamp-setup.tar.gz -C /opt/vamp-setup
python3 /opt/vamp-setup/recorder/configure-debian-mirrors.py
apt-get update
sh /opt/vamp-setup/recorder/install-debian-root.sh vboxuser
```

오프라인 미디어를 계속 쓸 경우에는 `/media/cdrom0` 또는 `/media/<user>/<label>` 등 실제 마운트 경로를 확인하세요.

호스트에서 Robot으로 첫 로그인/터미널 설정을 처리하려면 `backends/virtualbox/rpas/debian_first_boot/run.robot`을 사용합니다. `LOGIN_REQUIRED:True`이면 Enter로 로그인 프롬프트를 띄운 뒤 **영문 Password 화면을 OCR로 확인한 경우에만** 테스트 비밀번호를 입력합니다. 터미널과 root 프롬프트도 확인하고, `VAMP_APT_OK` 단독 출력으로 성공을 판정합니다. 개인 VM 암호는 환경 변수 `VAMP_GUEST_PASSWORD`, `VAMP_ROOT_PASSWORD`를 사용하며 Robot 인자에 넣지 마세요. 이미 로그인된 화면이면 LOGIN_REQUIRED를 false로 둡니다.

## 매 로그인마다 게스트 자체 1920×1080 재적용

설치기에서 `install-display-startup.py`를 실행합니다. Windows는 현재 사용자의 Startup에 `VAMP-Display.cmd`, GNOME은 `~/.config/autostart/vamp-display.desktop`을 등록합니다. **매 부팅 후 사용자 로그인마다 반복**하며 성공해도 자동 등록을 삭제하지 않습니다. 로그인 전 잠금 화면/GDM까지 변경하는 시스템 서비스는 아닙니다.

- Windows: GraphicsDrivers Configuration 레지스트리를 **읽기만** 하고 `EnumDisplaySettingsW`/`ChangeDisplaySettingsExW`의 테스트·적용 API를 사용합니다. 레지스트리 캐시를 임의 수정하거나 ActiveX를 설치하지 않습니다. Windows 업데이트 후에도 로그인 때 다시 실행합니다. 드라이버가 거부하면 needs_attention으로 남깁니다.
- Debian/Ubuntu GNOME: 사용자 세션의 Mutter DisplayConfig D-Bus에서 지원 모드를 읽어 1920×1080/배율 1/가로를 검증한 뒤 persistent 설정을 요청합니다. GNOME 디스플레이 설정 API이며 root/GDM 세션에서 실행하지 않습니다. 다중 모니터는 임의로 끄지 않습니다.

결과는 Windows `%LOCALAPPDATA%\VAMP\display\result.json`, GNOME `~/.local/share/vamp/display/result.json`입니다. `resolution_verified:true`인지 확인하고, 호스트 `vm_configure_display`의 PNG 픽셀 크기와 비교하세요. 요청만 전송됐거나 API가 실패했으면 성공이 아닙니다. OS 배율·브라우저 배율은 별도 확인 대상입니다.

## 새 레코더와 공유 저장

바탕화면 `RPA-Recorder`의 Windows `Start-Recorder.cmd`, GNOME `start-recorder.sh`로 엽니다. 새 VAMP UI는 Start recording → Stop → Save Python, Open save folder, Copy last path를 제공합니다. F8도 시작/중지에 사용할 수 있습니다. 재생/eval 기능은 넣지 않았습니다.

MCP `vm_recording_share` action prepare가 사용자 홈의 `~/VAMP/recordings/<VM>-<hash>`에 공유 폴더를 만듭니다. Windows는 `\\VBOXSVR\VAMPRecords`, Linux는 보통 `/media/sf_VAMPRecords` 또는 사용자가 마운트한 `~/VAMP-Shared`입니다. **Guest Additions/shared-folder 지원이 있어야 합니다.** 실행 중인 VM의 공유는 transient로 추가하므로 다음 실행/세션에서 다시 prepare해야 합니다. 신규 VAMP VM은 생성할 때 영구 공유를 설정합니다.

레코더는 쓰기 가능한 공유 경로를 찾으면 **SHARED WITH HOST**, 아니면 게스트 로컬 `recordings/`와 **LOCAL ONLY**를 표시합니다. 후자의 경우 호스트 자동 접근이 된다고 주장하지 않습니다. Linux 자동 마운트 권한에 vboxsf 그룹이나 수동 마운트가 필요할 수 있으며 그룹 변경 후 로그아웃/로그인해야 합니다.

저장하면 `rpa_<시간>.py`와 `.handoff.json`이 생깁니다. 사용자에게 **VM 이름 + 저장한 파일 경로 + 원하는 성공 조건**을 알려 달라고 안내하세요. MCP inspect로 목록/선택한 파일의 텍스트를 읽되 실행하지 않습니다. 암호·인증서 개인키·CAPTCHA 풀이를 녹화하지 않습니다.

```json
{"vm":"Win-RPA","action":"inspect"}
{"vm":"Win-RPA","action":"inspect","filename":"rpa_....py"}
```

공유 폴더가 없을 때는 명시적으로 지정한 게스트 `RPA-Recorder` 아래 `.py`/`.handoff.json`을 `vm_import_recording`으로 가져올 수도 있습니다. 기존 Guest Additions와 승인된 VM 계정이 필요합니다. 기본 공개 테스트 비밀번호 외 개인 계정은 서버 환경 변수로 설정합니다. 파일을 AST/JSON으로 검사하며 실행하지 않습니다. 기존 변환기는 SPICE 대상이므로 VirtualBox 대상의 Robot/Python 입력 라이브러리에 맞게 검토해야 합니다.

수정한 `vamp-recorder.py`는 GPL-3.0 파생 프로그램이며 LICENSE를 함께 배포합니다. 호스트 MCP/설치 결합 코드는 MIT입니다.

## 세션별 스냅샷

AI는 세션 시작 시 필요 여부와 추가 공간을 설명하고 선택을 받습니다. 사용자가 거절하면 현재 세션에서 다시 촬영하거나 재질문하지 않습니다. 실제 시험 결과는 [검증 기록](VALIDATION.md)에 있습니다.

`vm_snapshot`은 list/take/restore/restore_initial을 지원합니다. 촬영은 선택사항이며, 실행 중 VM은 메모리 상태와 변경 디스크로 추가 공간을 쓸 수 있습니다. **촬영 시점만** 보존하며 이후 변경을 자동 저장하는 기능이나 독립 백업은 아닙니다. 세션 종료 시점까지 보존하려면 그 시점에 별도 촬영이 필요합니다.

초기 기준점은 사용자가 `VAMP-initial` 이름으로 지정해 촬영한 경우에만 있습니다. 복원은 정확한 대상과 이후 변경 손실을 사용자에게 확인받고 `confirm_restore:true`로 호출해야 합니다. VM이 전원 꺼짐 상태가 아니면 거절하며 자동 종료하지 않습니다. 사용자가 요청하지 않은 실제 복원 테스트는 하지 않습니다.

참고: [Microsoft Startup 안내](https://support.microsoft.com/en-us/windows/experience/startup-boot/configure-startup-applications-in-windows), [Windows display API](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-changedisplaysettingsexa), [Debian SourcesList](https://wiki.debian.org/SourcesList), [GNOME DisplayConfig](https://gitlab.gnome.org/GNOME/mutter/-/blob/main/data/dbus-interfaces/org.gnome.Mutter.DisplayConfig.xml).

실제 Debian 검증에서는 배포판 기본 커널 드라이버만으로 GNOME의 모드와 VirtualBox 캡처 크기가 일치하지 않아, 호스트와 같은 **Guest Additions 7.2.6**을 설치하고 재부팅했습니다. Linux Guest Additions는 root에서 build-essential/dkms/현재 커널 headers를 준비한 뒤 호스트의 일치하는 ISO 안 `VBoxLinuxAdditions.run --nox11`로 설치합니다. 사용 중 공유 폴더 때문에 모듈 재로드가 거절되면 설치 로그를 확인하고 재부팅합니다. 호스트 캡처 크기가 맞기 전에는 녹화 좌표의 정합성을 확정하지 않습니다.

중단된 VM을 `vm_start`로 시작할 때는 녹화 공유를 먼저 등록해, VM 시작 전 가능한 경우 영구 설정으로 남깁니다. 이미 실행 중인 VM에 transient로 붙였던 공유는 호스트 오류/VM 전원 종료 뒤 다시 prepare해야 할 수 있습니다.

`install-linux-additions.sh`는 Debian 계열 게스트 root에서 일치하는 Guest Additions ISO가 `/dev/sr0`에 연결되었을 때 사용할 수 있는 보조 스크립트입니다. 현재 커널 headers를 구할 수 없거나 빌드가 실패하면 중단하며 커널을 임의 업그레이드하지 않습니다. 설치 후 vboxsf 그룹과 재로그인/재부팅을 확인하세요. Oracle의 mount.vboxsf 헬퍼는 일부 일반 fstab 옵션(예: nofail)을 거부할 수 있어, 첫 부팅 RPA에서는 VAMPRecords를 명시적 uid/gid 옵션으로 마운트합니다. 영구 자동 마운트는 Guest Additions 서비스와 사용자 vboxsf 그룹을 우선 사용하세요.


## Debian GNOME unattended installation (2026-11-17)

VirtualBox renders its unattended template from the common `guest_setup/http/debian-preseed.cfg` through `backends/common/guest_install.py`. The template installs `task-gnome-desktop`, GDM and Xorg and preserves the VirtualBox postinstall hook. If a selected Debian ISO cannot be detected by VirtualBox (including Debian 13.7 DVD on 7.2.22), provisioning instead starts the stock ISO with EFI, waits 10 seconds and types GRUB commands that fetch `guest_setup/http/debian-preseed.cfg` from the temporary host Python HTTP server. NAT host-loopback access is enabled so `10.0.2.2:8421` reaches that server. No Inject Bootstrap action is required.

Hyper-V Generation 2 uses the same HTTP CFG through its Default Switch host IPv4 address and synthetic keyboard. This path is implemented but has not been tested on a Hyper-V guest. The host must allow guest access to TCP 8421. Other OS installers remain manual on Hyper-V.

Both Debian paths invoke `postdeb.sh` during the installer late-command stage. It downloads the recorder bundle, configures GNOME Xorg and installs the recorder for `vboxuser`. `/var/lib/vamp/guest-setup.complete` is written only after that script succeeds. The public sandbox credentials are `vboxuser` / `password123!`. Installation startup is not proof of completion. No snapshot is created by provisioning.

Windows initial provisioning sends Enter once after a 10-second wait. Later VM starts and installer reboots do not receive unsolicited keys.


Host support is separate from guest OS support. `backends/common/host-backends.cjs` routes the common lifecycle interface to `virtualbox/desktop.cjs`, `hyperv/desktop.cjs` or `kvm/desktop.cjs`. Host capability policy and shared boot sequences live in `backends/common/guest-install.json`. VirtualBox supports Windows/Linux/macOS hosts; Hyper-V is Windows-only; KVM is Linux-only. Apple Hypervisor is reserved for macOS and reported as not implemented. Existing amd64 install profiles separately require an x64 host; this does not restrict VirtualBox management on Apple Silicon. MCP and VSIX use the same VirtualBox adapter and Python provisioner. npm packages copy the VSIX runtime rather than maintaining another implementation.


Validation on the current Windows host, 2026-11-17: VirtualBox 7.2.22 with the stock Debian 13.7 amd64 DVD completed HTTP preseed installation, HTTP postinstall/bundle download and reboot without further input. The resulting GNOME 48.7 X11 session reached 1920x1080; the successful guest setup marker and executable recorder launcher were checked from the desktop terminal. No snapshots were created. Evidence: `artifacts/autoinstall-validation/result.json` and `final-verified.png`. This validates VirtualBox here; Hyper-V, Linux/macOS execution and Apple Hypervisor implementation are not established by this run.


Windows first-login setup passes an encoded PowerShell command through VirtualBox, avoiding nested quotes/pipes in VBOXPOST.CMD logging. It downloads the post-install entrypoint with retries and executes it without another login or AI key injection. `postinstall-result.json` records completed/failed under the guest ProgramData setup folder; recorder setup writes its own `installation.json`. Guest session policy disables automatic sleep and screensaver locking. Debian GNOME receives the equivalent idle/sleep/lock policy. The post-create notice includes a recovery setup command and a manual Debian Xorg resolution command because 1920x1080 retention is not guaranteed.

Manual Windows Inject Bootstrap opens PowerShell as administrator through Win+R and Ctrl+Shift+Enter, then sends Left and Enter to the UAC consent prompt. It requires an administrator consent account; credential prompts and organizational UAC policies need manual handling. Before setup, the shell checks administrator rights and sets `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted -Force`. This affects only the setup process. Sent keys are not proof of elevation or installation: verify the guest setup result and current screen.

Guest setup registers `apply-display.py` for every desktop login through Windows Startup or GNOME autostart. Each run retries 1920x1080 and records `result.json`; registration alone does not prove the resolution. These hooks run again after a restart and desktop login. Keep guest auto-resize disabled and check fresh framebuffer dimensions before automation.
