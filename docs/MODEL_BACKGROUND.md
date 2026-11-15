# 모델 상주 프로세스 — systemd 없이 실행

YOLO와 PaddleOCR를 각기 독립 Python 프로세스에 한 번 로드하고 재사용합니다. RPA가 끝나거나 MCP 클라이언트가 종료돼도 모델 프로세스는 유지됩니다. systemd unit이나 부팅 서비스는 설치하지 않습니다.

```bash
# 두 프로세스를 백그라운드로 띄우고 모델 준비까지 기다린 뒤 반환
.venv/bin/python scripts/model_service.py start
# 로딩 완료를 기다리지 않고 반환
.venv/bin/python scripts/model_service.py start --no-wait
# PID, 준비 상태, 모델 개수, 처리 건수 확인
.venv/bin/python scripts/model_service.py status
# 필요할 때 명시적으로 종료 / 코드·환경 변경 후 재시작
.venv/bin/python scripts/model_service.py stop
.venv/bin/python scripts/model_service.py restart
```

별도 `nohup`이나 `&`는 필요 없습니다. 관리 스크립트가 detached 프로세스를 생성하고 로그를 파일로 보냅니다. 첫 실제 SPICE 연결에서도 자동 시작하므로 평소에 매번 `start`를 호출할 필요는 없습니다. dry-run·변환·패키지 목록 조회는 모델을 시작하지 않습니다. 재부팅 후 자동 기동하는 OS 서비스는 없으며 다음 RPA 요청이 다시 시작합니다. 사용자 로그아웃 시 생존 여부는 호스트 정책에 따릅니다.

- YOLO: `.venv/bin/python`에서 선택한 장치의 탐지 모델을 유지합니다.
- OCR: `.venv-ocr/bin/python`에서 한국어·영어·일본어/중국어용 3개 파이프라인을 유지합니다. 일본어와 중국어가 같은 인식 모델을 사용하므로 같은 프레임의 중복 추론도 공유합니다.
- 동일 장치·동일 모델은 절대 경로로 정규화해 중복 로드하지 않습니다. 다른 장치나 모델을 요청하면 별도 캐시가 추가됩니다.
- 모델 초기화와 추론은 워커별 전용 한 스레드에서 순차 처리합니다. 상태 응답은 별도 스레드로 처리합니다.
- OS 파일 잠금으로 중복 워커 실행을 방지합니다. 단일 사용자·저장소별 private Unix socket만 사용하고 외부 TCP 포트는 열지 않습니다.
- 소켓·로그는 `status`가 반환하는 `/tmp/spice-rpa-models-<uid>-<repo-hash>/`에 있습니다. 디렉터리 0700, 소켓 0600입니다.
- 정지할 때 진행 중인 추론이 끝날 수 있도록 기다립니다. 오래 걸리는 추론 중에는 정지/재시작 대신 상태를 먼저 확인하세요.

`--device cpu` 같은 옵션으로 사전 로드 장치를 선택할 수 있습니다. 예: `scripts/model_service.py restart --device cpu`. 명시적으로 요청한 추론 장치는 기존 프로필 규칙을 따릅니다. 다른 GPU/NPU 환경은 검증하지 않았습니다. 이 Unix-socket 구현은 Windows Hyper-V 네이티브 모델 서비스로 포팅된 상태가 아닙니다.

## 성능의 실제 범위

1920×1080 로그인 화면, YOLO 내부 imgsz 1280, RTX 3050 Laptop에서 상주 워커를 두 번 호출했을 때 같은 PID·모델 개수가 유지됐고 YOLO 요청은 약 0.11~0.14초였습니다. 한국어+영어 전체 화면 OCR은 약 15초로, 모델 상주만으로 OCR 추론 자체가 사라지지는 않습니다. 페이지 대기는 작은 영역/빠른 YOLO 검사와 필요한 시점의 OCR을 조합하는 추가 최적화가 필요합니다. 해당 ROI 대기 루프는 아직 구현하지 않았습니다.

검증 상태: 실제 Ubuntu + NVIDIA에서 모델 준비·연속 요청·PID/캐시 재사용을 확인했습니다. AMD·Apple·NPU 및 Windows 포트는 별도 테스트하지 않았습니다.
