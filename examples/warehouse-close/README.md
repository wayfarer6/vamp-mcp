# 월말 창고 결산 · Month-end warehouse close

“월말 창고 결산 해줘”라고 요청하면 AI가 검토된 GUI RPA를 찾아 LibreOffice Calc에서 Excel 파일을 만듭니다. 연습용 품목 네 개를 키보드로 입력하고 실사 재고와 장부 재고를 대조합니다. 결산 월은 바꿀 수 있습니다. 예제 수량과 단가는 고정된 가상 데이터입니다.

### 한국어 실습

1. 테스트용 Ubuntu VirtualBox 게스트에 Calc를 설치합니다. `sudo apt-get update && sudo apt-get install libreoffice-calc`를 실행하고 `libreoffice --version`으로 확인하세요. 데모는 LibreOffice 24.2.7, 영어 UI, US 키보드, 1920×1080에서 실행했습니다.
2. 게스트의 `warehouse` 계정에서 `mkdir -p ~/warehouse-demo`를 실행하고 [Warehouse Intake.xlsx](<Warehouse Intake.xlsx>)를 그 폴더에 복사해 Calc로 엽니다. 시작 셀에 **Ready to close**가 보여야 합니다. 데모는 Excel 형식을 유지하도록 설정했습니다. 파일 형식 확인창이 나타나면 **Use Excel Format**을 선택하세요.
3. 호스트의 VAMP 소스 체크아웃 또는 설치된 프로비저닝 자산 루트에서 [recording.py](recording.py)를 검토하세요. 아래 등록 명령의 경로는 사용 중인 MCP의 `VAMP_RPA_REGISTRY`와 같아야 합니다. VS Code와 공유하려면 해당 프로필의 `globalStorage/wayfarer6.vamp-mcp-tools/rpa-catalog`를 사용하세요.
4. AI에 **“월말 창고 결산 해줘”**라고 요청합니다. 사용할 월과 VM이 대화에 없다면 알려주세요. 예를 들어 “2026년 11월, 테스트용 VirtualBox VM에서 실행해”라고 답합니다. YYYY-MM 형태의 월을 쓰고, 출력 파일이 이미 있으면 덮어쓰기 전에 중단하세요.
5. Calc에서 새 파일을 다시 열고 결과를 확인합니다. 아래 검증기는 입력값과 행별 수식, 합계 수식 및 저장된 계산 결과를 독립적으로 확인합니다. MCP가 반환하는 `completed_unverified`는 키 입력이 끝났다는 뜻입니다. 파일 검증 결과는 별도로 확인하세요.

### English walkthrough

Ask **“Close the warehouse for the month.”** The agent searches for a reviewed GUI recording, selects the authorized VirtualBox guest and enters the four synthetic SKUs in LibreOffice Calc. This is a fixed sample inventory with a variable reporting month.

Install Calc in a disposable Ubuntu guest, use the English UI and US keyboard at 1920×1080, and open **Warehouse Intake.xlsx** under **/home/warehouse/warehouse-demo** as the `warehouse` user. Start from the **Ready to close** sheet with no open dialog. The automation saves a new XLSX beside the input. Use a fresh YYYY-MM period. If the file exists, cancel the overwrite prompt. If Calc asks about the file format, choose **Use Excel Format**.

Review the recording on the host and register it in the same catalog used by your MCP client. Omitting `--reviewed` validates the recording without registering it. The demo files are included in the Git checkout, the VSIX runtime and the matching provisioning assets.

```sh
python examples/warehouse-close/register.py --registry "/path/to/rpa-catalog" --reviewed
```

The agent calls `rpa_search` with the user's words, reads `rpa_details`, then calls `rpa_run_saved` with the returned ID, the authorized guest UUID, `inputs.period` and explicit confirmation. Each installation receives its own RPA ID. The starting-screen OCR check expects **Ready to close**. The replay replaces that marker with the reporting period.

After the run, reopen the resulting XLSX in Calc. Run the independent check on a copy of that file:

```sh
python examples/warehouse-close/verify.py warehouse-close-2026-11.xlsx --period 2026-11
```

| Measure | Expected |
| --- | ---: |
| Book stock | 465 units |
| Counted stock | 464 units |
| Variance (counted − book) | −1 unit |
| Closing value at unit cost | KRW 1,310,400 |
| Count adjustment value | KRW −9,100 |

Quantities net across items, while adjustment values reflect each item's own unit cost. The verifier checks all four SKU rows and 24 formulas. A mismatch exits with an error naming the affected cell.
