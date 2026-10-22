/**
 * 매장 반응도 조사 - 응답 수집기 (Google Apps Script, 구글시트에 연결된 스크립트)
 *
 * 흐름: 매장 설문 페이지(GitHub Pages) -> doPost -> 이 시트에 raw 행 누적
 *   시즌응답    매장당 1행        (시즌 전반 점수/의견)
 *   상품평가    매장x상품 1행     (복종/세부복종/품번/점수/의견)
 *   가격적정선  매장x세부복종 1행
 *   경쟁브랜드  매장x브랜드 1행
 *   원본JSON    제출 1건 = 1행 (원본 그대로, 40,000자씩 나눠 저장 — 이전 응답 불러오기에 사용)
 * 같은 매장이 다시 제출하면 이전 행의 '최신' 칸이 N 으로 바뀌고 새 행이 Y 로 쌓입니다. (삭제 없음 = raw 보존)
 * 취합은 시트 수식 대신 리포트(tools/build_report.mjs)가 raw 탭에서 직접 읽어 만듭니다.
 */
const HEADERS = {
  '시즌응답':   ['제출ID', '최신', '제출일시', '시즌', '채널형태', '채널계열', '매장명', '전체만족도', '상품구성', '물량·입고', '고객반응', '잘된점', '아쉬운점', '기타의견', '경쟁환경의견'],
  '상품평가':   ['제출ID', '최신', '제출일시', '채널형태', '채널계열', '매장명', '복종', '세부복종', '품번', '상품명', '판매가', '등급', '디자인', '가격', '한줄평'],
  '가격적정선': ['제출ID', '최신', '제출일시', '채널형태', '채널계열', '매장명', '복종', '세부복종', '적정하한', '적정상한', '현재가수준', '경쟁대비', '의견'],
  '경쟁브랜드': ['제출ID', '최신', '제출일시', '채널형태', '채널계열', '매장명', '복종', '브랜드', '가격대', '강점', '프로모션·동향', '고객반응'],
  '원본JSON':   ['제출ID', '제출일시', '매장명', 'JSON'],
};
const STORE_COL = { '시즌응답': 7, '상품평가': 6, '가격적정선': 6, '경쟁브랜드': 6 };  // 1-based 매장명 열

/** GET ?action=load&token=<제출ID>  (sid 라는 이름은 Google 이 막아 400 이 나므로 token 사용) : 그 제출ID 를 아는 사람(= 이전에 그 기기로 제출한 매장)에게만 해당 매장의 최신 응답을 돌려줍니다. */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'load' && p.token) return out_(loadPrev_(String(p.token)));
  return out_({ ok: true, msg: 'store survey endpoint' });
}
function loadPrev_(sid) {
  const sh = SpreadsheetApp.getActive().getSheetByName('원본JSON');
  if (!sh || sh.getLastRow() < 2) return { ok: true, data: null };
  const vals = sh.getDataRange().getValues();            // [제출ID, 제출일시, 매장명, JSON 조각1, 조각2, ...]
  const hit = vals.slice(1).find(r => String(r[0]) === sid);
  if (!hit) return { ok: true, data: null };
  let last = null;
  for (let i = vals.length - 1; i >= 1; i--) if (vals[i][2] === hit[2]) { last = vals[i]; break; }   // 같은 매장의 가장 최근 제출
  try { return { ok: true, store: hit[2], at: last[1], data: JSON.parse(last.slice(3).join('')) }; } catch (err) { return { ok: false, error: 'parse' }; }
}

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
    { const js = JSON.stringify(d), chunks = []; for (let i = 0; i < js.length; i += 40000) chunks.push(js.slice(i, i + 40000)); append_(ss, '원본JSON', [[d.sid, at, s.name].concat(chunks)]); }
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
    if (!sh) { sh = ss.insertSheet(n); sh.setFrozenRows(1); }
    sh.getRange(1, 1, 1, HEADERS[n].length).setValues([HEADERS[n]]).setFontWeight('bold').setBackground('#e8ebf5');   // 헤더는 항상 최신 정의로 맞춤(데이터 행은 그대로)
  });
}
/** 필요할 때만 실행: 응답 탭 5개가 없으면 만들고 헤더를 맞춥니다. (이미 탭이 있으면 헤더만 갱신, 데이터는 그대로) */
function setup() {
  const ss = SpreadsheetApp.getActive();
  ensureSheets_(ss);
  ss.toast('설정 완료', 'setup', 5);
  Logger.log('설정 완료');
}
