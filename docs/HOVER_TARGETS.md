# 호버 UI 처리 설계안 · Proposed hover handling

**검토 단계입니다.** 현재 릴리즈는 포인터를 옮긴 다음 대상 영역의 픽셀이 변하면 새 화면으로 한 번 더 확인합니다. 두 번째에도 일치하지 않으면 입력을 중단합니다. [현재 구현](../backends/library/click_guard.py)

### 스크립트를 작성할 때

| 녹화 중 관찰한 동작 | 제안하는 재생 방식 |
| --- | --- |
| 같은 버튼의 색·테두리만 바뀜 | 버튼 위에 포인터를 놓고 모양이 안정된 뒤, 동일한 레이블·클래스와 위치를 한 번 검증합니다. 최종 프레임까지 해당 영역이 그대로면 같은 판정을 재사용합니다. |
| 메뉴를 올리면 하위 항목이 나타남 | ‘메뉴에 포인터 올리기’와 ‘하위 항목 클릭’을 두 단계로 기록합니다. 열린 메뉴에서 대상 글자가 하나이고 예상 범위 안에 있는지 OCR로 확인합니다. 이 조건으로 식별할 수 있으면 하위 항목에서 YOLO 호출을 생략할 수 있습니다. |
| 툴팁이 버튼을 덮음, 같은 이름이 둘, 애니메이션이 계속됨 | 클릭을 보류합니다. 안정화 대기 한도를 넘기면 단계와 이유를 표시해 사용자가 녹화를 수정할 수 있게 합니다. |

검토자가 호버를 허용할 **단계**, 트리거, 열린 뒤 기대하는 대상, 검색 범위, 최대 대기 시간과 성공 조건을 녹화 리비전에 저장하는 안입니다. 예를 들어 ‘내보내기 메뉴 위에 포인터 올리기 → 그 메뉴 안의 CSV 항목 확인 → 클릭 → 요청한 주문이 포함된 새 파일 확인’으로 기록합니다. 메뉴가 열린 무렵 다른 창이 활성화되거나 대상 영역이 다시 그려지면 이전 판정은 폐기합니다. 임의의 변경 픽셀을 무시하는 마스크나 모든 호버 단계에서 검사 끄기는 잘못된 대상도 통과시킬 수 있습니다.

**채택 전 시험**은 색 변화만 있는 버튼, 정상 하위 메뉴, 중복 항목, 툴팁 가림, 마지막 프레임의 창 변경을 각각 재현합니다. 항목마다 실제 버튼 입력 수와 모델 호출 수를 세고 결과 파일을 별도로 확인합니다. 불확실한 경우에는 버튼 입력이 0회여야 합니다.

### English design review

The current release takes a second capture after positioning the pointer. A changed target gets one fresh attempt. The proposal lets a reviewer declare the affected step, hover trigger, expected child or stable target, search region, wait limit and outcome when authoring a workflow.

For a highlight-only button, verify its identity after the hover state settles and reuse that verdict while the final target region stays unchanged. For a fly-out menu, record hover and child selection as separate steps. A unique reviewed OCR label inside the expected open menu could replace an additional YOLO call. An occluding tooltip, duplicate label, window change or continuously moving target invalidates the verdict. A subsequent click still needs an independent application outcome.

Acceptance tests would count button presses and detector calls for a stable highlight, a valid menu, duplicate children, an overlay and a last-frame window change. The uncertain cases must deliver zero presses. This proposal is separate from the released implementation.
