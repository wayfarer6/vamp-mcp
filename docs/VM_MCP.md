# VM RPA MCP 서버

브랜치: `feat/vm-mcp-server`. stdio MCP 서버가 VM 조회·관찰·입력·Robot RPA 실행과 상주 모델 관리를 연결합니다. 기존 스킬/CLI/Robot 패키지도 계속 사용할 수 있습니다.

## 설치 및 연결

Ubuntu/SPICE 호스트는 먼저 [설치 안내](INSTALL.md)를 따른 뒤 MCP 의존성을 추가합니다.

```bash
.venv/bin/python -m pip install -r requirements-mcp.txt
.venv/bin/python vm_mcp_server.py
```

두 번째 명령은 stdio 프로토콜을 기다리는 서버입니다. 일반 대화형 터미널 출력 도구가 아닙니다. MCP 클라이언트가 해당 명령을 실행하도록 등록하세요. 예시는 [examples/mcp-client.json](../examples/mcp-client.json)이며, `mcpServers` 형식을 지원하는 클라이언트용입니다. 경로와 클라이언트별 설정 형식은 환경에 맞춰 바꿉니다.

```json
{
  "mcpServers": {
    "vm-rpa": {
      "command": "/home/ssh1032007/spice_kvm_based_rpa/.venv/bin/python",
      "args": ["/home/ssh1032007/spice_kvm_based_rpa/vm_mcp_server.py"]
    }
  }
}
```

SDK v1(`mcp==1.30.0`)을 사용합니다. [공식 v1 SDK 문서](https://py.sdk.modelcontextprotocol.io/v1/). 현재는 로컬 stdio만 제공하며 HTTP 포트나 원격 인증 서버는 구현하지 않았습니다. SDK/Robot 진단은 stderr 또는 자식 프로세스 로그로 분리해 MCP stdout을 오염시키지 않습니다.

## 도구

| 이름 | 동작 |
| --- | --- |
| `vm_list` | 설정된 libvirt VM의 상태·실제 SPICE 주소, Windows에서는 Hyper-V 인벤토리 |
| `vm_rpas` | 패키지 ID·버전·선택 가능한 진입점 |
| `vm_start` | 명시적으로 선택한 Off 상태의 libvirt VM 기동 |
| `vm_inspect` | `ocr`, `analyze`(YOLO+OCR), `screen-info` |
| `vm_capture` | 게스트 캡처를 로컬 저장하고 경로 반환; 자동 이미지 업로드 없음 |
| `vm_input` | `click`, `move`, `write`, `hotkey`를 게스트로 전송 |
| `vm_run_rpa` | OS에 맞는 Robot 진입점 하나 실행, 짧은 결과 반환 |
| `vm_read_evidence` | artifacts 아래 JSON만 최대 30개씩 조회·검색 |
| `vm_models` | 모델 백그라운드 프로세스 start/status/stop/restart |
| `hyperv_open_console` | Windows 호스트에서 UAC·선택적 VM 기동·VMConnect 실행 |

도구 호출 예:

```json
{"tool":"vm_inspect","arguments":{"vm_name":"windows-RPA","mode":"analyze","languages":"ko,en","query":"로그인","limit":5}}
```

```json
{"tool":"vm_run_rpa","arguments":{"vm_name":"debian13","rpa_id":"debian_update","entry":"run","timeout":600}}
```

```json
{"tool":"vm_run_rpa","arguments":{"vm_name":"windows-RPA","rpa_id":"windows_naver_recorded","variables":{"ALLOW_REPLAY":"True"}}}
```

위 JSON은 호출 개념 예시입니다. 실제 MCP 클라이언트에서 도구와 인자를 선택합니다. 기록 재생은 로컬 데이터 검토와 실제 재생 요청이 있을 때만 활성화하세요.

## VM/백엔드 라우팅

`config/vm-mcp.json`이 VM 이름·게스트 OS·백엔드·호환 RPA를 구분합니다. 현재 Debian `debian13`과 Windows 11 `windows-RPA` 모두 Linux/QEMU/SPICE 게스트입니다. 같은 해상도라도 Windows에서 Debian GNOME/apt 패키지를 실행하지 않도록 `supported_rpas`로 구분합니다. 새 패키지·VM은 이 호환 목록에도 등록합니다.

실제 SPICE URI는 매 호출 시 libvirt에서 확인하고 서버가 Robot에 전달합니다. 도구 인자에서 `SPICE_URI`나 RPA ID를 Robot 변수로 덮어쓸 수 없습니다. 프로필은 `VM_MCP_CONFIG` 환경 변수로 다른 JSON을 선택할 수 있습니다. 호스트의 libvirt 접근 권한과 virsh가 필요합니다.

Hyper-V는 [별도 폴더](../backends/hyperv/README.md)와 `$hyperv-rpa` 스킬을 사용합니다. Windows 호스트에서는 `.venv-hyperv`에 `requirements-mcp.txt`와 `backends/hyperv/requirements.txt`를 설치하고 같은 서버 명령을 등록할 수 있습니다. 인벤토리·VMConnect 기동·파일 교환을 지원하며 RDP 화면·입력은 미구현입니다. `hyperv_open_console`의 `launch_requested`는 게스트 접속·로그인 성공이 아닙니다. 2026-11-16 중첩 Windows 11 Pro 랩에서 실제 Windows 게스트 부팅·파일 왕복 전송·MCP 조회를 검증했습니다. 물리 Windows 호스트 검증과는 구분합니다.

## 출력·토큰·긴 작업

기본 응답은 status·검증 여부·run_id·상세/보고서 경로 정도입니다. Robot 전체 로그나 화면 이미지를 매 호출 AI에 전달하지 않습니다. `vm_inspect`는 기본 10개 관찰만 반환하고 query/offset/limit으로 범위를 좁힙니다. 이미 만든 OCR 결과는 `vm_read_evidence`로 읽어 불필요한 재추론을 줄일 수 있습니다.

실행 기록은 `artifacts/mcp/<run_id>/`에 저장합니다. `status`가 실제 앱/RPA 상태이며 `robot_exit_code`나 프로세스 실행 성공만으로 앱 성공을 주장하지 않습니다. CAPTCHA·추가 인증 상태는 사용자 인계로 유지합니다. `vm_input`의 `executed`도 입력 전달만 의미합니다.

이 버전의 RPA 호출은 동기 완료를 기다리므로 MCP 클라이언트의 도구 제한 시간을 작업에 맞춰 늘려야 합니다. 서버 도구의 timeout 기본값은 600초, 최대 1800초입니다. timeout으로 호스트 컨트롤러가 종료되어도 게스트 apt나 이미 실행된 동작은 남을 수 있으므로 재호출 전에 현재 상태를 확인하세요. 비동기 job/poll API는 아직 제공하지 않습니다.

## 자격 증명과 기록

개인 비밀번호를 `vm_input.text`나 Robot 변수로 보내지 마세요. 전용 로그인 진입점에서 서버 실행 환경의 자격 증명 또는 사용자의 로컬 비공개 입력창을 사용합니다. MCP 클라이언트가 별도로 도구 인자를 기록할 수 있습니다. 원시 기록 데이터는 Git 제외 상태를 유지합니다. `vm_read_evidence`는 artifacts JSON에만 접근하며 config·소스·private recording 파일을 읽지 않습니다.

## 모델 프로세스

[독립 백그라운드 모델 프로세스](MODEL_BACKGROUND.md)를 사용합니다. systemd는 없습니다. 첫 실제 SPICE 연결이 자동으로 시작하며 MCP 요청이 끝나도 남아 있습니다. 미리 준비하려면 `vm_models`의 start, 해제하려면 stop을 명시적으로 호출합니다. YOLO 모델과 OCR 파이프라인이 메모리에 유지되지만 전체 화면 OCR 추론 비용까지 사라지지는 않습니다.

## 검증한 범위

- 실제 Ubuntu + NVIDIA에서 stdio 초기화·도구 등록·VM 목록·RPA 목록·모델 상태 조회.
- 모델 캐시/PID 재사용과 기존 Robot 기반 Windows 게스트 입력·로그인 화면 도달 검증.
- 단위 테스트와 Robot dry-run.
- VM이 정지된 뒤 vm_inspect 호출이 입력 없이 차단되는 상태 확인. 실제 MCP 도구 경유 화면 관찰은 실행 중인 VM에서 추가 확인할 대상입니다.
- 중첩 Windows 11 Pro의 Hyper-V·UAC·VMConnect·PowerShell Direct 전송은 [추가 검증 기록](VALIDATION.md)을 확인하세요. RDP 어댑터, 물리 Windows 호스트, AMD GPU·Apple·NPU 가속기 실행은 미검증입니다.

## VAMP 게스트 레코더와 VirtualBox 생성

서버 이름은 VAMP (Virtual Agent Machine Platform)입니다. `vm_recorder_media`는 Windows/Debian용 레코더 ISO를 만들며, SPICE VM에서는 사용자가/libvirt 관리자가 연결한 뒤 게스트 사용자 세션에서 설치기를 실행합니다. 자동 녹화는 하지 않습니다.

`virtualbox_create`는 VirtualBox 호스트의 ISO 경로를 받아 VM 생성·무인 설치 시작·레코더 후속 구성을 스크립트로 처리합니다. 기본 계정 **vboxuser / password123!**는 공개 정보라고 고지합니다. 이 도구는 libvirt VM을 생성하지 않습니다. `installation_started`는 설치 완료 검증이 아니며 실제 VM 시험이 필요합니다. [게스트 레코더](GUEST_RECORDER.md), [VirtualBox](../backends/virtualbox/README.md), [VS Code Marketplace 패키지](VSCODE_MARKETPLACE.md)를 참고하세요.


## Packer build network: post-install scripts

This applies to `vm_create`, the local `kvm_vm_create` and configured SSH KVM tool, and **Open VM Manager → New Virtual Machine → Packer network options**. It does not configure the deployed VM's adapter. Leave the optional IPv4 blank to use the hypervisor default. A request's `bootstrap_host` takes precedence over the builder's `VAMP_PACKER_BOOTSTRAP_HOST` environment variable. Set the environment variable on the machine actually running Packer, not the client. Use a plain IPv4, never a URL or hostname.

| Builder | Default | Override |
| --- | --- | --- |
| VirtualBox | Existing NAT path | Unchanged; the bootstrap override is not used. |
| Hyper-V | The single usable host IPv4 on the selected switch (default: `Default Switch`). | Choose an IPv4 already assigned to the selected switch. An isolated Private switch without a host adapter cannot serve these scripts. |
| KVM/QEMU | `10.0.2.2` through QEMU user NAT; the host listener is bound to loopback. | Use a private IPv4 assigned to the builder and already reachable from the build guest. The deployed libvirt network's gateway does not determine this address. |

Hyper-V and KVM run job-owned script and completion listeners. Use a trusted build network; the post-install transport uses HTTP, not TLS. Port `8421` must be free on the selected address. Debian's Packer preseed also uses a temporary HTTP port; the guest reports completion to a separate temporary callback port. VAMP does not change firewall rules or routes. If the preflight or job fails, check **Golden images** and its Packer/worker logs for the chosen address, then check the switch, firewall and guest route. A failed or empty bootstrap download is not executed, and no authenticated completion means no deployment.

For the default network behavior see [QEMU user networking](https://www.qemu.org/docs/master/system/devices/net.html) and [HashiCorp's Hyper-V builder HTTP options](https://developer.hashicorp.com/packer/integrations/hashicorp/hyperv/latest/components/builder/iso).
