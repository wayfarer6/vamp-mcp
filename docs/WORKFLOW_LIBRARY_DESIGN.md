# GUI RPA와 CLI 라이브러리를 나누는 설계안

**현재 0.3.15**에서는 하나의 RPA Library 안에서 GUI와 CLI를 필터링합니다. 아래는 다음 UI를 위한 제안입니다.

사용자가 사이드바에서 **GUI RPA** 또는 **CLI 워크플로**로 바로 들어가게 합니다. 어느 방식으로 만들었는지 모를 때는 **전체 워크플로 검색**을 사용합니다. 검색 결과에는 실행 방식을 표시하고, 항목을 열면 해당 라이브러리의 상세 화면으로 이동합니다.

| 사용자 작업 | GUI RPA | CLI 워크플로 |
| --- | --- | --- |
| 새로 만들기 | 화면 녹화 또는 GUI 스크립트 가져오기 | Python·Playwright 소스 또는 워크플로 JSON 가져오기 |
| 검토하기 | 게스트 해상도, 시작 화면, 클릭 대상, OCR·YOLO 기준 점수 | 입력 계약, 진입 파일, 의존성 잠금, 결과 검사, 승인한 VM |
| 실행하기 | 대상 데스크톱 확인 → 녹화 재생 → 화면·파일 결과 확인 | VM과 입력값 확인 → 미리 보기 → 승인한 리비전 실행 → 산출물 확인 |
| 실패 조사 | 중단된 단계, 마지막 대상 검사와 결과 | 실패한 검사, 시간 초과, 종료 상태와 산출물 |

한 워크플로의 식별자·리비전·검토 이력은 기존 카탈로그에 유지합니다. 화면을 나눈다는 이유로 데이터를 복사하거나 기존 승인을 다른 VM에 적용하지 않습니다. **감사 기록**은 하나로 유지하고, 각 상세 화면에서 현재 스크립트로 필터링해 바로 엽니다. GUI 인식 점수는 GUI 화면에, VM 바인딩과 의존성 잠금은 CLI 화면에 둡니다. Playwright로 브라우저를 조작해도 이 실행기는 CLI 계약에 속합니다.

기존 VS Code 명령은 전체 검색으로 연결하고, 기존 MCP 검색과 실행 도구는 같은 ID를 사용합니다. 전환 시험에서는 두 라이브러리에서 동명 스크립트를 열어 올바른 실행기가 선택되는지, 기존 링크와 승인이 유지되는지, 양쪽에서 같은 실행 번호를 감사 화면으로 추적하는지 확인합니다. [현재 CLI 사용법](CLI_WORKFLOWS.md) · [감사 기록](AUDIT_LOG.md)

## English design proposal

Version 0.3.15 provides GUI and CLI filters inside one RPA Library. The proposed sidebar gives **GUI RPA** and **CLI workflows** their own entry points. A shared search shows the execution type and opens the appropriate detail view.

The GUI view guides recording, starting-screen review, OCR or YOLO thresholds and replay. The CLI view guides source import, input preview, runtime and VM binding, revision approval and artifact verification. Playwright belongs here when a saved CLI package launches the browser.

Keep one catalog and one audit log. Existing IDs, revisions, workspace approvals and MCP clients continue to resolve the same workflows. Each detail view links to audit events for its script. Test the transition with identically named GUI and CLI workflows, saved links, existing approvals and run-ID lookup from both views.
