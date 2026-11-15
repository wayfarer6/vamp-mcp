# VM 해상도 1920×1080과 Scaled Mode

**Debian GNOME과 Windows의 게스트 OS 자체 해상도는 모두 1920×1080으로 설정합니다.** 호스트에서 관전하는 VirtualBox 창은 **View → Scaled Mode**로 작게 표시합니다. 창을 줄이는 것과 VM 해상도를 낮추는 것은 다른 동작입니다. RPA 녹화/YOLO/OCR/마우스 좌표는 항상 원본 게스트 픽셀을 사용합니다.

| 항목 | 기준 |
| --- | --- |
| 게스트 화면 | 1920×1080, 가로 방향, 주 모니터 1개 |
| 게스트 OS UI 배율 | 100% |
| 브라우저 확대/축소 | 100% |
| 호스트 관전 창 | Scaled Mode; 창 크기는 자유롭게 축소 |
| Auto-resize Guest Display | 꺼짐; 창 크기로 게스트 해상도가 바뀌지 않도록 함 |

1920×1080 바탕화면이라도 초기 BIOS/부팅/설치 화면은 다른 해상도로 표시될 수 있습니다. VAMP는 이를 설정 완료로 오인하지 않습니다. 다른 모니터/배율/로그인 화면에는 기존 좌표를 검증 없이 적용하지 마세요.

## Windows 11 게스트 설정

1. **Guest Additions 설치**: VAMP가 Windows VM 생성 시 호스트의 `VBoxGuestAdditions.iso`를 찾으면 전용 DVD 슬롯에 삽입합니다. 삽입만 자동으로 하고 설치/UAC 승인은 사용자가 합니다. Windows 탐색기 → 내 PC → **VirtualBox Guest Additions CD 드라이브** → `VBoxWindowsAdditions.exe` 실행 → UAC 승인 → 설치 → 재부팅합니다. Extension Pack과는 다른 구성요소입니다.
2. Windows **설정 → 시스템 → 디스플레이 → 디스플레이 해상도**를 **1920×1080**으로 선택하고 변경 사항을 유지합니다.
3. 같은 화면의 **배율**을 **100%**, **디스플레이 방향**을 **가로**로 맞춥니다. 브라우저는 `Ctrl+0`으로 확대/축소 100%로 맞춥니다.
4. 선택지에 1920×1080이 없으면 Guest Additions의 그래픽 드라이버 설치 및 재부팅을 먼저 확인합니다. 호스트 Scaled Mode를 바꿔도 게스트 드라이버가 설치되는 것은 아닙니다.

호스트 ISO를 못 찾으면 결과가 `iso_not_found`로 나오며 VM 생성 자체는 계속됩니다. VirtualBox와 버전이 맞는 Guest Additions ISO를 호스트에 준비하고 MCP `vm_insert_guest_additions`의 `iso_path`에 전달하세요. **ISO를 외부 사이트에서 자동 다운로드하거나 VM에서 설치 프로그램을 자동 실행하지 않습니다.**

```bash
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_insert_guest_additions --args '{"vm":"VAMP-Windows11"}'
# 호스트 ISO 경로를 직접 지정할 수도 있습니다.
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_insert_guest_additions --args '{"vm":"VAMP-Windows11","iso_path":"/host/path/VBoxGuestAdditions.iso"}'
```

VAMP 생성 VM은 SATA **포트 2 / 장치 0**을 Guest Additions용으로 예약합니다. OS/무인 설치 미디어와 레코더 미디어를 바꾸지 않습니다. 다른 디스크/ISO가 차지한 슬롯은 덮어쓰지 않고 오류를 반환합니다. 다른 저장장치 구성의 기존 VM은 관리자의 빈 DVD 드라이브에 직접 연결하세요. `media_inserted`는 설치 완료가 아니며 `guest_additions_installed_verified`는 false입니다.

## Debian GNOME 게스트 설정

1. GNOME **설정(Settings) → 디스플레이(Displays)**를 엽니다.
2. **해상도(Resolution)**를 **1920×1080**, **방향(Orientation)**을 **가로(Landscape)**로 선택합니다.
3. **배율(Scale)**은 **100%**, 분수 배율(Fractional Scaling)은 끄고 **적용(Apply) → 변경 사항 유지(Keep Changes)**를 누릅니다.
4. 여러 디스플레이가 연결되어 있으면 RPA용 주 화면 하나를 사용합니다. 브라우저는 `Ctrl+0`으로 100%에 맞춥니다.
5. 1920×1080을 선택할 수 없으면 VirtualBox 게스트 그래픽 드라이버/해상도 지원을 확인합니다. Guest Additions 또는 배포판의 대응 드라이버가 필요할 수 있습니다. 레코더는 X11 세션에서 실행하세요. 새 VM의 레코더 설치기는 GNOME/Xorg를 구성하지만 실제 해상도가 맞는지는 따로 확인해야 합니다.

이 GNOME/Windows OS 설정 절차는 기존 SPICE/KVM VM에도 적용할 수 있습니다. 아래 `VBoxManage` 설정과 Scaled Mode는 **VirtualBox 전용**이며 Hyper-V VMConnect나 SPICE 뷰어에 그대로 적용되지 않습니다. 기존 두 KVM VM의 설정을 이 변경에서 직접 수정하거나 재부팅하지 않았습니다.

## VirtualBox 관전 창만 축소

- VM 창 **View → Scaled Mode**를 선택합니다. 메뉴가 안 보이면 호스트 키 팝업 메뉴를 사용하세요. 기본 호스트 키는 Windows/Linux에서 보통 오른쪽 Ctrl, macOS에서는 왼쪽 Command이며 사용자 설정이 우선입니다.
- **View → Auto-resize Guest Display**를 끕니다. 실제 메뉴의 번역/배치는 VirtualBox 버전에 따라 다를 수 있습니다.
- 창 테두리를 줄여 화면 전체를 한눈에 봅니다. 호스트에서 예를 들어 960×540 정도로 보이더라도 VM 자체 화면과 RPA 캡처는 1920×1080을 유지해야 합니다.
- `separate`로 실행한 창은 **Detach / 백그라운드 계속 실행**으로 닫습니다. 종료/상태 저장을 선택하면 RPA도 중단될 수 있습니다.

VAMP는 새 VM과 `vm_start` 대상에 `GUI/Scale=true`, `GUI/AutoresizeGuest=false`, `GUI/LastGuestSizeHint=1920,1080` 등을 설정합니다. Fullscreen/Seamless 상태는 해제해 Scaled Mode를 기본으로 합니다. 이미 열려 있는 창은 설정 반영을 위해 수동 메뉴 변경 또는 **UI detach 후 다시 Show**가 필요할 수 있습니다. 호스트 배율을 guest 해상도로 착각하지 않도록 하세요.

## 설정 요청과 실제 화면 검증

```bash
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_configure_display --args '{"vm":"VAMP-Windows11"}'
.venv-virtualbox/bin/python backends/virtualbox/client.py vm_configure_display --args '{"vm":"VAMP-Debian"}'
```

이 도구는 게스트 창 크기 자동 변경을 끄고 Scaled Mode를 저장합니다. 실행 중이면 `setvideomodehint 1920 1080 32`를 요청한 뒤 PNG 스크린샷의 실제 픽셀 크기를 확인합니다. 요청은 드라이버 준비/게스트 설정에 따라 즉시 적용되지 않을 수 있습니다. 결과가 `resolution_verified: false`이면 게스트 OS 설정과 드라이버를 확인하고 다시 호출합니다. 즉시 검증이 false라고 VM을 다시 생성하지 않습니다. 해당 검증은 모니터0의 캡처 해상도만 확인하며, OS 배율/글꼴/브라우저 배율까지 자동 확인한 것은 아닙니다.

참고: [Oracle 해상도 힌트/Guest Additions](https://docs.oracle.com/en/virtualization/virtualbox/7.0/user/vboxmanage.html), [Guest Additions 설치](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/guestadditions.html), [VirtualBox GUI 설정 키 원본](https://github.com/VirtualBox/virtualbox/blob/main/src/VBox/Frontends/VirtualBox/src/extradata/UIExtraDataManager.cpp). 실제 VirtualBox/게스트 하드웨어 검증은 사용자 테스트 전입니다.

GNOME Xorg에서는 Mutter가 보고한 설정과 X11 framebuffer가 다를 수 있어 `xrandr`의 실제 연결 출력/루트 크기도 확인·적용합니다. 이는 Debian/Ubuntu의 x11-xserver-utils 패키지를 사용합니다. 게스트 내부 결과와 호스트 PNG 크기는 함께 검증해야 합니다. 관전 영역보다 큰 Full HD 모드를 허용하기 위해 VAMP는 호스트 VirtualBox 사용자 설정 `GUI/MaxGuestResolution=any`도 저장합니다. 다른 VM의 해상도를 강제로 변경하는 설정은 아닙니다.
