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
