// 설문용 데이터 생성: 허브(kangol-work-hub)의 요약 JSON·이미지에서 '출고된 26AW 상품' 목록을 만든다.
//   node tools/build_data.mjs [--hub D:/claude/kangol-work-hub] [--stores C:/Users/-/Downloads/매장리스트_현재.xlsx] [--season 26AW]
// 출력: {시즌}/data/products.json · {시즌}/data/stores.json(--stores 지정 시) · {시즌}/img/*.jpg
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HUB = arg('hub', 'D:/claude/kangol-work-hub'), SEASON = arg('season', '26AW'), STORES = arg('stores', '');
const OUT = join(ROOT, SEASON), CAT_ORDER = ['가방', '의류', '모자'];
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));

// 1) 최신 주차 productmap
const index = readJson(join(HUB, 'data/summary/index.json'));
const week = arg('week', index.latest);
const pm = readJson(join(HUB, 'data/summary/productmap', week + '.json'));
const base = readJson(join(HUB, 'product-map-new/base.json')).products || {};

// 2) 수입품번 → 품번(이미지 파일명) 매핑 (대시보드 loader.js 와 같은 규칙: 년도+시즌 일치)
const yr = 2000 + Number(SEASON.slice(0, 2)), fall = SEASON.slice(2) === 'AW';
const imgDir = join(HUB, 'product-info-old', SEASON);
const have = new Set(readdirSync(imgDir).filter(f => /\.jpg$/i.test(f)).map(f => f.replace(/\.jpg$/i, '')));
const codeOf = {};
for (const r of readJson(join(HUB, 'data/summary/product-info.json')))
  if (Number(r.년도명) === yr && String(r.시즌명).includes('가을') === fall && r.수입품번 && r.품번) (codeOf[r.수입품번] ||= []).push(r.품번);

// 3) 출고된 상품만: 색상 중 하나라도 출고완료. 목록에는 출고된 색상만 표시
rmSync(join(OUT, 'img'), { recursive: true, force: true }); mkdirSync(join(OUT, 'img'), { recursive: true });
// 설문 제외 대상: 상품명이 MADSAKI 로 시작 / 지정 품번 (K5502·K5504 온라인전용, BS0001·PT0010·ZU0010 키즈/성인 등록대기)
const EXCLUDE_NAME = /^madsaki/i, EXCLUDE_NO = new Set(['K5502', 'K5504', 'BS0001', 'PT0010', 'ZU0010']);
const items = [];
for (const p of pm.products) {
  if (EXCLUDE_NAME.test(String(p.item_name).trim()) || EXCLUDE_NO.has(p.product_no)) continue;
  const shipped = (p.colors_agg || []).filter(c => c.ship_status === '출고완료');
  if (!shipped.length) continue;
  const code = (codeOf[p.product_no] || []).find(c => have.has(c));
  if (code) copyFileSync(join(imgDir, code + '.jpg'), join(OUT, 'img', code + '.jpg'));
  items.push({
    no: p.product_no, cat: p.category, sub: p.sub_category || '기타', name: p.item_name,
    price: p.sale_price || p.tag_price || null,
    grade: p.volume_grade || (base[p.product_no] || {}).volume_grade || null,
    colors: shipped.map(c => c.color), img: code ? `img/${code}.jpg` : null,
  });
}
// 세부 복종은 상품 수가 많은 순, '기타' 는 마지막
const cnt = {}; items.forEach(i => { const k = i.cat + '|' + i.sub; cnt[k] = (cnt[k] || 0) + 1; });
const subRank = i => (i.sub === '기타' ? 1e6 : 1e5 - cnt[i.cat + '|' + i.sub] * 100);
items.sort((a, b) => CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat) || subRank(a) - subRank(b) || a.sub.localeCompare(b.sub, 'ko') || a.no.localeCompare(b.no));
writeFileSync(join(OUT, 'data/products.json'), JSON.stringify({ season: SEASON, week, generated: new Date().toISOString().slice(0, 10), items }));
const noImg = items.filter(i => !i.img);
console.log(`상품 ${items.length}개 (기준 주차 ${week}) · 이미지 없음 ${noImg.length}개`, noImg.map(i => i.no).join(' '));
for (const c of CAT_ORDER) console.log(' ', c, items.filter(i => i.cat === c).length);

// 4) 매장 리스트 (번호·채널형태·채널계열·매장명 순서 그대로)
if (STORES) {
  const X = createRequire(join(HUB, 'tools/'))('xlsx');
  const wb = X.readFile(STORES), rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }).slice(1).filter(r => r[3]);
  const stores = rows.map(r => ({ no: r[0], type: r[1], group: r[2], name: r[3] }));
  writeFileSync(join(OUT, 'data/stores.json'), JSON.stringify(stores));
  console.log('매장', stores.length);
  // Apps Script 용 매장 목록 (제출현황 시트에서 미제출 매장 확인용)
  writeFileSync(join(ROOT, 'apps-script/StoreList.gs'), '// build_data.mjs 가 생성 — 직접 수정하지 마세요\nconst STORE_LIST = ' + JSON.stringify(stores.map(s => [s.type, s.group, s.name])) + ';\n');
}
