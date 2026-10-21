# kangol-store-survey

매장 대상 조사를 모아 두는 저장소입니다. 조사마다 폴더를 하나씩 둡니다.

| 폴더 | 내용 |
|---|---|
| `상품반응도_26AW/` | 26AW 상품별 매장 반응도 조사 (설문 페이지·응답 수집·취합 리포트). 자세한 사용법은 폴더 안 `README.md` |
| `매장SKU조사/` | 매장 디스플레이 SKU 조사 (AW 현재 DP 현황·운영 의견·제거/추가 품번). 사용법은 폴더 안 `README.md` |

## 구조 메모
- 설문 페이지는 GitHub Pages 로 배포되며, 각 조사 폴더 안의 시즌 폴더(`26AW/` 등)만 공개됩니다. 주소: 상품반응도 `https://4won.github.io/kangol-store-survey/26AW/`, 매장SKU조사 `https://4won.github.io/kangol-store-survey/sku-26AW/`.
- 배포 설정은 루트의 `.github/workflows/pages.yml`, 루트 `index.html` 은 기본 주소의 이동 페이지입니다.
- 스크립트는 각 조사 폴더 안에서 실행합니다. 예: `cd 상품반응도_26AW && node tools/build_report.mjs --hub-publish`
- 판매 수치가 들어가는 리포트(`reports/`)는 git 에 올리지 않습니다(.gitignore).
