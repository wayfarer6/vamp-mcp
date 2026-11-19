# VAMP & VAMP Vault 데모 시연 가이드 (Demo Scenarios)

이 문서는 다른 AI 에이전트(Claude Desktop, Roo Code, Cline, Cursor 등)나 시연자가 **VAMP**(로컬 VM 기반 RPA 플랫폼)와 **VAMP Vault**(격리 볼트 MCP)를 직접 단계별로 시연하고, 잠재적인 문제를 점검·수정할 수 있도록 작성된 실전 데모 시나리오입니다.

---

## 데모 아키텍처 및 핵심 메시지

1. **기존 CUA(Computer Use Agent)의 한계**: 매 프레임 스크린샷 캡처로 인한 엄청난 토큰 비용과 느린 속도, 클라우드 LLM에 평문 자격증명이 노출되는 보안 위험.
2. **VAMP의 해결책**:
   - **결정론적 로컬 RPA**: 1회 시연을 녹화한 Robot/Python 패키지로 반복 작업은 토큰 소모 없이 1초 만에 실행.
   - **제로 트러스트 볼트 (VAMP Vault)**: 비밀번호·인증서를 에이전트 프로세스와 분리하고, 사용자 VS Code 모달 승인을 거쳐서만 주입.
   - **데모 환경**: 검색과 개발자 도구를 테스트 계정으로 시연.

---

## 사전 준비 (Pre-flight Checklist)

데모 시작 전 호스트 환경에서 다음이 준비되어 있어야 합니다:

- [ ] **VS Code 확장**: `wayfarer6.vamp-mcp-tools` (v0.1.3+) 및 `wayfarer6.vamp-vault` (v0.1.1+) 설치 완료
- [ ] **MCP 서버 활성화**:
  - `VAMP VirtualBox` (또는 KVM SPICE)
  - `VAMP Vault`
- [ ] **가상머신**: 테스트용 Windows 11 또는 Debian VM 준비 (게스트에 `setup-all.ps1` 또는 `setup-all.sh` 실행 완료)
- [ ] **볼트 상태**: VS Code 사이드바 `VAMP Vault`에서 `vault.kdbx` 생성 및 잠금 해제 확인

---

## 시나리오 1: 토큰 절감형 초고속 웹 탐색 (구글 검색 데모)

> **목표**: 매 스텝 스크린샷을 찍지 않고, 사전 정의된 RPA 패키지로 구글 검색을 1~2초 만에 수행하여 토큰 비용과 속도 절감을 증명합니다.

### 1.1 에이전트 프롬프트 (Agent Prompt)
```text
로컬 가상머신을 확인하고, 브라우저를 열어 구글에서 "VAMP AI agent platform"을 검색한 뒤 상위 검색 결과 요약을 가져와 줘.
```

### 1.2 시연 흐름 (Execution Flow)
1. **VM 기동/상태 확인**: 에이전트가 MCP `vm_list` 또는 `vm_start`를 호출하여 게스트 상태 확인.
2. **RPA 패키지 트리거**: 브라우저 기동 및 구글 검색 자동화 패키지(`rpas/google_search` 또는 브라우저 실행 스크립트) 호출.
3. **로컬 실행**: 게스트 OS 내부에서 브라우저가 실행되고 검색어가 오프라인 좌표/단축키로 즉시 입력됨.
4. **결과 수집**: 화면 스크린샷 대신 결과 영역의 텍스트 요약만 에이전트에 반환.

### 1.3 관전 포인트 및 비교 지표
- **토큰 소모량**: 기존 멀티모달 CUA (약 5,000~10,000 토큰) vs VAMP (약 200~400 토큰, 결과 JSON만 파싱).
- **소요 시간**: 기존 CUA (30~45초) vs VAMP (2~3초).

---

## 시나리오 2: 제로 트러스트 자격증명 주입 (VAMP Vault 승인 데모)

> **목표**: 에이전트가 로그인에 필요한 계정 정보를 요청할 때, 평문 비밀번호가 LLM 프롬프트에 영구 노출되지 않고 사용자 승인(Modal)을 거쳐 주입되는 과정을 보여줍니다.

### 2.1 에이전트 프롬프트 (Agent Prompt)
```text
테스트 서비스 로그인을 위해 VAMP Vault에 저장된 'demo-account' 계정의 자격증명을 조회해서 로그인 작업을 준비해 줘.
```

### 2.2 시연 흐름 (Execution Flow)
1. **에이전트의 볼트 요청**: 에이전트가 MCP `vault_get_credential(title: "demo-account")` 호출.
2. **VS Code 모달 승인 창 팝업**:
   - 화면에 경고 모달 표시: `"Release a secret to the AI agent? The AI agent asked for 'demo-account'"`
   - 선택지: `Approve once`, `Approve for this session`, `Cancel`
3. **승인 및 주입**:
   - 사용자가 `Approve once`를 누르면 로컬 브리지를 통해 값이 전달됨.
   - 취소(`Cancel`)를 누르면 에이전트에게 `approval_denied`가 반환되며 값 유출 차단.
4. **결과 확인**: VS Code 사이드바 `VAMP Vault` 트리 뷰에서 해당 크레덴셜이 안전하게 관리되고 있음을 확인.

### 2.3 관전 포인트
- 마스터 비밀번호는 호스트 프로세스 환경변수나 에이전트 컨텍스트에 절대 들어가지 않음(VS Code Secret Storage 보관).
- 모달 승인 없이 에이전트가 독단적으로 비밀번호를 빼낼 수 없음.

---

## 시나리오 3: 개발자 보안 인증 및 이동식 USB 볼트 (GPG / 보안 키스토어 시나리오)

> **목표**: GPG 서명 및 보조 VHD 이동식 USB(`vault.vhd`) 마운트 파이프라인을 시연합니다.

### 3.1 에이전트 프롬프트 (Agent Prompt)
```text
VAMP Vault에 보조 디스크로 연결된 vault.vhd 볼륨을 확인하고, 게스트 내부에서 이동식 미디어(/m rm)로 마운트하여 서명용 키스토어를 준비해 줘.
```

### 3.2 시연 흐름 (Execution Flow)
1. **VHD 보조 디스크 연결 확인**: KVM(`format=vpc`), VirtualBox, Hyper-V에 `vault.vhd`가 보조 디스크로 연결되어 있는지 확인.
2. **게스트 마운트 실행**: 게스트 바탕화면의 `VAMP-Vault\Mount-Vault-USB.cmd` 또는 자동화 스크립트 기동.
3. **Removable Media 검증**:
   - `veracrypt /m rm` 플래그로 마운트되어 윈도우 탐색기에서 **'이동식 디스크(USB 드라이브)'**로 인식됨.
   - 인증서/GPG 키가 로컬 C: 드라이브에 복사되지 않고 격리된 가상 볼륨 안에서만 작동.

---

## 데모 리허설 중 발생할 수 있는 문제와 해결책 (Troubleshooting)

다른 에이전트로 데모를 테스트할 때 발견될 수 있는 문제와 수정 가이드입니다:

| 증상 / 오류 | 원인 | 해결 방법 |
| --- | --- | --- |
| **`approval_required` 오류 반환** | VS Code 브리지가 연결되지 않았거나 사용자가 승인 팝업을 닫음 | VS Code에서 VAMP Vault 확장이 활성화되어 있는지 확인하고, 모달 팝업에서 `Approve`를 클릭합니다. |
| **KeePassXC CLI not available** | 호스트에 keepassxc-cli가 설치되지 않음 | 명령 팔레트(`Ctrl+Shift+P`)에서 `VAMP Vault: Set Up KeePassXC & VeraCrypt CLI`를 실행하여 자동 다운로드합니다. |
| **게스트 화면 좌표 빗나감** | 게스트 디스플레이 배율(DPI Scaling)이 125%나 150%로 설정됨 | 게스트 디스플레이 설정을 **1920×1080 (100% 배율)**로 고정합니다 (`guest_setup/recorder/apply-display.py` 실행). |
| **보조 디스크 문자 인식 실패** | Windows 게스트에서 새 VHD를 오프라인 상태로 인식함 | 디스크 관리(`diskmgmt.msc`)에서 보조 디스크가 온라인 상태이고 드라이브 문자(`D:`)가 할당되었는지 확인합니다. |
| **브라우저 로딩 타임아웃** | 네트워크 지연으로 구글 검색창이 제시간에 뜨지 않음 | Robot 스크립트에 고정 Sleep 대신 YOLO/OCR 대기 루프(`Wait Until Element Is Visible`)를 적용합니다. |
