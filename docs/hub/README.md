# VAMP Script Hub (사본)

이 폴더는 [VAMP Script Hub](https://wayfarer6.github.io/vamp-script-hub/) 정적 사이트의 사본입니다. 저장소를 내려받은 상태에서도 카탈로그 구성과 스크립트 정의를 바로 확인할 수 있도록 `index.html`, `scripts.json`, `assets/`를 그대로 두었습니다.

- 실제 배포본: <https://wayfarer6.github.io/vamp-script-hub/>
- 원본 저장소: <https://github.com/wayfarer6/vamp-script-hub>
- 스크립트 정의: [`scripts.json`](scripts.json) — 카탈로그의 단일 원본
- 커뮤니티 RPA 스크립트 규격과 실행 방법: [`rpas/README.md`](../../rpas/README.md), [`docs/WORKFLOWS.md`](../WORKFLOWS.md)

이 사본은 GitHub에서 파일을 읽기 위한 것이며, 브라우저에서 앱처럼 열려면 HTTP로 제공해야 합니다(`scripts.json`을 가져오기 때문). 사이트를 수정할 때는 원본 저장소를 고친 뒤 이 폴더로 복사합니다.

## 사본 파일

```text
docs/hub/
├── index.html          카탈로그 페이지
├── scripts.json        스크립트 정의(영어·한국어)
└── assets/             CSS, JavaScript, 박쥐 마스코트
```

## RPA privacy before export or upload / RPA 공유 전 경고

**Before uploading an RPA or ZIP, inspect every source file, comment, metadata field, filename, URL and image for private IDs, passwords, tokens and certificates. Replace actual values with declared inputs. AI review is not a guarantee that secrets are absent.**

**RPA나 ZIP을 업로드하기 전에 사용자가 모든 소스·주석·메타데이터·파일명·URL·이미지를 직접 확인해야 합니다. 실제 ID·비밀번호·토큰·인증서는 제거하고 입력 매개변수를 사용하세요. AI 검토만으로 민감정보가 없다고 보장할 수 없습니다.**

In VAMP 0.1.9, Export ZIP requires local screening, AI review of a structural report and a final personal-review confirmation. Original source, recorded values, filenames and metadata values are withheld from AI. Detected secrets block export. Missing AI review, cancellation or changes after review prevent archive creation. Image content is not inspected by AI; users must inspect it themselves. Review every archive again before submitting it to GitHub or Script Hub. VAMP does not upload it automatically.

0.1.9 내보내기는 원본을 AI에 보내지 않고 구조 검사 결과만 검토받습니다. AI 경고를 읽고 전체 파일을 확인한 뒤 명시적으로 승인해야 ZIP이 생성됩니다. AI 모델이 없거나 검토를 취소하면 내보낼 수 없습니다. 이미지는 사용자가 직접 확인해야 하며, 업로드 직전에도 파일 전체를 다시 검토하세요.
