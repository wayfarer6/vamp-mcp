# Robot 실행 영상·스크린샷·SQLite 이력

GUI 동작 레코더는 사람이 수행한 클릭/키보드를 Python으로 저장하는 도구입니다. 이 문서의 실행 녹화는 **Robot 실행을 관전하고 결과를 확인하는 영상**으로, 서로 다른 용도입니다. Robot Listener가 VirtualBox의 녹화/캡처 API를 호출합니다. 별도의 호스트 화면 녹화 프로그램, FFmpeg 설치나 게스트 녹화 프로그램은 필요하지 않습니다.

## Robot Framework에 선택적으로 연결

```bash
# 영상 OFF, 실행 이력과 스크린샷
.venv/bin/python -m robot \
  --listener backends.virtualbox.recording_listener.RecordingListener:Win-RPA:false \
  --variable VM_NAME:Win-RPA \
  --outputdir artifacts/robot-observed \
  backends/virtualbox/rpas/observe/run.robot

# 영상 ON: 저화질 관전 기록
.venv/bin/python -m robot \
  --listener backends.virtualbox.recording_listener.RecordingListener:Win-RPA:true \
  --variable VM_NAME:Win-RPA \
  --outputdir artifacts/robot-recorded \
  backends/virtualbox/rpas/observe/run.robot
```

사용할 VM은 이미 실행 중이어야 합니다. Listener는 새 VM을 만들거나 자동 기동하지 않습니다. 다른 Robot 작업에도 같은 Listener를 붙일 수 있습니다. 시작·종료 및 작업 결과에 스크린샷과 task 상태를 연결하고 영상은 명시적으로 true일 때만 켭니다. 실패한 기록 초기화는 경고/이력에 남으며 Robot task 자체의 성공과 구분해야 합니다.

영상 기본값: **640×360, 5fps, 최대 180초/20MB, 오디오 끔**. 제한에 먼저 도달하면 이후 실행 화면은 영상에 포함되지 않을 수 있습니다. 게스트 자체 화면은 1920×1080을 유지하고 녹화 출력만 작게 만듭니다. 스크린샷은 원본 게스트 해상도의 PNG입니다. 직접 MCP 요청의 begin/end를 사용할 때는 end를 호출하고, 실행이 취소된 경우 이력과 실제 녹화 상태를 확인하세요. 영상/스크린샷에는 화면 내용이 포함됩니다.

## 저장 위치와 SQLite

기본 데이터 루트는 호스트의 `~/VAMP`, 설정은 `VAMP_DATA_DIR` 환경 변수입니다.

```text
~/VAMP/
├── history.sqlite3
├── recordings/                 # 수동 GUI 녹화의 Python 파일
└── runs/<run_id>/
    ├── start-*.png
    ├── task-*.png
    ├── end-*.png
    └── screen-screen0.webm
```

SQLite의 `runs`는 VM/시각/실행 상태/Robot 결과, `events`는 작업 결과 및 관찰 오류, `artifacts`는 스크린샷·영상 파일의 경로와 크기를 보관합니다. 큰 이미지를 DB BLOB으로 넣지 않습니다. `finished`는 관찰 세션 종료이고 `robot_status`가 실제 Robot PASS/FAIL입니다. 상세 업무 성공 판정은 각 RPA의 검증 결과를 별도로 확인하세요. VM 복원이나 스냅샷과는 별개인 **호스트 기록**입니다.

MCP 직접 입력 호출을 자동으로 전부 기록하는 감사 시스템은 아닙니다. Robot Listener를 붙인 실행 또는 명시적으로 begin한 관찰 세션을 기록합니다. 저장 공간은 사용한 만큼 늘어나며 자동 보관 기간/삭제 정책은 현재 없습니다. 불필요한 테스트 영상·스크린샷은 사용자 판단으로 정리하세요.

## MCP에서 조회·보기

- `vm_run_observation`: begin/end/capture. `video` 기본 false.
- `vm_run_history`: 최근 실행 목록 또는 run_id 상세. 기본 20개, 최대 100개.
- `vm_run_artifact`: DB artifact_id로 파일 정보를 조회. `show_image:true`이면 해당 스크린샷만 이미지로 반환합니다. 매 호출 자동으로 이미지를 AI에 전송하지 않습니다. 영상은 로컬 경로를 반환하므로 호스트 플레이어나 VS Code에서 엽니다.

```json
{"action":"begin","vm":"Win-RPA","video":true}
{"action":"capture","run_id":"<위에서 받은 ID>"}
{"action":"end","run_id":"<같은 ID>","robot_status":"PASS"}
{"run_id":"<같은 ID>"}
{"artifact_id":1,"show_image":true}
```

## 실제 검증

Ubuntu 호스트의 기존 Win-RPA에서 Robot observe 작업 PASS, SQLite 기록, 스크린샷 저장 및 **640×360/5fps WebM 디코딩**을 확인했습니다. 설치된 VirtualBox 7.2.6에서는 `recording on`과 `recording start`를 구분해야 해서 이를 반영했습니다. 이 검증에서 새 VM과 스냅샷은 만들거나 복원하지 않았습니다. 다른 호스트 OS의 영상 인코더 동작은 별도 테스트 전입니다.

참고: [Robot Framework Listener](https://robotframework.org/robotframework/latest/RobotFrameworkUserGuide.html#listener-interface).
