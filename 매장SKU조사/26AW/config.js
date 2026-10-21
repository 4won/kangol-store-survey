// 설문 설정 — 배포 전에 endpoint 만 채우면 됩니다 (apps-script/README 참고)
window.SURVEY_CONFIG = {
  season: '26AW',
  title: '매장 디스플레이 SKU 조사',
  lead: '현재 매장에 진열(DP)된 AW 상품 기준으로 작성해 주세요. 입력 내용은 이 기기에 자동 저장되고, 마지막 단계에서 제출됩니다.',
  deadline: '',            // 예: '10/28(화)까지' — 비우면 표시 안 함
  endpoint: 'https://script.google.com/macros/s/AKfycbx9i6otP-jmR_6dSH3I8wan9UiPgLHnTskZu7WvOgVGBZp3sypMHk9ecJmO7tWRcJdIiQ/exec',   // Google Apps Script 웹앱 URL (비어 있으면 테스트 모드: 제출 시 JSON 파일로 저장)
};
