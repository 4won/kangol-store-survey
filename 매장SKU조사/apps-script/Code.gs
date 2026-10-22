/**
 * 매장 디스플레이 SKU 조사 - 응답 수집기 (Google Apps Script, 구글시트에 연결된 스크립트)
 *
 * 흐름: 설문 페이지(GitHub Pages) -> doPost -> 이 시트에 raw 행 누적
 *   응답       매장당 1행  (의류/가방/모자 실제·적정 DP수, 운영 SKU 의견, 과다 SKU 운영 실태, 방향)
 *   제거요청   매장 x 품번 1행
 *   추가요청   매장 x 품번 1행
 *   원본JSON   제출 1건 = 1행 (원본 그대로, 백업용)
 * 같은 매장이 다시 제출하면 이전 행의 '최신' 칸이 N 으로 바뀌고 새 행이 Y 로 쌓입니다. (삭제 없음)
 * 처음 한 번 setup() 을 실행해 탭을 만들고, 배포 > 새 배포 > 웹 앱(모든 사용자)으로 URL 을 만드세요.
 */
const HEADERS = {
  '응답': ['제출ID', '최신', '제출일시', '시즌', '채널형태', '채널계열', '매장명',
    '의류_실제DP', '의류_적정DP', '의류_차이', '가방_실제DP', '가방_적정DP', '가방_차이', '모자_실제DP', '모자_적정DP', '모자_차이',
    '의류_의견', '가방_의견', '모자_의견', '과다SKU_운영실태', '과다SKU_기타', '차이_방향', '제거요청수', '추가요청수', 'SKU_자유의견'],
  '제거요청': ['제출ID', '최신', '제출일시', '채널형태', '채널계열', '매장명', '복종', '품번', '상품명'],
  '추가요청': ['제출ID', '최신', '제출일시', '채널형태', '채널계열', '매장명', '복종', '품번', '상품명'],
  '원본JSON': ['제출ID', '제출일시', '매장명', 'JSON'],
};
const STORE_COL = { '응답': 7, '제거요청': 6, '추가요청': 6 };   // 1-based 매장명 열
const CATS = ['의류', '가방', '모자'];
const LEVEL = { 1: '너무 많다', 2: '많다', 3: '적당하다', 4: '모자르다', 5: '너무 모자르다' };
const OVER = { store: 'DP하지 않고 창고에 적재', dp: '넘치더라도 매장에 추가 DP', etc: '기타' };
const DIR = { remove: '매장에서 제거(반품 등)', keep: '매장 내 보유(창고 보관 등)', more: '과다하지만 추가 DP' };

/** GET ?action=load&token=<제출ID>  (sid 라는 이름은 Google 이 막아 400 이 나므로 token 사용) : 그 제출ID 를 아는 사람(= 이전에 그 기기로 제출한 매장)에게만 해당 매장의 최신 응답을 돌려줍니다. */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'load' && p.store) return out_(loadByStore_(String(p.store)));
  if (p.action === 'load' && p.token) return out_(loadPrev_(String(p.token)));
  return out_({ ok: true, msg: 'store sku survey endpoint' });
}
/** 매장명으로 그 매장의 최신 응답을 돌려줌 (기기와 무관). */
function loadByStore_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName('원본JSON');
  if (!sh || sh.getLastRow() < 2) return { ok: true, data: null };
  const vals = sh.getDataRange().getValues();
  for (let i = vals.length - 1; i >= 1; i--) if (vals[i][2] === name) {
    try { return { ok: true, store: name, at: vals[i][1], data: JSON.parse(vals[i].slice(3).join('')) }; } catch (err) { return { ok: false, error: 'parse' }; }
  }
  return { ok: true, data: null };
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
    if (d.hp) return out_({ ok: true });                                   // 봇(허니팟) 조용히 무시
    const s = d.store || {};
    if (!d.sid || !s.name || String(s.name).length > 40) return out_({ ok: false, error: 'invalid' });
    if (typeof STORE_LIST !== 'undefined' && !STORE_LIST.some(r => r[2] === s.name)) return out_({ ok: false, error: 'unknown store' });
    const ss = SpreadsheetApp.getActive(), at = new Date(d.at || Date.now());
    ensureSheets_(ss);
    const c = v => (v == null ? '' : (typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v));   // 수식 주입 방지
    const base = [d.sid, 'Y', at], st3 = [s.type, s.group, s.name];
    Object.keys(STORE_COL).forEach(n => markOld_(ss.getSheetByName(n), STORE_COL[n], s.name));

    const k = d.sku || {}, o = d.opinion || {}, ov = d.over || {};
    const num = v => (v === '' || v == null ? '' : Number(v));
    const diff = x => (x && x.actual !== '' && x.actual != null && x.ideal !== '' && x.ideal != null ? Number(x.actual) - Number(x.ideal) : '');
    const sku = CATS.flatMap(cat => { const x = k[cat] || {}; return [num(x.actual), num(x.ideal), diff(x)]; });
    append_(ss, '응답', [base.concat([d.season], st3, sku, CATS.map(cat => LEVEL[o[cat]] || ''), [OVER[ov.choice] || '', ov.choice === 'etc' ? ov.other || '' : '', DIR[d.dir] || '', (d.remove || []).length, (d.add || []).length, d.free || '']).map(c)]);
    append_(ss, '제거요청', (d.remove || []).map(x => base.concat(st3, [x.cat, x.no, x.name]).map(c)));
    append_(ss, '추가요청', (d.add || []).map(x => base.concat(st3, [x.cat, x.no, x.name]).map(c)));
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
    // 1행(헤더)은 항상 최신 정의로 맞춤 — 열이 추가돼도 setup() 한 번으로 반영, 데이터 행은 건드리지 않음
    sh.getRange(1, 1, 1, HEADERS[n].length).setValues([HEADERS[n]]).setFontWeight('bold').setBackground('#e3e8f0');
  });
}
/** 최초 1회 실행: 응답 탭 4개를 만들고 헤더를 최신으로 맞춥니다. 코드를 바꾼 뒤 다시 실행해도 데이터는 그대로입니다. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  ensureSheets_(ss);
  const first = ss.getSheetByName('시트1') || ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);
  ss.toast('설정 완료. 이제 [배포 > 새 배포 > 웹 앱] 으로 URL 을 만드세요.', 'setup', 10);   // alert 는 시트 창에서 확인을 눌러야 끝나므로 toast 사용
  Logger.log('설정 완료');
}
