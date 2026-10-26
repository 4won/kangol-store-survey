// 상품별 구매 연령대 집계: 허브 ERP 판매원장(백화점·복합쇼핑몰·아울렛 매장 — 연령 정보가 신뢰되는 채널)에서 26AW 상품(수입품번)별 연령대 수량을 모아 reports/age.json 으로 저장.
// 사용: node tools/build_age.mjs [--hub D:/claude/kangol-work-hub] [--season 26AW]
// age.json 은 판매 데이터를 담으므로 공개 저장소에 올리지 않습니다(reports/ 는 gitignore). 리포트(암호화)에만 쓰입니다.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HUB = arg('hub', 'D:/claude/kangol-work-hub'), SEASON = arg('season', '26AW');
const { loadErp, listErp } = await import(pathToFileURL(join(HUB, 'tools/lib/sr_raw.mjs')).href);
const { ERP_DIR } = await import(pathToFileURL(join(HUB, 'tools/lib/sr_paths.mjs')).href);

const BANDS = ['중학생이하', '고등학생', '20대초반', '20대후반', '30대', '40대', '50대이상'];
const FORMS = new Set(['백화점', '복합쇼핑몰', '아울렛']);
const products = JSON.parse(readFileSync(join(ROOT, SEASON, 'data/products.json'), 'utf8')).items;
const want = new Set(products.map(p => p.no));
const yr = 2000 + Number(SEASON.slice(0, 2));

const items = {}; let rows = 0, lastYm = '';
for (const { ym, file } of listErp(ERP_DIR)) {
  if (Number(ym.slice(0, 4)) < yr) continue;           // 해당 연도 이후 파일만 (26AW 는 2026-08 이후 판매)
  for (const r of loadErp(file)) {
    if (!FORMS.has(r.form) || !r.imp || !want.has(String(r.imp))) continue;
    const o = (items[r.imp] ||= { n: 0, ages: {} });
    const a = BANDS.includes(r.age) ? r.age : '기타';
    o.n += r.qty; o.ages[a] = (o.ages[a] || 0) + r.qty; rows++; lastYm = ym;
  }
}
mkdirSync(join(ROOT, 'reports'), { recursive: true });
writeFileSync(join(ROOT, 'reports', 'age.json'), JSON.stringify({ season: SEASON, bands: BANDS, through: lastYm, forms: [...FORMS], items }));
const have = Object.keys(items).length;
console.log(`연령 집계: 상품 ${have}/${products.length}개 · 판매 행 ${rows}개 · ${lastYm} 까지`);
