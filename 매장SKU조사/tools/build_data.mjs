// 매장 SKU 조사용 데이터 생성: 상품기초정보(26AW) 엑셀 + 매장 리스트 엑셀 → 설문 페이지 데이터
//   node tools/build_data.mjs [--hub D:/claude/kangol-work-hub] [--season 26AW] [--products 상품기초정보_2026AW.xlsx] [--stores 매장리스트_전체_202610.xlsx]
// 출력: {시즌}/data/products.json · {시즌}/data/stores.json · apps-script/StoreList.gs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HUB = arg('hub', 'D:/claude/kangol-work-hub'), SEASON = arg('season', '26AW');
const PRODUCTS = join(ROOT, arg('products', '상품기초정보_2026AW.xlsx')), STORES = join(ROOT, arg('stores', '매장리스트_전체_202610.xlsx'));
const X = createRequire(join(HUB, 'tools/'))('xlsx');
const sheet = f => { const wb = X.readFile(f); return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }); };
const CAT = { '가방': '가방', '수입모자': '모자', '의류': '의류', '의류(여성)': '의류' };   // 기획명 → 조사 구분

// 상품: 수입품번 기준 1행 (색상·사이즈 행은 합침)
const rows = sheet(PRODUCTS), hi = rows.findIndex(r => r.includes('수입품번')), h = rows[hi], ix = n => h.indexOf(n);
const by = new Map();
for (const r of rows.slice(hi + 1)) {
  const no = String(r[ix('수입품번')] ?? '').trim(); if (!no) continue;
  const cat = CAT[r[ix('기획명')]]; if (!cat) continue;
  if (!by.has(no)) by.set(no, { no, cat, sub: r[ix('복종명')] || '', name: String(r[ix('품명')] || '').trim(), price: r[ix('택가')] || null });
}
const cr = { '의류': 0, '가방': 1, '모자': 2 };
const items = [...by.values()].sort((a, b) => cr[a.cat] - cr[b.cat] || a.no.localeCompare(b.no));
mkdirSync(join(ROOT, SEASON, 'data'), { recursive: true });
writeFileSync(join(ROOT, SEASON, 'data/products.json'), JSON.stringify({ season: SEASON, generated: new Date().toISOString().slice(0, 10), items }));
console.log('상품', items.length, ['의류', '가방', '모자'].map(c => `${c} ${items.filter(i => i.cat === c).length}`).join(' · '));

// 매장 (번호·채널형태·채널계열·매장명 순서 그대로)
const sr = sheet(STORES).slice(1).filter(r => r[3]);
const stores = sr.map(r => ({ no: r[0], type: r[1], group: r[2], name: r[3] }));
writeFileSync(join(ROOT, SEASON, 'data/stores.json'), JSON.stringify(stores));
writeFileSync(join(ROOT, 'apps-script/StoreList.gs'), '// build_data.mjs 가 생성 — 직접 수정하지 마세요\nconst STORE_LIST = ' + JSON.stringify(stores.map(s => [s.type, s.group, s.name])) + ';\n');
console.log('매장', stores.length, ['백화점', '쇼핑몰', '아울렛'].map(t => `${t} ${stores.filter(s => s.type === t).length}`).join(' · '));
