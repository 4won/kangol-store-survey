/**
 * 매장 반응도 조사 - 응답 수집기 (Google Apps Script, 구글시트에 연결된 스크립트)
 *
 * 흐름: 매장 설문 페이지(GitHub Pages) -> doPost -> 이 시트에 raw 행 누적
 *   시즌응답    매장당 1행        (시즌 전반 점수/의견)
 *   상품평가    매장x상품 1행     (복종/세부복종/품번/점수/의견)  <- 복종별 취합의 원천
 *   가격적정선  매장x복종 1행
 *   경쟁브랜드  매장x브랜드 1행
 *   원본JSON    제출 1건 = 1행 (원본 그대로, 백업용)
 * 같은 매장이 다시 제출하면 이전 행의 '최신' 칸이 N 으로 바뀌고 새 행이 Y 로 쌓입니다. (삭제 없음 = raw 보존)
 * 취합 탭(복종별취합/세부복종별/상품별취합/제출현황)은 setup() 이 수식으로 만들며 '최신=Y' 만 집계합니다.
 */
const HEADERS = {
  '시즌응답':   ['제출ID', '최신', '제출일시', '시즌', '채널형태', '채널계열', '매장명', '전체만족도', '상품구성', '물량·입고', '고객반응', '잘된점', '아쉬운점', '기타의견', '경쟁환경의견'],
  '상품평가':   ['제출ID', '최신', '제출일시', '채널형태', '채널계열', '매장명', '복종', '세부복종', '품번', '상품명', '판매가', '등급', '디자인', '가격', '한줄평'],
  '가격적정선': ['제출ID', '최신', '제출일시', '채널형태', '채널계열', '매장명', '복종', '세부복종', '적정하한', '적정상한', '현재가수준', '경쟁대비', '의견'],
  '경쟁브랜드': ['제출ID', '최신', '제출일시', '채널형태', '채널계열', '매장명', '복종', '브랜드', '가격대', '강점', '프로모션·동향', '고객반응'],
  '원본JSON':   ['제출ID', '제출일시', '매장명', 'JSON'],
};
const STORE_COL = { '시즌응답': 7, '상품평가': 6, '가격적정선': 6, '경쟁브랜드': 6 };  // 1-based 매장명 열
const CATS = ['가방', '의류', '모자'];
const PRICE_SUBS = [['가방', '토트백'], ['가방', '크로스백'], ['가방', '백팩'],
  ['의류', '긴소매티셔츠'], ['의류', '라운드티셔츠'], ['의류', '집업'], ['의류', '바지'], ['의류', '자켓'], ['의류', '후드티셔츠'], ['의류', '셔츠'], ['의류', '니트'],
  ['모자', '벙거지'], ['모자', '야구모자']];   // 설문 페이지의 PSUBS 와 같아야 함

function doGet() { return out_({ ok: true, msg: 'store survey endpoint' }); }

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    const d = JSON.parse(e.postData.contents);
    if (d.hp) return out_({ ok: true });                                  // 봇(허니팟) 조용히 무시
    const s = d.store || {};
    if (!d.sid || !s.name || String(s.name).length > 40) return out_({ ok: false, error: 'invalid' });
    if (typeof STORE_LIST !== 'undefined' && !STORE_LIST.some(r => r[2] === s.name)) return out_({ ok: false, error: 'unknown store' });
    const ss = SpreadsheetApp.getActive(), at = new Date(d.at || Date.now());
    ensureSheets_(ss);
    const c = v => (v == null ? '' : (typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v));   // 수식 주입 방지
    const base = [d.sid, 'Y', at], st3 = [s.type, s.group, s.name];

    Object.keys(STORE_COL).forEach(n => markOld_(ss.getSheetByName(n), STORE_COL[n], s.name));

    const q = d.seasonQ || {};
    append_(ss, '시즌응답', [base.concat([d.season], st3, [q.overall, q.assort, q.timing, q.cust, q.good, q.bad, q.free, d.extra]).map(c)]);
    append_(ss, '상품평가', (d.products || []).map(p => base.concat(st3, [p.cat, p.sub, p.no, p.name, p.price, p.grade, p.design, p.price_score, p.comment]).map(c)));
    append_(ss, '가격적정선', (d.prices || []).map(x => base.concat(st3, [x.cat, x.sub, x.min, x.max, x.vsCur, x.vsComp, x.note]).map(c)));
    append_(ss, '경쟁브랜드', (d.comps || []).map(x => base.concat(st3, [x.grp, x.brand, x.range, x.strength, x.promo, x.reaction]).map(c)));
    append_(ss, '원본JSON', [[d.sid, at, s.name, JSON.stringify(d).slice(0, 49000)]]);
    return out_({ ok: true });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  } finally { try { lock.releaseLock(); } catch (x) {} }
}

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function append_(ss, name, rows) { if (!rows.length) return; const sh = ss.getSheetByName(name); sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows); }
function markOld_(sh, storeCol, store) {
  const n = sh.getLastRow() - 1; if (n < 1) return;
  const names = sh.getRange(2, storeCol, n, 1).getValues(), flags = sh.getRange(2, 2, n, 1).getValues();
  let hit = false; names.forEach((r, i) => { if (r[0] === store && flags[i][0] === 'Y') { flags[i][0] = 'N'; hit = true; } });
  if (hit) sh.getRange(2, 2, n, 1).setValues(flags);
}
function ensureSheets_(ss) {
  Object.keys(HEADERS).forEach(n => {
    let sh = ss.getSheetByName(n);
    if (!sh) { sh = ss.insertSheet(n); sh.getRange(1, 1, 1, HEADERS[n].length).setValues([HEADERS[n]]).setFontWeight('bold').setBackground('#e8ebf5'); sh.setFrozenRows(1); }
  });
}

/** 최초 1회 실행: 원본 탭 + 취합 탭(수식) 생성. 다시 실행해도 원본 데이터는 지우지 않고 취합 탭만 새로 만듭니다. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  ensureSheets_(ss);
  const R = '$2:$20000', HB = '#e8ebf5';

  // 복종별취합: 복종별 점수 평균 + 가격 적정선 + 의견 모음
  let sh = fresh_(ss, '복종별취합');
  sh.getRange('A1').setValue('복종별 취합 (최신 제출 기준)').setFontSize(14).setFontWeight('bold');
  sh.getRange('A3:G3').setValues([['복종', '응답매장수', '평가건수', '디자인', '가격', '적정가 하한(중앙값)', '적정가 상한(중앙값)']]).setFontWeight('bold').setBackground(HB);
  CATS.forEach((k, i) => {
    const r = 4 + i, f = col => `=IFERROR(AVERAGEIFS(상품평가!${col}$2:${col}$20000,상품평가!$G$2:$G$20000,$A${r},상품평가!$B$2:$B$20000,"Y"),"")`;
    sh.getRange(r, 1, 1, 7).setFormulas([['="'+k+'"',
      `=IFERROR(COUNTA(UNIQUE(FILTER(상품평가!$F$2:$F$20000,상품평가!$G$2:$G$20000=$A${r},상품평가!$B$2:$B$20000="Y"))),0)`,
      `=COUNTIFS(상품평가!$G$2:$G$20000,$A${r},상품평가!$B$2:$B$20000,"Y")`, f('M'), f('N'),
      `=IFERROR(MEDIAN(FILTER(가격적정선!$I$2:$I$20000,가격적정선!$G$2:$G$20000=$A${r},가격적정선!$B$2:$B$20000="Y",ISNUMBER(가격적정선!$I$2:$I$20000))),"")`,
      `=IFERROR(MEDIAN(FILTER(가격적정선!$J$2:$J$20000,가격적정선!$G$2:$G$20000=$A${r},가격적정선!$B$2:$B$20000="Y",ISNUMBER(가격적정선!$J$2:$J$20000))),"")`]]);
  });
  sh.getRange('D4:E6').setNumberFormat('0.00'); sh.getRange('F4:G6').setNumberFormat('#,##0');
  sh.getRange('A9:C9').setValues([['복종', '경쟁브랜드 대비', '우리 가격 수준']]).setFontWeight('bold').setBackground(HB);
  CATS.forEach((k, i) => {
    const r = 10 + i, n = (col, v) => `COUNTIFS(가격적정선!$G$2:$G$20000,$A${r},가격적정선!$B$2:$B$20000,"Y",가격적정선!${col}$2:${col}$20000,"${v}")`;
    sh.getRange(r, 1, 1, 3).setFormulas([['="'+k+'"',
      `="저렴 "&${n('L', '저렴')}&" · 비슷 "&${n('L', '비슷')}&" · 비쌈 "&${n('L', '비쌈')}`,
      `="낮은 편 "&${n('K', '낮은 편')}&" · 적정 "&${n('K', '적정')}&" · 높은 편 "&${n('K', '높은 편')}`]]);
  });
  sh.getRange('A14:B14').setValues([['복종', '상품 한줄평 모음 (매장 · 상품: 한줄평)']]).setFontWeight('bold').setBackground(HB);
  CATS.forEach((k, i) => {
    const r = 15 + i;
    sh.getRange(r, 1, 1, 2).setFormulas([['="'+k+'"', `=IFERROR(TEXTJOIN(CHAR(10),TRUE,FILTER(상품평가!$F$2:$F$20000&" · "&상품평가!$J$2:$J$20000&": "&상품평가!$O$2:$O$20000,상품평가!$G$2:$G$20000=$A${r},상품평가!$B$2:$B$20000="Y",상품평가!$O$2:$O$20000<>"")),"")`]]);
  });
  sh.getRange('A19:B19').setValues([['복종', '가격 의견 모음 (매장: 의견)']]).setFontWeight('bold').setBackground(HB);
  CATS.forEach((k, i) => {
    const r = 20 + i;
    sh.getRange(r, 1, 1, 2).setFormulas([['="'+k+'"', `=IFERROR(TEXTJOIN(CHAR(10),TRUE,FILTER(가격적정선!$F$2:$F$20000&" · "&가격적정선!$H$2:$H$20000&": "&가격적정선!$M$2:$M$20000,가격적정선!$G$2:$G$20000=$A${r},가격적정선!$B$2:$B$20000="Y",가격적정선!$M$2:$M$20000<>"")),"")`]]);
  });
  sh.getRange('B15:B22').setWrap(true).setVerticalAlignment('top');
  sh.setColumnWidth(1, 80); sh.setColumnWidth(2, 520);

  // 가격적정선취합: 주요 세부복종별 적정가(중앙값) · 현재가 수준 · 경쟁 대비 분포 · 의견
  sh = fresh_(ss, '가격적정선취합');
  sh.getRange('A1:H1').setValues([['복종', '세부복종', '응답수', '적정 하한(중앙값)', '적정 상한(중앙값)', '현재가 수준', '경쟁브랜드 대비', '의견 모음']]).setFontWeight('bold').setBackground(HB);
  PRICE_SUBS.forEach((p, i) => {
    const r = 2 + i, cond = `가격적정선!$H$2:$H$20000=$B${r},가격적정선!$B$2:$B$20000="Y"`, n = (col, v) => `COUNTIFS(가격적정선!$H$2:$H$20000,$B${r},가격적정선!$B$2:$B$20000,"Y",가격적정선!${col}$2:${col}$20000,"${v}")`;
    sh.getRange(r, 1, 1, 8).setFormulas([['="'+p[0]+'"', '="'+p[1]+'"',
      `=COUNTIFS(가격적정선!$H$2:$H$20000,$B${r},가격적정선!$B$2:$B$20000,"Y")`,
      `=IFERROR(MEDIAN(FILTER(가격적정선!$I$2:$I$20000,${cond},ISNUMBER(가격적정선!$I$2:$I$20000))),"")`,
      `=IFERROR(MEDIAN(FILTER(가격적정선!$J$2:$J$20000,${cond},ISNUMBER(가격적정선!$J$2:$J$20000))),"")`,
      `="낮은 편 "&${n('K', '낮은 편')}&" · 적정 "&${n('K', '적정')}&" · 높은 편 "&${n('K', '높은 편')}`,
      `="저렴 "&${n('L', '저렴')}&" · 비슷 "&${n('L', '비슷')}&" · 비쌈 "&${n('L', '비쌈')}`,
      `=IFERROR(TEXTJOIN(CHAR(10),TRUE,FILTER(가격적정선!$F$2:$F$20000&": "&가격적정선!$M$2:$M$20000,${cond},가격적정선!$M$2:$M$20000<>"")),"")`]]);
  });
  sh.getRange(2, 4, PRICE_SUBS.length, 2).setNumberFormat('#,##0'); sh.getRange(2, 8, PRICE_SUBS.length, 1).setWrap(true).setVerticalAlignment('top');
  sh.setColumnWidth(6, 200); sh.setColumnWidth(7, 200); sh.setColumnWidth(8, 420); sh.setFrozenRows(1);

  // 세부복종별 / 상품별: QUERY 집계
  sh = fresh_(ss, '세부복종별');
  sh.getRange('A1').setFormula(`=IFERROR(QUERY(상품평가!A:O,"select G,H,count(I),avg(M),avg(N) where B='Y' group by G,H order by G,H label G '복종',H '세부복종',count(I) '평가건수',avg(M) '디자인',avg(N) '가격'",1),"데이터 없음")`);
  sh.getRange('D:E').setNumberFormat('0.00'); sh.setFrozenRows(1);
  sh = fresh_(ss, '상품별취합');
  sh.getRange('A1').setFormula(`=IFERROR(QUERY(상품평가!A:O,"select G,H,I,J,K,L,count(I),avg(M),avg(N) where B='Y' group by G,H,I,J,K,L order by avg(M) desc label G '복종',H '세부복종',I '품번',J '상품명',K '판매가',L '등급',count(I) '응답수',avg(M) '디자인',avg(N) '가격'",1),"데이터 없음")`);
  sh.getRange('H:I').setNumberFormat('0.00'); sh.getRange('E:E').setNumberFormat('#,##0'); sh.setFrozenRows(1);

  // 제출현황: 매장 목록 대비 제출 여부
  sh = fresh_(ss, '제출현황');
  sh.getRange('A1:E1').setValues([['채널형태', '채널계열', '매장명', '제출여부', '전체만족도']]).setFontWeight('bold').setBackground(HB);
  if (typeof STORE_LIST !== 'undefined') {
    sh.getRange(2, 1, STORE_LIST.length, 3).setValues(STORE_LIST);
    const f = STORE_LIST.map((_, i) => [
      `=IF(COUNTIFS(시즌응답!$G$2:$G$20000,C${i + 2},시즌응답!$B$2:$B$20000,"Y")>0,"제출","미제출")`,
      `=IFERROR(AVERAGEIFS(시즌응답!$H$2:$H$20000,시즌응답!$G$2:$G$20000,C${i + 2},시즌응답!$B$2:$B$20000,"Y"),"")`]);
    sh.getRange(2, 4, f.length, 2).setFormulas(f);
    sh.getRange('G1').setFormula(`=COUNTIF(D2:D${STORE_LIST.length + 1},"제출")&" / ${STORE_LIST.length} 매장 제출"`);
  }
  sh.setFrozenRows(1);

  ['복종별취합', '세부복종별', '상품별취합', '가격적정선취합', '제출현황', '시즌응답', '상품평가', '가격적정선', '경쟁브랜드', '원본JSON'].forEach((n, i) => {
    ss.setActiveSheet(ss.getSheetByName(n)); ss.moveActiveSheet(i + 1);
  });
  const first = ss.getSheetByName('시트1') || ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0) ss.deleteSheet(first);
  SpreadsheetApp.getUi().alert('설정 완료. 이제 [배포 > 새 배포 > 웹 앱] 으로 URL 을 만드세요.');
}
function fresh_(ss, name) { const old = ss.getSheetByName(name); if (old) ss.deleteSheet(old); return ss.insertSheet(name); }
