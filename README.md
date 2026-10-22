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
- 판매 수치가 들어가는 리포트 원본(`reports/`)은 git 에 올리지 않습니다(.gitignore). 포털용은 암호화된 `report/report.enc.json` 만 올라갑니다.

## 허브 페이지 (루트 주소)
`https://4won.github.io/kangol-store-survey/` — 조사마다 탭이 하나씩 생기는 포털입니다. 리포트가 있는 조사는 탭에서 바로 보이고(비밀번호 필요), 리포트가 아직 없는 조사는 설문 링크와 "준비 중" 화면이 나옵니다.

- **새 조사 추가**: 폴더를 만들고 `survey.json`(slug · title · order · status · desc · site · sitePath · report) 만 넣으면 포털에 탭이 생깁니다. 배포 때 `scripts/build_site.mjs` 가 폴더를 훑어 목록(`surveys.json`)을 만듭니다.
- **리포트 보호**: 저장소가 공개라서 리포트는 비밀번호로 암호화(AES-GCM)한 파일(`상품반응도_26AW/report/report.enc.json`)만 올라가며, 비밀번호를 입력해야 브라우저에서 열립니다. 비밀번호는 `상품반응도_26AW/reports/portal-password.txt` 에만 있고 git 에 올라가지 않습니다.
- **리포트 갱신**: `cd 상품반응도_26AW && node tools/build_report.mjs --portal` → `git add report && commit && push`
