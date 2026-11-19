# VAMP 실사용 QA 시나리오

Windows와 Linux **제어 호스트**에서 GitHub 배포본으로 VS Code 확장과 독립 MCP를 검증한다. 테스트 작업은 격리된 데스크톱에서 샘플 요청을 받아 결과 파일을 저장하고, 별도 승인으로 테스트 계정에 로그인하는 흐름이다. macOS 실기기 검증은 [별도 이슈](https://github.com/wayfarer6/vamp-mcp/issues/7)에서 추적한다.

## 준비

| 제어 호스트 | 대상 | 검증 범위 |
| --- | --- | --- |
| Windows | 로컬 VirtualBox 테스트 VM | 확장 설치, VM 화면·입력, 호스트 RPA, Vault 승인 |
| Windows | Windows 호스트의 Hyper-V 또는 VirtualBox 테스트 VM | WSL 기반 암호화 VHD 생성과 VM 보조 디스크 연결 |
| Linux | 로컬 libvirt/KVM 또는 SSH로 연결한 Linux KVM | 설치된 확장, 독립 MCP, 원격 화면과 연결 실패 처리 |
| Windows | SSH로 연결한 같은 PC의 WSL Ubuntu | VS Code 원격 연결 확인, KVM 사용 가능 시 원격 VM 화면 확인 |
| 네이티브 Linux | 동일 사용자 rootless Podman의 Debian 데스크톱 | 승인된 VeraCrypt 작업공간 연결과 실제 파일 읽기·쓰기 |

- [GitHub 릴리스](https://github.com/wayfarer6/vamp-mcp/releases/latest)에서 VAMP Tools와 Vault VSIX, 두 MCP 압축 파일, `SHA256SUMS`를 받는다. 오프라인 프로비저닝을 시험할 경우 같은 릴리스의 자산 번들도 받는다. Windows는 `Get-FileHash -Algorithm SHA256 <파일>`, Linux는 다운로드 폴더에서 `sha256sum --ignore-missing -c SHA256SUMS`를 사용한다. 설치에 사용할 모든 파일의 결과가 일치하는지 확인한다.
- 임시 VS Code 프로필과 확장 디렉터리, 새 테스트 KDBX, 테스트 VM·컨테이너를 준비한다. 케이스별로 제어 호스트 OS, 백엔드와 버전, 게스트 OS, 배포 버전, 대상 UUID 또는 전체 컨테이너 ID를 기록한다.
- 테스트 앱은 오프라인 폼 또는 격리된 내부 테스트 사이트를 사용한다. 입력 레코드는 `QA-042`, 제목은 `샘플 요청`, 결과 파일은 `result-QA-042.txt`, 내용은 `QA-042 COMPLETED`로 정한다. 폼에 완료 표시와 파일 저장 기능이 없으면, 게스트 텍스트 편집기에서 해당 문구를 저장하고 파일을 다시 여는 작업으로 대체한다. 비밀번호가 필요한 경우 전용 테스트 값과 사용자가 구성한 수신기만 쓴다.
- 화면 좌표를 사용하는 케이스는 게스트 프레임버퍼가 1920×1080이고 배율이 100%인지 확인한다. 컨트롤러에서 Robot/Python 및 YOLO/OCR을 실행하고, VM 콘솔이나 관리형 RFB에서 받은 게스트 화면으로 동작을 확인한다. OCR/YOLO를 설치하지 않은 경우 모델 검증은 미실행으로 기록한다.

## 1. VS Code 확장 설치와 대상 확인 · Windows 및 Linux

1. 새 임시 디렉터리의 절대 경로를 사용해 두 VSIX를 설치한다. 파일명은 받은 버전과 맞춘다. 같은 격리 프로필로 `--list-extensions --show-versions`를 실행해 두 확장과 버전을 기록한다.

   ```text
   code --user-data-dir "<임시 프로필>" --extensions-dir "<임시 확장 디렉터리>" --install-extension "<VAMP Tools VSIX>"
   code --user-data-dir "<임시 프로필>" --extensions-dir "<임시 확장 디렉터리>" --install-extension "<VAMP Vault VSIX>"
   code --user-data-dir "<임시 프로필>" --extensions-dir "<임시 확장 디렉터리>" "<테스트 작업 폴더>"
   ```

2. 설치된 확장에서 **Open VM Manager**, **Open Containers**, Vault 뷰를 연다. 초기 빈 상태 또는 실제 대상 목록이 표시되고, 새로고침과 창 크기 변경 후에도 제어 항목에 접근할 수 있는지 확인한다. 호스트에 없는 백엔드는 사용 불가 상태로 기록한다.
3. VS Code가 제공한 **VAMP MCP**와 **VAMP Vault** 등록을 확인한다. 같은 서버를 수동 설정으로 중복 등록하지 않는다. 테스트 VM만 선택해 UUID를 대조하고 화면을 연다. 디스크 목록이나 실행 상태는 대상 식별에 사용하고, 부팅 성공은 테스트 앱이 보이는 화면으로 판정한다.

**합격 기준** — 설치된 버전과 대상이 일치하고 각 화면이 정상 상태 또는 명확한 오류 상태를 표시한다. 등록과 목록 조회만으로 새 VM이나 컨테이너가 생기지 않는다.

## 2. 첫 골든 이미지, VM 생성과 삭제 · Windows 및 Linux

1. 골든 이미지가 없는 테스트 저장 위치를 마련한다. Windows에서는 VirtualBox 또는 Hyper-V, Linux에서는 KVM을 고른다. Debian 데스크톱 설치 ISO를 준비하고 배포처 체크섬을 대조한다. 골든 이미지와 실행 VM 디스크가 각각 들어갈 여유 공간, RAM, CPU를 확인한다. Windows 게스트도 시험할 경우 별도 테스트로 진행하고 유효한 설치 미디어와 라이선스를 준비한다.
2. 설치된 VS Code 확장의 **Open VM Manager**에서 백엔드를 선택한다. **Choose installation ISO**로 ISO를 고르고 새 이름(예: `VAMP-QA-042`)을 입력한 뒤 **Create and Start** 확인 창에서 호스트와 사양을 확인한다. 승인 창에서 취소하면 목록과 저장 위치에 새 VM이나 이미지가 생기지 않는지 먼저 확인한다. 독립 MCP에서는 로컬의 `vm_packer_prepare` → `vm_create` → `vm_golden_images`, 원격 KVM의 `remote_vm_create` → `remote_golden_images` 경로를 검증한다. 원격 생성은 SSH 호스트 기준 ISO 경로와 `confirmed: true`가 필요하다. 각 경로를 나눠 시험하면 다른 VM 이름과 작업 디렉터리를 사용한다.
3. **Golden images**에서 빌드 상태를 확인한다. Packer의 OS 설치와 첫 재부팅 뒤 Postinstall Script 자동 실행, 골든 이미지 내보내기, 별도 실행 VM 디스크 배포를 각각 확인한다. 자동 설치가 멈췄다면 빌드 로그를 남긴다. 수동으로 설치를 이어간 경우에는 자동 설치 성공으로 기록하지 않는다.
4. 빌드가 `completed`이면 골든 이미지 ID·파일 크기·로그 경로와 신규 VM UUID를 기록한다. 게스트 데스크톱이 열리고 준비된 앱 또는 녹화 도구가 실행되는지 확인한다. 골든 이미지와 실행 디스크의 경로가 다름을 확인하고, 실행 VM 안에 테스트 파일을 저장한 뒤에도 골든 이미지 해시가 유지되는지 비교한다.
5. 테스트 VM을 정상 종료하고 Vault 디스크를 연결했다면 먼저 분리한다. 로컬 **VM Manager**에서 해당 UUID의 삭제를 선택해 처음에는 취소하고 인벤토리가 유지되는지 확인한다. 다음 시도에서는 **Delete VM and Disks**를 승인하고 해당 VM과 실행 디스크가 사라졌는지 확인한다. 원격 VM 삭제는 SSH 대상 호스트의 하이퍼바이저 관리 화면이나 승인된 호스트 관리 절차에서 수행한다.
6. 삭제 후에도 골든 이미지가 보이고 원래 해시가 유지되는지 확인한다. 별도로 골든 이미지 삭제도 검증할 경우 테스트 이미지 ID와 경로를 확인하고 승인한다. **Delete golden image** 또는 `vm_golden_image_delete` / `remote_golden_image_delete`를 사용하고 이미지와 해당 빌드 로그만 정리되는지 확인한다.

**합격 기준** — 최초 빌드에서 골든 이미지와 실행 VM을 확인하고, 게스트에서 자동 설정 결과를 확인한다. VM 삭제와 골든 이미지 삭제는 별도 승인으로 검증하며, VM을 삭제해도 원본 이미지가 유지된다.

## 3. 요청 처리 RPA 실행과 재사용 · Windows 및 Linux

1. 지정 VM의 테스트 앱에서 요청 `QA-042`를 연다. 예시 RPA가 없는 새 라이브러리에서 시작해, 이 테스트용 시나리오를 작성하거나 검토한 패키지를 테스트 카탈로그에 가져온다.
2. 화면 상의 요청 ID와 제목 입력란을 기준으로 대상을 식별한다. 호스트에서 캡처한 화면의 해당 영역만 OCR로 읽고, 일치 결과가 하나일 때 입력한다. 제출 후 화면의 완료 표시와 결과 파일의 이름·내용을 각각 확인한다.
3. VirtualBox 또는 KVM에서 `rpa_search`와 `rpa_details`로 저장한 패키지와 입력 계약을 확인한다. 동일한 시작 상태로 되돌린 뒤 정확한 VM UUID와 테스트 입력으로 승인받아 `rpa_run_saved`를 호출한다. Hyper-V 디스크 QA에는 이 재생 경로를 적용하지 않는다.
4. 시작 화면을 일부러 바꿔 요청 ID가 일치하지 않는 케이스를 실행한다. 경고 또는 실패가 표시되고, 잘못된 입력이나 제출이 이어지지 않는지 확인한다.

**합격 기준** — 첫 실행과 재생에서 새 결과 파일과 정확한 문구를 확인한다. 입력 호출만 성공하거나 결과가 `completed_unverified`이면 결과 확인 미완료로 기록한다.

## 4. 승인된 자격 증명 전달 · 확장 및 독립 MCP

1. 확장 테스트 프로필의 Vault에서 전용 항목을 준비한다. 수신기와 대상 VM 또는 컨테이너 ID를 확인하고, VAMP로 테스트 앱의 빈 입력란에 포커스를 맞춘다. 이 단계의 자격 증명 전달 전후에는 녹화와 화면 캡처를 일시 중지한다.
2. VS Code와 별도로 검증할 때는 `npm install --prefix "<임시 MCP 디렉터리>" "<VAMP MCP 압축 파일>" "<Vault MCP 압축 파일>"`로 설치한다. [MCP 등록 가이드](MCP_REGISTRATION.md)에 따라 설치 경로의 두 실행 파일을 별도 등록한다. 채팅 승인 경로는 MCP form elicitation을 지원하는 클라이언트를 사용한다. VAMP로 대상을 제어하고, Vault에서 `vault_deliver_credential`을 호출한다.
3. 테스트 목적지와 항목이 승인 화면에 표시되는지 확인한다. 먼저 거절해 입력란이 비어 있는지 확인한다. 다음 요청을 승인하고 전달 결과를 확인한다. 제출을 별도로 승인한 경우에만 테스트 로그인을 진행하고, 로그인 성공 화면 또는 별도 앱 상태를 확인한다.

**합격 기준** — 거절 시 전달이 없고, 승인 시 지정 수신기만 값을 받는다. MCP 결과와 공유 증거에는 비밀번호가 남지 않는다. 승인을 표시할 수 없는 클라이언트는 실패 케이스로 기록한다.

## 5. 암호화 작업 저장과 회수 · Windows VM 및 Linux Podman

1. Vault에서 `owner_agent_id`를 `qa-agent-01`로 지정해 관리형 VeraCrypt 볼륨을 만든다. 사용자가 승인한 테스트 KDBX에서 `VeraCrypt/` 항목의 소유자 ID를 확인한다. 증거에는 ID와 항목 경로만 남긴다.
2. **Windows VM**은 WSL의 VeraCrypt와 `qemu-img`를 준비하고 `format: "guest-vhd"`로 만든다. VM 종료를 확인한 뒤 `vault_attach_vm`으로 지정 보조 슬롯에 연결한다. 게스트에서 VeraCrypt로 잠금을 해제해 결과 파일을 쓰고 다시 열어 읽는다. VM을 종료하고 `vault_detach_vm`으로 분리한다. Linux KVM에서 같은 방식으로 재현할 경우 보조 virtio 슬롯의 `target`과 libvirt 연결을 지정한다.
3. **Linux 컨테이너**는 [컨테이너 작업공간 가이드](CONTAINER_DESKTOP.md)의 네이티브 Linux 설정으로 검증한다. 볼륨을 열고 초기에 만든 전용 디렉터리에서 승인 전 연결을 시도해 거부되는지 확인한다. Vault의 `vault_attach_container`에 준비 확인 후 받은 `binding`과 `approval_id`를 넘기고 사용자 승인 뒤 `confirm: true`로 호출한다. 데스크톱 앱에서 `/workspace/result-QA-042.txt`를 저장하고, 호스트의 승인된 작업 디렉터리에서 정확한 내용을 다시 읽는다. **Open Containers**에서도 새 데스크톱과 화면이 보이는지 확인한다.
4. 컨테이너에서는 앱을 닫고 VAMP의 `podman_workspace_detach`에 전체 ID와 확인한 연결 정보·`confirmed: true`를 넘긴다. 연결이 사라진 뒤 볼륨을 잠근다. VM에서는 보조 디스크가 사라진 것을 인벤토리로 확인한다. 삭제를 시험할 때는 테스트 볼륨에만 `vault_delete_volume`을 호출하고 파일과 활성 KDBX 항목이 사라졌는지 확인한다.

**합격 기준** — 소유자 ID가 KDBX에 있고, 지정한 대상에서만 실제 파일을 읽고 쓸 수 있으며, 분리 후 볼륨을 안전하게 정리할 수 있다. Windows WSL은 VM용 VHD 생성 경로이며, 이 컨테이너 연결 케이스는 네이티브 Linux에서 실행한다.

## 6. VS Code 창에서 원격 SSH 검증 · Windows 및 Linux에서 연결

### Windows에서 WSL Ubuntu를 SSH 대상으로 사용

1. WSL Ubuntu에 테스트용 OpenSSH 서버와 공개키 인증을 준비한다. VS Code는 **Windows에서** 1번의 격리 프로필로 실행한다. Windows에서 접근 가능한 주소와 포트를 사용하고, Windows OpenSSH가 사용하는 키 파일 경로를 설정한다. 같은 PC에서만 시험할 때는 루프백을 우선 확인하고, SSH 대상의 호스트 키 지문을 Ubuntu에서 확인한 값과 대조한다.
2. VS Code 명령 팔레트에서 **VAMP: Open Remote Desktop Manager (SSH)**를 연다. **Save connection**에서 SSH 호스트·포트·사용자·키와 libvirt URI를 지정하고 **Verify environment**를 실행한다. 서버 배치가 필요하면 권한을 확인한 뒤 **Prepare remote environment**를 사용한다. 검증 결과에서 SSH 인증, 원격 실행 환경, libvirt 접근을 각각 기록한다.
3. WSL Ubuntu 내부에서 같은 SSH 사용자로 `test -c /dev/kvm && test -r /dev/kvm && test -w /dev/kvm` 및 `virsh -c "<선택한 libvirt URI>" list --all`을 확인한다. 실제 부팅 가능한 테스트 VM이 있을 때만 아래의 화면·입력 단계로 넘어간다. SSH만 되고 KVM·libvirt·VM 중 하나가 준비되지 않았다면 SSH 연결은 별도 판정하고, VM 검증은 차단으로 기록한다. 같은 VS Code 시나리오는 별도 Linux KVM 호스트로도 진행할 수 있다.

### VS Code에서 원격 데스크톱과 MCP를 함께 확인

1. Remote Desktop Manager에서 원격 VM을 새로고침하고 테스트 VM의 이름·UUID를 대조한다. 꺼진 테스트 VM은 승인 후 **Start**하고, **Screenshot**에서 테스트 앱이 표시될 때까지 상태를 확인한다. 지원되는 KVM 구성에서는 **VAMP Remote: Open Live Viewer**도 실행해 화면을 확인하고 닫으면 해당 포워딩이 해제되는지 확인한다.
2. 같은 VS Code 창의 MCP 클라이언트에서 VAMP의 `remote_vm_list`, `remote_vm_status`, `remote_vm_screenshot`을 호출한다. 매니저에서 확인한 VM과 같은 UUID 및 화면인지 확인한다. 입력이 필요하면 승인한 테스트 VM의 빈 편집기에 무해한 문자열을 보내고 새 화면에서 결과를 확인한다.
3. 테스트 SSH 연결을 끊고 매니저에서 새로고침한다. 오류가 표시되고 로컬 VM으로 전환되지 않는지 확인한다. SSH를 복구하고 **Verify environment**를 다시 실행해 같은 원격 VM의 목록과 화면이 돌아오는지 확인한다.

### 독립 프록시 재접속 확인

1. 테스트 Linux KVM 호스트에 키 인증과 호스트 키 확인을 준비한다. [원격 설정 가이드](REMOTE_SETUP.md)에 따라 배포 MCP의 `bootstrap`과 `proxy`를 사용한다. 원격 도구 목록에서 `remote_vm_list`, `remote_vm_status`, `remote_vm_screenshot`를 실행해 테스트 VM의 인벤토리와 실제 화면을 함께 확인한다.
2. 확장에서 원격 뷰어를 지원하는 테스트 대상이면 뷰어를 열어 화면을 확인한다. 뷰어를 닫은 뒤 해당 세션의 로컬 포워딩이 해제됐는지 확인한다.
3. 대기 상태에서 전용 테스트 SSH 연결을 끊는다. 아직 연결할 수 있다면 재연결 후 같은 대상의 상태 조회가 성공하는지 확인한다. 원격 접속이 계속 불가능하면 재시도 한 번 뒤 `remote_session_lost`로 종료하고 로컬 대상 상태는 바뀌지 않는지 확인한다.

**합격 기준** — 원격 대상의 화면과 도구 결과가 일치한다. 연결 실패가 드러나고, 테스트에 지정하지 않은 대상에 입력이 전달되지 않는다.

## 결과 기록

| 케이스 | 호스트·백엔드 | 배포 버전 | 기대 결과 | 실제 결과·증거 경로 | 판정 |
| --- | --- | --- | --- | --- | --- |
| 5 Linux 컨테이너 | Linux / rootless Podman | 실행 시 기입 | 작업 파일 재조회 및 분리 | 실행 시 기입 | 미실행 |

판정은 **통과**, **실패**, **차단**, **미실행**으로 기록한다. 차단이면 빠진 전제 조건을 적는다. UI 상태, 테스트 파일 내용, MCP 반환 상태는 필요한 부분만 남기고 비밀번호, 토큰, 테스트 외 경로와 개인 데이터는 공유 자료에서 제외한다. 실행 후 테스트 프로필과 연결을 닫고 테스트 작업공간을 정리한다.
