// 두 설문의 Apps Script(Code.gs)에 '이전 응답 불러오기'(doGet?action=load&sid=...) 를 넣고, 원본JSON 을 잘림 없이 나눠 저장하도록 바꿉니다.
// 새 조사를 만들 때도 같은 코드를 쓰세요(공통 규칙: README 참고). 사용: node scripts/patch_gs_prefill.mjs
import fs from 'node:fs';
const FILES = [['상품반응도_26AW/apps-script/Code.gs', 'store survey endpoint'], ['매장SKU조사/apps-script/Code.gs', 'store sku survey endpoint']];
const LOAD = msg => `/** GET ?action=load&token=<제출ID>  (sid 라는 이름은 Google 이 막아 400 이 나므로 token 사용) : 그 제출ID 를 아는 사람(= 이전에 그 기기로 제출한 매장)에게만 해당 매장의 최신 응답을 돌려줍니다. */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'load' && p.token) return out_(loadPrev_(String(p.token)));
  return out_({ ok: true, msg: '${msg}' });
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
}`;
const CHUNK = `{ const js = JSON.stringify(d), chunks = []; for (let i = 0; i < js.length; i += 40000) chunks.push(js.slice(i, i + 40000)); append_(ss, '원본JSON', [[d.sid, at, s.name].concat(chunks)]); }`;
for (const [f, msg] of FILES) {
  let s = fs.readFileSync(f, 'utf8');
  if (s.includes('loadPrev_')) { console.log('이미 적용됨:', f); continue; }
  const a = s.indexOf('function doGet()'), b = s.indexOf('\n', a);
  s = s.slice(0, a) + LOAD(msg) + s.slice(b);
  s = s.replace(/append_\(ss, '원본JSON', \[\[d\.sid, at, s\.name, JSON\.stringify\(d\)\.slice\(0, 49000\)\]\]\);/, CHUNK);
  fs.writeFileSync(f, s);
  console.log('적용:', f, s.includes('loadPrev_') && s.includes('chunks'));
}
