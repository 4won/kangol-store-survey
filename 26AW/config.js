// 설문 설정 — 배포 전에 ENDPOINT 만 채우면 됩니다 (apps-script/README.md 참고)
window.SURVEY_CONFIG = {
  season: '26AW',
  title: '26AW 상품 매장 반응도 조사',
  lead: '매장에서 느끼신 고객 반응을 솔직하게 적어 주세요. 입력 내용은 이 기기에 자동 저장되고, 마지막 단계에서 제출됩니다.',
  deadline: '',            // 예: '10/20(월)까지' — 비우면 표시 안 함
  endpoint: '',            // Google Apps Script 웹앱 URL (비어 있으면 테스트 모드: 제출 시 JSON 파일로 저장)
};
