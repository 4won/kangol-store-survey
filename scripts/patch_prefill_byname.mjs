// 이전 응답 불러오기를 '기기'가 아니라 '매장명' 기준으로 바꿉니다. 사용: node scripts/patch_prefill_byname.mjs
import fs from 'node:fs';
for (const f of ['매장SKU조사/26AW/index.html', '상품반응도_26AW/26AW/index.html']) {
  let s = fs.readFileSync(f, 'utf8');
  const rep = (a, b) => { if (!s.includes(a)) { console.log('MISS', f, a.slice(0, 50)); return; } s = s.replace(a, () => b); };
  rep("function prevSid(){return CFG.endpoint&&st.store.name?lastMap()[st.store.name]:''}", "function prevSid(){return CFG.endpoint&&st.store.name?st.store.name:''}");
  rep("const sid=prevSid();if(!sid)return false;", "const nm=prevSid();if(!nm)return false;");
  rep("'action=load&token='+encodeURIComponent(sid))", "'action=load&store='+encodeURIComponent(nm))");
  rep("  if(!auto)toast('이전 제출 내용을 불러오지 못했습니다.');return false}", "  if(!auto)toast('이 매장의 이전 제출 내용이 없습니다.');return false}");
  rep("<b>이 기기에서 이전에 제출한 기록이 있습니다.</b>", "<b>이 매장이 이전에 제출한 내용이 있으면 불러올 수 있습니다.</b>");
  fs.writeFileSync(f, s); console.log('ok', f);
}
for (const f of ['매장SKU조사/apps-script/Code.gs', '상품반응도_26AW/apps-script/Code.gs']) {
  let s = fs.readFileSync(f, 'utf8');
  const a = "if (p.action === 'load' && p.token) return out_(loadPrev_(String(p.token)));";
  if (!s.includes(a)) { console.log('MISS gs', f); continue; }
  s = s.replace(a, () => "if (p.action === 'load' && p.store) return out_(loadByStore_(String(p.store)));\n  " + a);
  s = s.replace("function loadPrev_(sid) {", () => `/** 매장명으로 그 매장의 최신 응답을 돌려줌 (기기와 무관). */
function loadByStore_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName('원본JSON');
  if (!sh || sh.getLastRow() < 2) return { ok: true, data: null };
  const vals = sh.getDataRange().getValues();
  for (let i = vals.length - 1; i >= 1; i--) if (vals[i][2] === name) {
    try { return { ok: true, store: name, at: vals[i][1], data: JSON.parse(vals[i].slice(3).join('')) }; } catch (err) { return { ok: false, error: 'parse' }; }
  }
  return { ok: true, data: null };
}
function loadPrev_(sid) {`);
  fs.writeFileSync(f, s); console.log('ok', f);
}
