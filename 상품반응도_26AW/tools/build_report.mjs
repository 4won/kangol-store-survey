// 취합 리포트(A4 가로 HTML) 생성: 구글시트 raw 응답 + 허브 productmap(입고·판매·판매율) 결합
//   node tools/build_report.mjs [--season 26AW] [--sheet <시트ID>] [--hub D:/claude/kangol-work-hub] [--csv <폴더>] [--pdf]
//   · 응답: 구글시트(링크 보기 공유) 의 raw 탭을 CSV 로 읽음. --csv 폴더를 주면 그 안의 {탭명}.csv 사용(오프라인 확인용)
//   · 출력: reports/{시즌}/취합리포트_{기준일}.html  (판매 수치가 들어가므로 git 에 올리지 않음 — .gitignore)
//   · --pdf: 설치된 Chrome 으로 같은 위치에 PDF 도 생성
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes, pbkdf2Sync, createCipheriv } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes('--' + k);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEASON = arg('season', '26AW'), HUB = arg('hub', 'D:/claude/kangol-work-hub');
// 시트 ID 는 공개 저장소에 올리지 않음: --sheet 또는 reports/sheet.txt(gitignore) 에 보관
const sheetFile = join(ROOT, 'reports', 'sheet.txt');
const SHEET = arg('sheet', existsSync(sheetFile) ? readFileSync(sheetFile, 'utf8').trim() : ''), CSVDIR = arg('csv', '');
if (!SHEET && !CSVDIR) { console.error('시트 ID 가 없습니다. --sheet <ID> 를 주거나 reports/sheet.txt 에 ID 를 적어 두세요.'); process.exit(1); }
const HUBPUB = flag('hub-publish');   // 허브(kangol-work-hub) ETC 메뉴용: 이미지는 허브의 product-info-old 를 참조, 출력은 허브 etc-reports
const PORTAL = flag('portal');   // 깃허브 포털용: 리포트를 비밀번호로 암호화해 report/report.enc.json 으로 저장 (이미지는 사이트의 {시즌}/img 참조)
const imgSrc = p => (PORTAL ? `${SEASON}/img/${p.img.split('/').pop()}` : HUBPUB ? `../product-info-old/${SEASON}/${p.img.split('/').pop()}` : `../../${SEASON}/${p.img}`);
const LOW = 2.5, WARN = 3.0;                      // 점수 색 기준: LOW 미만 빨강, WARN 미만 주황
const CATS = ['가방', '의류', '모자'];
const PSUBS = { '가방': ['토트백', '크로스백', '백팩'], '의류': ['긴소매티셔츠', '라운드티셔츠', '집업', '바지', '자켓', '후드티셔츠', '셔츠', '니트'], '모자': ['벙거지', '야구모자'] };
const CHANNELS = ['백화점', '아울렛', '쇼핑몰'];
const chLabel = ch => (ch === '쇼핑몰' ? '복합쇼핑몰' : ch);

/* ---------- 읽기 ---------- */
function parseCsv(t) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
async function tab(name) {
  let text;
  if (CSVDIR) text = readFileSync(join(CSVDIR, name + '.csv'), 'utf8');
  else {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`, { redirect: 'follow' });
    if (!r.ok) throw new Error(`${name} 탭 읽기 실패 (HTTP ${r.status}) — 시트가 '링크가 있는 모든 사용자: 보기' 인지 확인`);
    text = await r.text();
  }
  const [h, ...rows] = parseCsv(text);
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}
const num = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return v === '' || v == null || isNaN(n) ? null : n; };
const latest = rows => rows.filter(r => r['최신'] === 'Y');

const [S, PR0, PC, CP] = [await tab('시즌응답'), await tab('상품평가'), await tab('가격적정선'), await tab('경쟁브랜드')].map(latest);
const stores = JSON.parse(readFileSync(join(ROOT, SEASON, 'data/stores.json'), 'utf8'));
const prodList = JSON.parse(readFileSync(join(ROOT, SEASON, 'data/products.json'), 'utf8'));
const knownNo = new Set(prodList.items.map(p => p.no));
const PR = PR0.filter(r => knownNo.has(r['품번']));     // 제외 상품(설문 목록에 없는 품번)의 응답은 집계에서 뺌
const index = JSON.parse(readFileSync(join(HUB, 'data/summary/index.json'), 'utf8'));
const pmWeek = arg('week', index.latest);
const pm = JSON.parse(readFileSync(join(HUB, 'data/summary/productmap', pmWeek + '.json'), 'utf8'));
const pmBy = Object.fromEntries(pm.products.map(p => [p.product_no, p]));
// 전년(25AW) 동시점 비교: 판매 시스템(ERP) 시즌 비교 데이터. 카테고리 전체 기준
let ERP = [];
try {
  const sf = join(HUB, 'data/summary/sales', pmWeek + '.json');
  ERP = JSON.parse(readFileSync(existsSync(sf) ? sf : join(HUB, 'data/summary/sales', index.latest + '.json'), 'utf8')).seasonCompare.seasons;
} catch (e) { console.log('전년 비교 데이터를 읽지 못했습니다:', e.message); }
const ERP_MAP = { '가방': ['가방'], '의류': ['의류', '의류(여성)'], '모자': ['수입모자'] };
function erpCat(c) {
  const se = ERP.find(x => x.season === SEASON); if (!se) return null;
  const rows = ERP_MAP[c].map(k => se.items[k]).filter(Boolean); if (!rows.length) return null;
  const t = k => rows.reduce((a, r) => a + (r[k] || 0), 0), inb = t('in_qty'), sale = t('sale_qty'), pInb = t('py_in_qty'), pSale = t('py_sale_qty');
  return { inb, sale, rate: inb ? sale / inb : null, pInb, pSale, pRate: pInb ? pSale / pInb : null };
}

/* ---------- 계산 ---------- */
const avg = a => { a = a.filter(x => x != null); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };
const med = a => { a = a.filter(x => x != null).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const sum = a => a.reduce((s, x) => s + (x || 0), 0);
const cnt = (a, v) => a.filter(x => x === v).length;
const f1 = x => (x == null ? '-' : x.toFixed(1)), f2 = x => (x == null ? '-' : x.toFixed(2));
const n0 = x => (x == null ? '-' : Number(x).toLocaleString('ko-KR'));
const pct = x => (x == null ? '-' : (x * 100).toFixed(1) + '%');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cls = x => (x == null ? '' : x < LOW ? ' low' : x < WARN ? ' warn' : '');
const sc = (x, d = 2) => `<td class="n${cls(x)}">${x == null ? '-' : x.toFixed(d)}</td>`;
const dist = (a, keys) => keys.filter(k => cnt(a, k)).map(k => `${k} ${cnt(a, k)}`).join(' · ') || '-';

const storeCount = new Set(S.map(r => r['매장명'])).size;
const typeOf = Object.fromEntries(stores.map(s => [s.name, s.type]));
const channelOf = name => typeOf[name] || (S.concat(PR).find(r => r['매장명'] === name) || {})['채널형태'] || '';

// 상품별 집계
const byProd = {};
for (const r of PR) (byProd[r['품번']] ||= []).push(r);
const KW = JSON.parse(readFileSync(join(ROOT, 'tools/keywords.json'), 'utf8'));
const STATUS_RE = new RegExp(KW.status.pattern);
const products = prodList.items.map(p => {
  const rs = byProd[p.no] || [], m = pmBy[p.no] || {};
  const inbound = m.inbound_qty ?? null, sales = m.sales_qty ?? null;
  return {
    ...p, rows: rs, n: rs.filter(r => num(r['디자인']) != null || num(r['가격']) != null).length, notIn: new Set(rs.filter(r => STATUS_RE.test(r['한줄평'] || '')).map(r => r['매장명'])).size, design: avg(rs.map(r => num(r['디자인']))), pscore: avg(rs.map(r => num(r['가격']))),
    inbound, sales, rate: inbound ? sales / inbound : (m.sell_through ?? null),
    comments: rs.filter(r => r['한줄평'] && !STATUS_RE.test(r['한줄평'])).map(r => ({ store: r['매장명'], text: r['한줄평'] })),
  };
});
// 가중 중앙값: 가격순으로 줄 세워 누적 가중치가 절반을 넘는 지점의 가격 (가중치 = 입고량 또는 판매량)
function wmed(list, key) {
  const a = list.filter(p => p.price && p[key] > 0).sort((x, y) => x.price - y.price), tot = a.reduce((t, p) => t + p[key], 0);
  if (!a.length) return null;
  let acc = 0; for (const p of a) { acc += p[key]; if (acc >= tot / 2) return p.price; }
  return a[a.length - 1].price;
}
const priceStats = list => { const ps = list.filter(p => p.price).map(p => p.price); return { ps, wi: wmed(list, 'inbound'), ws: wmed(list, 'sales') }; };
const respByCat = c => PR.filter(r => r['복종'] === c);
const agg = list => ({ inbound: sum(list.map(p => p.inbound)), sales: sum(list.map(p => p.sales)), n: sum(list.map(p => p.n)) });
const rateOf = a => (a.inbound ? a.sales / a.inbound : null);

/* ---------- 렌더 ---------- */
const nowK = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');   // 한국시간 YYYY-MM-DD HH:mm
const today = nowK.slice(0, 10);
const asOf = pm.meta?.data_as_of || pmWeek;
const mainPages = [], appPages = [];
const page = (title, body, cls2 = '', target = 'app') => (target === 'main' ? mainPages : appPages).push(`<section class="pg ${cls2}"><h2>${title}</h2>${body}</section>`);
const legend = `<div class="legend"><span class="sw low"></span>${LOW.toFixed(1)}점 미만 <span class="sw warn"></span>${LOW.toFixed(1)}~${WARN.toFixed(1)}점 미만 <span class="mut">· 점수는 1~5점 평균 (시즌 전반은 전년 25AW = 3점 기준)</span></div>`;

// 2) 복종별 상품 취합
for (const c of CATS) {
  const list = products.filter(p => p.cat === c);
  const subs = [...new Set(list.map(p => p.sub))];
  let body = `<table class="prod"><thead><tr><th>품번</th><th>상품명</th><th class="n">판매가</th><th>등급</th><th class="n">입고</th><th class="n">판매</th><th class="n">판매율</th><th class="n">응답</th><th class="n">디자인</th><th class="n">가격</th><th>한줄평 (매장: 의견)</th></tr></thead>`;
  for (const s of subs) {
    const l = list.filter(p => p.sub === s).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1)), a = agg(l), rs = respByCat(c).filter(r => r['세부복종'] === s);
    body += `<tbody><tr class="grp"><td colspan="4">${esc(s)} <span class="mut">${l.length}개</span></td><td class="n">${n0(a.inbound)}</td><td class="n">${n0(a.sales)}</td><td class="n">${pct(rateOf(a))}</td><td class="n">${rs.length}</td>${sc(avg(rs.map(r => num(r['디자인']))))}${sc(avg(rs.map(r => num(r['가격']))))}<td></td></tr>`;
    for (const p of l) {
      const cm = p.comments.slice(0, 4).map(x => `<div><b>${esc(x.store)}</b> ${esc(x.text.replace(/^\[테스트\]\s*/, ''))}</div>`).join('') + (p.comments.length > 4 ? `<div class="mut">외 ${p.comments.length - 4}건</div>` : '');
      body += `<tr class="${p.n ? '' : 'none'}"><td>${esc(p.no)}</td><td>${esc(p.name)}</td><td class="n">${n0(p.price)}</td><td>${esc(p.grade || '')}</td><td class="n">${n0(p.inbound)}</td><td class="n">${n0(p.sales)}</td><td class="n">${pct(p.rate)}</td><td class="n">${p.n || '-'}</td>${sc(p.design)}${sc(p.pscore)}<td class="cm">${cm}</td></tr>`;
    }
    body += `</tbody>`;
  }
  const a = agg(list), rs = respByCat(c);
  body += `<tfoot><tr class="tot"><td colspan="4">${c} 합계 · ${list.length}개</td><td class="n">${n0(a.inbound)}</td><td class="n">${n0(a.sales)}</td><td class="n">${pct(rateOf(a))}</td><td class="n">${rs.length}</td>${sc(avg(rs.map(r => num(r['디자인']))))}${sc(avg(rs.map(r => num(r['가격']))))}<td></td></tr></tfoot></table>`;
  page(`부록 A. ${c} 상품 취합`, legend + body, 'flow');
}

// 3) 가격 적정선
{
  let body = `<table><thead><tr><th>복종</th><th>세부복종</th><th class="n">현재 판매가 범위</th><th class="n">입고 가중 중앙값</th><th class="n">판매 가중 중앙값</th><th class="n">응답</th><th class="n">적정 하한</th><th class="n">적정 상한</th><th>판정</th><th>우리 가격 수준</th><th>경쟁브랜드 대비</th><th>의견</th></tr></thead><tbody>`;
  for (const c of CATS) for (const s of PSUBS[c]) {
    const { ps, wi: pm_, ws: pws } = priceStats(products.filter(p => p.cat === c && p.sub === s)), rs = PC.filter(r => r['세부복종'] === s);
    const lo = med(rs.map(r => num(r['적정하한']))), hi = med(rs.map(r => num(r['적정상한'])));
    let verdict = '<span class="mut">-</span>';
    if (pm_ != null && hi != null && lo != null) verdict = pm_ > hi ? '<span class="tagr">적정가 초과</span>' : pm_ < lo ? '<span class="tagb">적정가 미만</span>' : '<span class="tagg">적정 범위</span>';
    const cm = rs.filter(r => r['의견']).slice(0, 3).map(r => `<div><b>${esc(r['매장명'])}</b> ${esc(r['의견'].replace(/^\[테스트\]\s*/, ''))}</div>`).join('');
    body += `<tr><td class="nw">${c}</td><td class="nw">${s}</td><td class="n">${ps.length ? n0(Math.min(...ps)) + ' ~ ' + n0(Math.max(...ps)) : '-'}</td><td class="n">${n0(pm_)}</td><td class="n" style="color:#8C6B1F">${n0(pws)}</td><td class="n">${rs.length || '-'}</td><td class="n">${n0(lo)}</td><td class="n">${n0(hi)}</td><td>${verdict}</td><td>${dist(rs.map(r => r['현재가수준']), ['낮은 편', '적정', '높은 편'])}</td><td>${dist(rs.map(r => r['경쟁대비']), ['저렴', '비슷', '비쌈'])}</td><td class="cm">${cm}</td></tr>`;
  }
  page('부록 B. 가격 적정선 상세', `<div class="sub">매장이 제시한 적정 가격대(중앙값)와 현재 판매가를 비교합니다. 입고량 가중 중앙값(상품 판매가를 입고량으로 가중)이 적정 하한~상한을 벗어나는지로 판정합니다. 판매 가중 중앙값은 참고용입니다.</div>${body}</tbody></table>`, 'flow');
}

// 4) 채널별 비교
{
  let body = `<table><thead><tr><th rowspan="2">채널</th><th rowspan="2" class="n">응답 매장</th>${CATS.map(c => `<th colspan="2" class="c">${c}</th>`).join('')}<th colspan="4" class="c">시즌 전반</th></tr><tr>${CATS.map(() => '<th class="n">디자인</th><th class="n">가격</th>').join('')}<th class="n">전체</th><th class="n">구성</th><th class="n">입고</th><th class="n">고객</th></tr></thead><tbody>`;
  for (const ch of CHANNELS) {
    const ss = S.filter(r => channelOf(r['매장명']) === ch), pr = PR.filter(r => channelOf(r['매장명']) === ch);
    body += `<tr><td>${ch}</td><td class="n">${new Set(ss.map(r => r['매장명'])).size}</td>${CATS.map(c => { const x = pr.filter(r => r['복종'] === c); return sc(avg(x.map(r => num(r['디자인'])))) + sc(avg(x.map(r => num(r['가격'])))); }).join('')}${sc(avg(ss.map(r => num(r['전체만족도']))), 1)}${sc(avg(ss.map(r => num(r['상품구성']))), 1)}${sc(avg(ss.map(r => num(r['물량·입고']))), 1)}${sc(avg(ss.map(r => num(r['고객반응']))), 1)}</tr>`;
  }
  body += `</tbody></table>`;
  // 채널계열(백화점 등) 세부
  const groups = [...new Set(S.map(r => r['채널형태'] + '|' + r['채널계열']))].sort();
  body += `<h3>채널계열별</h3><table><thead><tr><th>채널</th><th>계열</th><th class="n">매장</th>${CATS.map(c => `<th class="n">${c} 디자인</th><th class="n">${c} 가격</th>`).join('')}<th class="n">시즌 전체</th></tr></thead><tbody>`;
  for (const g of groups) {
    const [t, gr] = g.split('|'), ss = S.filter(r => r['채널형태'] === t && r['채널계열'] === gr), pr = PR.filter(r => r['채널형태'] === t && r['채널계열'] === gr);
    body += `<tr><td>${t}</td><td>${gr}</td><td class="n">${new Set(ss.map(r => r['매장명'])).size}</td>${CATS.map(c => { const x = pr.filter(r => r['복종'] === c); return sc(avg(x.map(r => num(r['디자인'])))) + sc(avg(x.map(r => num(r['가격'])))); }).join('')}${sc(avg(ss.map(r => num(r['전체만족도']))), 1)}</tr>`;
  }
  page('부록 C. 채널별 비교 상세', legend + body + '</tbody></table>', 'flow');
}

// 5) 경쟁브랜드
// 같은 브랜드의 다른 표기(오타·한글/영문)를 하나로 합침. 규칙은 공백·대소문자를 뺀 표기에 적용
const BALIAS = [[/^(리|lee)$/, 'LEE'], [/^뉴발란스/, '뉴발란스'], [/^마리떼(프랑소와저버)?$/, '마리떼 프랑소와 저버'], [/^(마뗑킴|마땡킴|마떼킴|하고하우스\(마뗑킴\))$/, '마뗑킴'], [/^(와키윌리|와키텔리)$/, '와키윌리'], [/^(내셔널지오그래픽|내셔널|네셔널|네셔날지오그래픽)$/, '내셔널지오그래픽'], [/^(브라운브레스|브라운브래스)$/, '브라운브레스'], [/^(코닥|코탁)$/, '코닥'], [/^(mlb|엠엘비)$/, 'MLB'], [/^노스페이스/, '노스페이스'], [/^커버낫(우먼리버.*)?$/, '커버낫']];
const bnorm = raw => String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
const bkey = raw => { const n = bnorm(raw); const a = BALIAS.find(([re]) => re.test(n)); return a ? a[1] : n; };
const bname = l => { const k = bkey(l[0]['브랜드']); return BALIAS.some(([, v]) => v === k) ? k : l[0]['브랜드'].trim(); };
{
  let body = '';
  for (const g of ['의류', '가방']) {
    const rs = CP.filter(r => r['복종'] === g && r['브랜드']), by = {};
    rs.forEach(r => (by[bkey(r['브랜드'])] ||= []).push(r));
    const rows = Object.values(by).sort((a, b) => new Set(b.map(r => r['매장명'])).size - new Set(a.map(r => r['매장명'])).size);
    body += `<h3>${g}</h3><table><thead><tr><th>브랜드</th><th class="n">언급 매장</th><th>가격대</th><th>강점</th><th>프로모션·동향</th><th>고객 반응</th></tr></thead><tbody>` +
      (rows.map(l => { const j = k => [...new Set(l.map(r => r[k]).filter(Boolean))].map(esc).join(' / '); return `<tr><td><b>${esc(bname(l))}</b></td><td class="n">${new Set(l.map(r => r['매장명'])).size}</td><td>${j('가격대')}</td><td>${j('강점')}</td><td>${j('프로모션·동향')}</td><td>${j('고객반응')}</td></tr>`; }).join('') || '<tr><td colspan="6" class="mut">응답 없음</td></tr>') + '</tbody></table>';
  }
  page('부록 D. 경쟁브랜드 상세', `<div class="sub">매장이 꼽은 대표 경쟁브랜드(의류·가방 각 2곳). 같은 브랜드는 합쳐서 언급 매장 수 순으로 정렬.</div>${body}`, 'flow');
}

// 6) 시즌 전반 의견
{
  const rows = S.slice().sort((a, b) => (a['채널형태'] + a['매장명']).localeCompare(b['채널형태'] + b['매장명'], 'ko')).map(r => `<tr><td>${esc(r['채널형태'])}<br><b>${esc(r['매장명'])}</b></td>${sc(num(r['전체만족도']), 0)}${sc(num(r['상품구성']), 0)}${sc(num(r['물량·입고']), 0)}${sc(num(r['고객반응']), 0)}<td class="cm">${esc((r['잘된점'] || '').replace(/^\[테스트\]\s*/, ''))}</td><td class="cm">${esc((r['아쉬운점'] || '').replace(/^\[테스트\]\s*/, ''))}</td><td class="cm">${esc((r['기타의견'] || '').replace(/^\[테스트\]\s*/, ''))}${r['경쟁환경의견'] ? `<div class="mut">경쟁환경: ${esc(r['경쟁환경의견'].replace(/^\[테스트\]\s*/, ''))}</div>` : ''}</td></tr>`).join('');
  page('부록 E. 시즌 전반 의견 (매장별)', `<div class="sub">전년(25AW) = 3점 기준. 3점 미만은 색으로 표시.</div><table><thead><tr><th>매장</th><th class="n">전체</th><th class="n">구성</th><th class="n">입고</th><th class="n">고객</th><th>잘 된 점</th><th>아쉬운 점</th><th>기타</th></tr></thead><tbody>${rows}</tbody></table>`, 'flow');
}

// 부록) 매장별 의견 — 매장마다 새 페이지
for (const s of S.slice().sort((a, b) => (a['채널형태'] + a['채널계열'] + a['매장명']).localeCompare(b['채널형태'] + b['채널계열'] + b['매장명'], 'ko'))) {
  const name = s['매장명'], pr = PR.filter(r => r['매장명'] === name), pc = PC.filter(r => r['매장명'] === name), cp = CP.filter(r => r['매장명'] === name);
  const clean = t => esc(String(t || '').replace(/^\[테스트\]\s*/, ''));
  const prodRows = pr.map(r => { const m = pmBy[r['품번']] || {}; return `<tr><td>${esc(r['복종'])}·${esc(r['세부복종'])}</td><td>${esc(r['품번'])}</td><td>${esc(r['상품명'])}</td><td class="n">${n0(num(r['판매가']))}</td><td class="n">${pct(m.inbound_qty ? m.sales_qty / m.inbound_qty : null)}</td>${sc(num(r['디자인']), 0)}${sc(num(r['가격']), 0)}<td class="cm">${clean(r['한줄평'])}</td></tr>`; }).join('');
  page(`부록 F. ${esc(name)} <span class="mut">${esc(s['채널형태'])} · ${esc(s['채널계열'])}</span>`, `
  <div class="kpis small"><div class="kpi"><b class="${cls(num(s['전체만족도'])).trim()}">${s['전체만족도'] || '-'}</b><span>전체</span></div><div class="kpi"><b class="${cls(num(s['상품구성'])).trim()}">${s['상품구성'] || '-'}</b><span>구성</span></div><div class="kpi"><b class="${cls(num(s['물량·입고'])).trim()}">${s['물량·입고'] || '-'}</b><span>입고</span></div><div class="kpi"><b class="${cls(num(s['고객반응'])).trim()}">${s['고객반응'] || '-'}</b><span>고객반응</span></div><div class="kpi"><b>${pr.length}</b><span>평가 상품</span></div></div>
  <div class="three"><div><h3>잘 된 점</h3><p>${clean(s['잘된점']) || '-'}</p></div><div><h3>아쉬운 점</h3><p>${clean(s['아쉬운점']) || '-'}</p></div><div><h3>기타 · 경쟁환경</h3><p>${clean(s['기타의견']) || '-'}</p><p>${clean(s['경쟁환경의견'])}</p></div></div>
  <h3>상품 평가</h3><table><thead><tr><th>복종</th><th>품번</th><th>상품명</th><th class="n">판매가</th><th class="n">판매율</th><th class="n">디자인</th><th class="n">가격</th><th>한줄평</th></tr></thead><tbody>${prodRows || '<tr><td colspan="8" class="mut">평가한 상품 없음</td></tr>'}</tbody></table>
  <div class="two"><div><h3>가격 적정선</h3><table><thead><tr><th>복종</th><th class="n">하한</th><th class="n">상한</th><th>가격 수준</th><th>경쟁 대비</th><th>의견</th></tr></thead><tbody>${pc.map(r => `<tr><td>${esc(r['세부복종'])}</td><td class="n">${n0(num(r['적정하한']))}</td><td class="n">${n0(num(r['적정상한']))}</td><td>${esc(r['현재가수준'])}</td><td>${esc(r['경쟁대비'])}</td><td class="cm">${clean(r['의견'])}</td></tr>`).join('') || '<tr><td colspan="6" class="mut">-</td></tr>'}</tbody></table></div>
  <div><h3>경쟁브랜드</h3><table><thead><tr><th>구분</th><th>브랜드</th><th>가격대</th><th>강점·동향·반응</th></tr></thead><tbody>${cp.map(r => `<tr><td>${esc(r['복종'])}</td><td><b>${esc(r['브랜드'])}</b></td><td>${esc(r['가격대'])}</td><td class="cm">${[r['강점'], r['프로모션·동향'], r['고객반응']].filter(Boolean).map(clean).join(' / ')}</td></tr>`).join('') || '<tr><td colspan="4" class="mut">-</td></tr>'}</tbody></table></div></div>`, 'flow store');
}


/* ---------- 대시보드 본문 (A4 가로 8페이지) ---------- */
const W_D = 0.6, W_P = 0.4;                         // 종합점수 = 디자인 60% + 가격 40%
const comp = (d, p) => {
  if (d == null && p == null) return null;
  const wd = d != null ? W_D : 0, wp = p != null ? W_P : 0;
  return ((d ?? 0) * wd + (p ?? 0) * wp) / (wd + wp);
};
products.forEach(p => { p.comp = comp(p.design, p.pscore); });
const dAvg = rs => avg(rs.map(r => num(r['디자인']))), pAvg = rs => avg(rs.map(r => num(r['가격'])));
const compOf = rs => comp(dAvg(rs), pAvg(rs));
const C = { navy: '#1F3A5C', navy2: '#16283F', steel: '#8fa3bf', mist: '#e3e8f0', line: '#e6e8ec', brass: '#8C6B1F', gold: '#D9C68C', low: '#b5524a', warn: '#b98f3c', good: '#3f6f5a', mute: '#c8ccd4', bag: '#c98a55', cloth: '#5f9e84', hat: '#8a7bbf' };
const catColor = { '가방': C.bag, '의류': C.cloth, '모자': C.hat };
const scCol = x => (x == null ? C.mute : x < LOW ? C.low : x < WARN ? C.warn : C.navy);
const heat = x => (x == null ? 'h0' : x < LOW ? 'hl' : x < WARN ? 'hw' : x >= 4 ? 'hh' : 'ho');
const cell = (x, d = 1) => `<span class="cellv ${heat(x)}">${x == null ? '-' : x.toFixed(d)}</span>`;
const clean = t => String(t || '').replace(/^\[테스트\]\s*/, '');
const clip = (t, n) => { t = clean(t); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const thumb = p => (p.img ? `<img src="${imgSrc(p)}" alt="">` : '<i>-</i>');

// SVG: 가로 막대 (점수 1~5, 2.5·3.0 기준선)
function hbars(rows, { w = 330, label = 76, rowH = 13, gap = 6, min = 1, max = 5, thr = true } = {}) {
  const pw = w - label - 34, xs = v => label + ((v - min) / (max - min)) * pw;
  const ys = []; let acc = 14; rows.forEach(r => { ys.push(acc); acc += (r.h || rowH) + (r.gap ?? gap); });
  const H = acc;
  let g = '';
  if (thr) g += `<line x1="${xs(LOW)}" x2="${xs(LOW)}" y1="10" y2="${H}" stroke="${C.low}" stroke-dasharray="2 3" stroke-width=".8"/><line x1="${xs(WARN)}" x2="${xs(WARN)}" y1="10" y2="${H}" stroke="#9aa0ab" stroke-dasharray="2 3" stroke-width=".8"/><text x="${xs(LOW)}" y="7" font-size="8" text-anchor="middle" fill="${C.low}">2.5</text><text x="${xs(WARN)}" y="7" font-size="8" text-anchor="middle" fill="#7b8190">3.0</text>`;
  rows.forEach((r, i) => {
    const y = ys[i], rh = r.h || rowH, fs = r.fs || 9.5, bw = r.v == null ? 0 : Math.max(2, xs(r.v) - label);
    g += `<text x="${r.indent || 0}" y="${y + rh / 2 + fs * 0.36}" font-size="${fs}" fill="${r.soft ? '#5b6270' : '#1c2230'}" ${r.bold ? 'font-weight="700"' : ''}>${esc(r.label)}</text><rect x="${label}" y="${y}" width="${pw}" height="${rh}" rx="2" fill="#f1f3f7"/>` +
      (r.v == null ? '' : `<rect x="${label}" y="${y}" width="${bw}" height="${rh}" rx="2" fill="${r.color || scCol(r.v)}" ${r.soft ? 'opacity=".6"' : ''}/>`) +
      `<text x="${w}" y="${y + rh / 2 + fs * 0.36}" font-size="${fs}" text-anchor="end" fill="#1c2230" ${r.bold ? 'font-weight="700"' : ''}>${r.v == null ? '-' : r.v.toFixed(2)}</text>`;
  });
  return `<svg viewBox="0 0 ${w} ${H}" width="100%" role="img">${g}</svg>`;
}

// 그룹별 점수 행: 종합(굵게) → 디자인 → 가격
const scoreRows = groups => groups.flatMap(g => [
  { label: g.name, v: compOf(g.rs), bold: true, h: 17, fs: 11.5, color: g.color },
  { label: '디자인', v: dAvg(g.rs), h: 9, fs: 9, soft: true, indent: 8, gap: 2, color: C.steel },
  { label: '가격', v: pAvg(g.rs), h: 9, fs: 9, soft: true, indent: 8, gap: 12, color: C.steel },
]);
// 4분면 분류 (종합점수 3.0 / 판매율 복종 중앙값)
const QDEF = [
  { k: 'HH', h: '디자인 ↑ · 가격 ↑', col: C.good },
  { k: 'HL', h: '디자인 ↑ · 가격 ↓', col: C.brass },
  { k: 'LH', h: '디자인 ↓ · 가격 ↑', col: C.steel },
  { k: 'LL', h: '디자인 ↓ · 가격 ↓', col: C.low },
];
// 4분면: 가로 = 디자인 점수, 세로 = 가격 점수 (기준 3.0). 키 첫 글자 = 디자인, 둘째 글자 = 가격
// 기준점은 카테고리별로 실제 평가된 상품의 중앙값 (응답이 모일수록 자동 조정)
const CUT = {};
for (const c of CATS) { const r = products.filter(p => p.cat === c && p.n > 0 && p.design != null && p.pscore != null); CUT[c] = { d: med(r.map(p => p.design)) ?? WARN, p: med(r.map(p => p.pscore)) ?? WARN }; }
const isH = (p, i) => (i === 0 ? p.design >= CUT[p.cat].d : p.pscore >= CUT[p.cat].p);
const qscore = (k, p) => { const d = p.design - CUT[p.cat].d, q = p.pscore - CUT[p.cat].p; return k === 'HH' ? d + q : k === 'HL' ? d - q : k === 'LH' ? -d + q : -d - q; };
function quadAll() {
  const q = { HH: [], HL: [], LH: [], LL: [] }; let rated = [];
  for (const c of CATS) { const r = quadrants(c); rated = rated.concat(r.rated); for (const k in q) q[k].push(...r.q[k]); }
  return { rated, q };
}
function quadrants(cat) {
  const all = products.filter(p => !cat || p.cat === cat);
  const rated = all.filter(p => p.n > 0 && p.design != null && p.pscore != null);
  const out = { rated, cut: cat ? CUT[cat] : null, q: {} };
  for (const d of QDEF) out.q[d.k] = rated.filter(p => (d.k[0] === 'H') === isH(p, 0) && (d.k[1] === 'H') === isH(p, 1)).sort((a, b) => qscore(d.k, b) - qscore(d.k, a));
  return out;
}
const KW_RULES = KW.rules.map(r => ({ ...r, res: r.patterns.map(x => new RegExp(x)) }));
function kwOf(p) {
  if (p._kw) return p._kw;
  const by = new Map();
  for (const c of p.comments) for (const r of KW_RULES) if (r.res.some(x => x.test(c.text))) { if (!by.has(r.label)) by.set(r.label, { label: r.label, tone: r.tone, stores: new Set() }); by.get(r.label).stores.add(c.store); }
  return (p._kw = [...by.values()].map(k => ({ label: k.label, tone: k.tone, count: k.stores.size })).sort((a, b) => b.count - a.count));
}
const chip = (k, n = true) => `<span class="kw ${k.tone}">${esc(k.label)}${n ? ` ${k.count}` : ''}</span>`;
function itemRow(p, showCat) {
  const kws = kwOf(p).filter(k => k.count >= KW.minCount).slice(0, 3);
  const third = kws.map(k => chip(k)).join('') + (p.notIn ? `<span class="kw st">미입점 ${p.notIn}</span>` : '') || (p.comments.length ? `<small>한줄평 ${p.comments.length}건</small>` : '');
  return `<div class="it" data-no="${esc(p.no)}"><div class="th">${thumb(p)}</div><div class="tx"><div class="nm"><b>${esc(p.name)}</b><i class="pv">${p.price ? n0(p.price) + '원' : ''}</i></div><span>${showCat ? `<u style="background:${catColor[p.cat]}"></u>` : ''}${esc(p.no)} · 디자인 <em class="${heat(p.design)}">${p.design.toFixed(1)}</em> · 가격 <em class="${heat(p.pscore)}">${p.pscore.toFixed(1)}</em> · 판매율 ${pct(p.rate)}</span>${third ? `<div class="kws">${third}</div>` : ''}</div></div>`;
}
function quadBox(d, list, n, showCat, total) {
  return `<div class="qb"><div class="qh" style="border-color:${d.col}"><b style="color:${d.col}">${d.h}</b><span>${total}개 상품</span></div>${list.slice(0, n).map(p => itemRow(p, showCat)).join('') || '<div class="empty">해당 상품 없음</div>'}</div>`;
}
function scatter(qd, w = 330, h = 190) {
  const pts = qd.rated, pad = { l: 34, r: 8, t: 8, b: 26 }, cu = qd.cut;
  const vs = pts.flatMap(p => [p.design, p.pscore]), lo = Math.max(1, Math.floor(Math.min(...vs, cu.d, cu.p) - 0.2)), hi = Math.min(5, Math.ceil(Math.max(...vs, cu.d, cu.p) + 0.2));
  const X = v => pad.l + ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (w - pad.l - pad.r), Y = v => h - pad.b - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (h - pad.t - pad.b);
  const x3 = X(cu.d), y3 = Y(cu.p);
  let g = `<rect x="${pad.l}" y="${pad.t}" width="${x3 - pad.l}" height="${y3 - pad.t}" fill="${C.steel}" opacity=".12"/><rect x="${x3}" y="${pad.t}" width="${w - pad.r - x3}" height="${y3 - pad.t}" fill="${C.good}" opacity=".10"/><rect x="${pad.l}" y="${y3}" width="${x3 - pad.l}" height="${h - pad.b - y3}" fill="${C.low}" opacity=".10"/><rect x="${x3}" y="${y3}" width="${w - pad.r - x3}" height="${h - pad.b - y3}" fill="${C.brass}" opacity=".10"/>`;
  g += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${h - pad.b}" y2="${h - pad.b}" stroke="#aab0bd"/><line x1="${pad.l}" x2="${pad.l}" y1="${pad.t}" y2="${h - pad.b}" stroke="#aab0bd"/><line x1="${x3}" x2="${x3}" y1="${pad.t}" y2="${h - pad.b}" stroke="#7b8190" stroke-dasharray="3 3"/><line x1="${pad.l}" x2="${w - pad.r}" y1="${y3}" y2="${y3}" stroke="#7b8190" stroke-dasharray="3 3"/>`;
  for (let v = lo; v <= hi; v++) g += `<text x="${X(v)}" y="${h - pad.b + 11}" font-size="8.5" text-anchor="middle" fill="#6b7385">${v}</text><text x="${pad.l - 5}" y="${Y(v) + 3}" font-size="8.5" text-anchor="end" fill="#6b7385">${v}</text>`;
  g += `<text x="${(pad.l + w - pad.r) / 2}" y="${h - 3}" font-size="9" text-anchor="middle" fill="#6b7385">디자인 점수 (기준 ${cu.d.toFixed(2)} · 가격 기준 ${cu.p.toFixed(2)})</text><text x="${pad.l + 3}" y="${pad.t + 10}" font-size="8.5" fill="#5f6b80">디자인 ↓ 가격 ↑</text><text x="${w - pad.r - 3}" y="${pad.t + 10}" font-size="8.5" fill="${C.good}" text-anchor="end">디자인 ↑ 가격 ↑</text><text x="${pad.l + 3}" y="${h - pad.b - 4}" font-size="8.5" fill="${C.low}">디자인 ↓ 가격 ↓</text><text x="${w - pad.r - 3}" y="${h - pad.b - 4}" font-size="8.5" fill="${C.brass}" text-anchor="end">디자인 ↑ 가격 ↓</text>`;
  for (const p of pts) {
    const d = QDEF.find(q => (q.k[0] === 'H') === isH(p, 0) && (q.k[1] === 'H') === isH(p, 1));
    g += `<circle cx="${X(p.design).toFixed(1)}" cy="${Y(p.pscore).toFixed(1)}" r="3.6" fill="${d.col}" fill-opacity=".85" stroke="#fff" stroke-width="1.2"/>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img">${g}</svg>`;
}
const kpi = (v, l, s = '', c = '') => `<div class="kp"><small>${l}</small><b class="${c}">${v}</b>${s ? `<em>${s}</em>` : ''}</div>`;
const mast = (eyebrow, title, meta) => `<div class="mast"><div><span>${eyebrow}</span><h1>${title}</h1></div><div class="meta">${meta}</div></div>`;
const dash = (inner, cls = '') => mainPages.push(`<section class="pg dash ${cls}">${inner}</section>`);

// ---- P1 요약
{
  const ov = avg(S.map(r => num(r['전체만족도']))), allComp = compOf(PR);
  const flagged = products.filter(p => p.n > 0 && p.comp != null && p.comp < LOW).length;
  const erp = Object.fromEntries(CATS.map(c => [c, erpCat(c)]));
  const catRows = scoreRows(CATS.map(c => ({ name: c, rs: respByCat(c), color: catColor[c] })));
  const cc = ch => CATS.map(c => compOf(PR.filter(r => r['복종'] === c && channelOf(r['매장명']) === ch)));
  const hm = `<div class="hm"><span></span>${CATS.map(c => `<span class="hd">${c}</span>`).join('')}${CHANNELS.map(ch => `<span class="rl">${chLabel(ch)}</span>${cc(ch).map(v => cell(v)).join('')}`).join('')}</div>`;
  const seasonBars = [['전체 만족도', '전체만족도'], ['상품 구성', '상품구성'], ['물량·입고', '물량·입고'], ['고객 반응', '고객반응']].map(([l, k]) => ({ label: l, v: avg(S.map(r => num(r[k]))) }));
  const mxIn = Math.max(1, ...CATS.map(c => erp[c] ? Math.max(erp[c].inb, erp[c].pInb) : 0));
  const salesRows = CATS.map(c => { const e = erp[c]; if (!e) return ''; return `<div class="sr"><span><u style="background:${catColor[c]}"></u>${c}</span><div class="bar2"><i style="width:${(e.inb / mxIn) * 100}%;background:${C.steel}"></i><i style="width:${(e.sale / mxIn) * 100}%;background:${C.navy}"></i></div><em>${n0(e.sale)} / ${n0(e.inb)}<b>${pct(e.rate)}</b><span class="py">전년 ${pct(e.pRate)}</span></em></div>`; }).join('') + `<div class="note" style="margin-top:1mm"><i class="dt" style="background:#8fa3bf;margin-left:0"></i>입고 <i class="dt" style="background:#1F3A5C"></i>판매 · 판매 시스템 기준, 카테고리 전체</div>`;
  const qa = quadAll(), qn = QDEF.map(d => `<div class="qn" style="border-color:${d.col}"><b style="color:${d.col}">${qa.q[d.k].length}</b><span>${d.h}</span></div>`).join('');
  const lowCat = CATS.map(c => [c, pAvg(respByCat(c))]).filter(x => x[1] != null).sort((a, b) => a[1] - b[1])[0];
  const topCat = CATS.map(c => [c, compOf(respByCat(c))]).filter(x => x[1] != null).sort((a, b) => b[1] - a[1])[0];
  const lowSeason = seasonBars.filter(x => x.v != null).sort((a, b) => a.v - b.v)[0];
  const over = CATS.flatMap(c => PSUBS[c]).filter(sb => { const st = priceStats(products.filter(p => p.sub === sb)), rs = PC.filter(r => r['세부복종'] === sb), hi = med(rs.map(r => num(r['적정상한']))); return st.wi != null && hi != null && st.wi > hi; });
  const pts = [
    topCat && `<div style="border-color:${C.navy}"><b>${topCat[0]}</b> 종합점수가 가장 높음 (${topCat[1].toFixed(2)})</div>`,
    lowCat && `<div style="border-color:${C.low}"><b>${lowCat[0]}</b> 가격 점수가 가장 낮음 (${lowCat[1].toFixed(2)})</div>`,
    lowSeason && `<div style="border-color:${C.warn}">시즌 전반 중 <b>${lowSeason.label}</b> 점수가 가장 낮음 (${lowSeason.v.toFixed(1)})</div>`,
    `<div style="border-color:${C.brass}">입고 가중 판매가가 적정 상한을 넘는 세부 복종 <b>${over.length}개</b>${over.length ? ' · ' + over.slice(0, 3).join(', ') + (over.length > 3 ? ' 외' : '') : ''}</div>`,
    `<div style="border-color:${C.good}">디자인·가격 모두 높은 상품 <b>${qa.q.HH.length}개</b> · 모두 낮은 상품 <b>${qa.q.LL.length}개</b></div>`,
  ].filter(Boolean).join('');
  const subm = CHANNELS.map(ch => { const all = stores.filter(x => x.type === ch).length, dn = stores.filter(x => x.type === ch && S.some(r => r['매장명'] === x.name)).length; return `<span>${chLabel(ch)} <b>${dn}/${all}</b></span>`; }).join('');
  dash(`${mast(`KANGOL · ${SEASON} STORE VOICE`, '매장 반응도 조사 · 요약', `응답 ${nowK} (KST) · 판매 ${asOf} 기준 · 출고 상품 ${products.length}개<br>종합점수 = 디자인 60% + 가격 40%<div class="subm">제출 현황 ${subm}</div>`)}
  <div class="kpis">${kpi(`${storeCount}<i> / ${stores.length}</i>`, '제출 매장', pct(storeCount / stores.length))}${kpi(ov == null ? '-' : ov.toFixed(1), '시즌 만족도', '전년 25AW = 3.0', heat(ov))}${kpi(allComp == null ? '-' : allComp.toFixed(2), '종합점수', '5점 만점', heat(allComp))}${kpi(flagged, '점검 필요 상품', `종합 ${LOW.toFixed(1)} 미만`, flagged ? 'hl' : '')}${kpi(n0(PR.length), '상품 평가 건수', `${new Set(PR.map(r => r['품번'])).size}개 상품`)}</div>
  <div class="g6">
   <div class="bx"><h3>카테고리별 점수</h3>${hbars(catRows, { w: 330 })}</div>
   <div class="bx"><h3>채널 × 카테고리 종합점수</h3>${hm}<div class="note" style="margin-top:2mm">백화점 · 아울렛 · 복합쇼핑몰 구분</div></div>
   <div class="bx"><h3>핵심 포인트</h3><div class="ins">${pts}</div></div>
   <div class="bx"><h3>카테고리별 입고 · 판매</h3>${salesRows}</div>
   <div class="bx"><h3>시즌 전반 (전년 3.0 기준)</h3>${hbars(seasonBars, { rowH: 12, gap: 6, label: 66 })}</div>
   <div class="bx"><h3>상품 4분면 (전 카테고리)</h3><div class="qns">${qn}</div><div class="note" style="margin-top:2mm">기준: 카테고리별 디자인·가격 점수 중앙값</div></div>
  </div><div class="note">점수 기준: ${LOW.toFixed(1)} 미만 <i class="sw hl"></i> · ${WARN.toFixed(1)} 미만 <i class="sw hw"></i> · 시즌 전반은 전년(25AW)을 3점 기준으로 평가</div>`, 'p1');
}

// ---- P2 시즌 전반 · 매장형태
const seasonTpl = [];
const SBLOCKS = [{ id: 'good', title: '잘 된 점', fields: ['잘된점'], tone: 'pos' }, { id: 'bad', title: '아쉬운 점 · 개선 요청', fields: ['아쉬운점'], tone: 'neg' }, { id: 'etc', title: '기타 · 경쟁환경 의견', fields: ['기타의견', '경쟁환경의견'], tone: 'neu' }];
function hl(text, res) { let t = esc(text); for (const re of res) t = t.replace(new RegExp(re.source, 'g'), m => `<mark>${m}</mark>`); return t; }
function seasonBlock(b) {
  const texts = S.map(r => ({ store: r['매장명'], ch: channelOf(r['매장명']), text: b.fields.map(f => clean(r[f]).trim()).filter(Boolean).join('\n') })).filter(x => x.text);
  const rules = (KW.season[b.id] || []).map(r => ({ ...r, res: r.patterns.map(p => new RegExp(p)) }));
  const themes = rules.map(r => ({ ...r, hits: texts.filter(t => r.res.some(re => re.test(t.text))) })).filter(t => t.hits.length).sort((a, c) => c.hits.length - a.hits.length);
  const row = x => `<tr><td class="nw">${esc(x.store)}</td><td class="nw">${chLabel(x.ch)}</td><td>${x.html}</td></tr>`;
  const tbl = rows => `<table class="bt"><thead><tr><th>매장</th><th>채널</th><th>의견</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  themes.forEach((t, i) => seasonTpl.push(`<template id="s-${b.id}-${i}"><div class="dd"><div class="dcat">${b.title}</div><h2>${esc(t.label)}</h2><div class="dm"><span class="tag g">${t.hits.length}개 매장 언급</span><span class="tag">전체 응답 ${S.length}개 매장 중 ${Math.round((t.hits.length / S.length) * 100)}%</span></div><p class="dsay">${esc(t.desc)}</p><div class="dbox">${tbl(t.hits.map(x => row({ ...x, html: hl(x.text, t.res).replace(/\n/g, '<br>') })))}</div></div></template>`));
  seasonTpl.push(`<template id="s-${b.id}-all"><div class="dd"><div class="dcat">${b.title}</div><h2>매장별 의견 전체 (${texts.length}개 매장)</h2><div class="dbox">${tbl(texts.slice().sort((a, c) => CHANNELS.indexOf(a.ch) - CHANNELS.indexOf(c.ch) || a.store.localeCompare(c.store, 'ko')).map(x => row({ ...x, html: esc(x.text).replace(/\n/g, '<br>') })))}</div></div></template>`);
  const top = themes.slice(0, b.id === 'etc' ? 4 : 5), mx = Math.max(1, ...top.map(t => t.hits.length));
  const head = top.length ? `<p class="sbsum">${top.slice(0, 3).map(t => `<b>${esc(t.label)}</b>(${t.hits.length}곳)`).join(', ')} 순으로 많이 언급됐습니다.</p>` : '<p class="sbsum mut">아직 정리할 의견이 없습니다.</p>';
  return `<div class="sbk"><h3 class="sbh"><span>${b.title} <span class="mut">${texts.length}개 매장 작성</span></span>${texts.length ? `<span class="sall" data-sop="${b.id}-all">전체 의견 보기 ›</span>` : ''}</h3>${head}${top.map((t, i) => `<div class="sth" data-sop="${b.id}-${i}"><span class="sl">${esc(t.label)}</span><div class="bar ${b.tone}"><i style="width:${(t.hits.length / mx) * 100}%"></i></div><b>${t.hits.length}곳</b><small>${esc(t.desc)}</small></div>`).join('')}</div>`;
}
{
  const items = [['전체', '전체만족도'], ['구성', '상품구성'], ['입고', '물량·입고'], ['고객', '고객반응']];
  const cols = [['전체', null], ...CHANNELS.map(ch => [chLabel(ch), ch])];
  const val = (col, k) => avg(S.filter(r => !col || channelOf(r['매장명']) === col).map(r => num(r[k])));
  const grid = `<div class="hm c5"><span></span>${cols.map(c => `<span class="hd">${c[0]}</span>`).join('')}${items.map(([l, k]) => `<span class="rl">${l}</span>${cols.map(c => cell(val(c[1], k))).join('')}`).join('')}</div>`;
  const rows = scoreRows(CHANNELS.map(ch => ({ name: `${chLabel(ch)} (${new Set(S.filter(r => channelOf(r['매장명']) === ch).map(r => r['매장명'])).size})`, rs: PR.filter(r => channelOf(r['매장명']) === ch), color: C.navy })));
  dash(`${mast(`KANGOL · ${SEASON} STORE VOICE`, '시즌 전반 · 매장형태별 반응', `응답 ${storeCount}개 매장<span class="so"><br>주제를 클릭하면 매장별 의견 상세가 열립니다</span>`)}
  <div class="g2">
   <div class="bx"><h3>시즌 전반 평가 (전년 25AW = 3.0)</h3>${grid}<h3 style="margin-top:5mm">매장형태별 점수 (매장 수)</h3>${hbars(rows, { w: 380 })}</div>
   <div class="bx sbx">${SBLOCKS.map(seasonBlock).join('')}</div>
  </div>`, 'p2');
}

// ---- P3~5 카테고리 페이지
for (const c of CATS) {
  const list = products.filter(p => p.cat === c), rs = respByCat(c), qd = quadrants(c), e = erpCat(c);
  const subs = [...new Set(list.map(p => p.sub))].map(sb => ({ label: `${sb} (${list.filter(p => p.sub === sb).length})`, v: compOf(rs.filter(r => r['세부복종'] === sb)) })).sort((x, y) => (y.v ?? -1) - (x.v ?? -1)).slice(0, 9);
  const py = (cur, prev, f, delta = true) => (prev == null ? '' : `전년 ${f(prev)}${delta && cur != null && prev ? ` (${cur >= prev ? '▲' : '▼'}${Math.abs(Math.round(((cur - prev) / prev) * 100))}%)` : ''}`);
  const kp = [
    kpi(list.length, '출고 상품', `평가 ${new Set(rs.map(r => r['품번'])).size}개`),
    kpi(compOf(rs) == null ? '-' : compOf(rs).toFixed(2), '종합점수', '디자인 60 · 가격 40', heat(compOf(rs))),
    kpi(f2(dAvg(rs)), '디자인', '', heat(dAvg(rs))), kpi(f2(pAvg(rs)), '가격', '', heat(pAvg(rs))),
    kpi(e ? n0(e.inb) : '-', '입고', e ? py(e.inb, e.pInb, n0) : ''), kpi(e ? n0(e.sale) : '-', '판매', e ? py(e.sale, e.pSale, n0) : ''),
    kpi(e ? pct(e.rate) : '-', '판매율', e ? py(e.rate, e.pRate, pct, false) : ''),
  ].join('');
  dash(`${mast(`<u style="background:${catColor[c]}"></u>${SEASON} · ${c}`, `${c} 반응도`, `4분면 기준: 디자인 ${CUT[c].d.toFixed(2)} · 가격 ${CUT[c].p.toFixed(2)} (카테고리 중앙값)<br>평가된 상품 ${qd.rated.length}개 분류 · 입고·판매는 카테고리 전체(판매 시스템 기준)<span class="so"><br>상품을 클릭하면 상세 정보와 매장 의견 종합이 열립니다</span>`)}
  <div class="kpis k7">${kp}</div>
  <div class="gc">
   <div class="lc"><div class="bx"><h3>세부 복종 종합점수 (상품 수)</h3>${hbars(subs, { rowH: 10.5, gap: 4.2, w: 340 })}</div><div class="bx"><h3>디자인(가로) × 가격(세로)</h3>${scatter(qd, 340, 175)}</div></div>
   <div class="rc">${QDEF.map(d => quadBox(d, qd.q[d.k], 4, false, qd.q[d.k].length)).join('')}</div>
  </div>`, 'pc');
}

// ---- P6 가격 적정선
{
  let rows = '';
  for (const c of CATS) {
    rows += `<div class="pgh"><u style="background:${catColor[c]}"></u>${c}</div>`;
    const info = PSUBS[c].map(sb => { const { ps, wi, ws } = priceStats(products.filter(p => p.cat === c && p.sub === sb)), rs2 = PC.filter(r => r['세부복종'] === sb); return { sb, ps, wi, ws, rs: rs2, lo: med(rs2.map(r => num(r['적정하한']))), hi: med(rs2.map(r => num(r['적정상한']))) }; });
    const vals = info.flatMap(i => [i.lo, i.hi, ...(i.ps.length ? [Math.min(...i.ps), Math.max(...i.ps)] : [])]).filter(v => v != null), lo0 = Math.floor((Math.min(...vals, 1e9) * 0.9) / 10000) * 10000, hi0 = Math.ceil((Math.max(...vals, 0) * 1.05) / 10000) * 10000;
    for (const i of info) {
      const X = v => 6 + ((v - lo0) / (hi0 - lo0 || 1)) * 288, pm_ = i.wi;
      let verdict = '<span class="vd v0">응답 없음</span>';
      if (pm_ != null && i.hi != null) verdict = pm_ > i.hi ? '<span class="vd vr">적정가 초과</span>' : pm_ < i.lo ? '<span class="vd vb">적정가 미만</span>' : '<span class="vd vg">적정 범위</span>';
      const svg = `<svg viewBox="0 0 300 14" width="100%"><rect x="6" y="6" width="288" height="2" fill="#e3e8f0"/>${i.lo != null ? `<rect x="${X(i.lo)}" y="1" width="${Math.max(3, X(i.hi) - X(i.lo))}" height="12" rx="2" fill="${C.navy}" opacity=".28"/>` : ''}${i.ps.length ? `<line x1="${X(Math.min(...i.ps))}" x2="${X(Math.max(...i.ps))}" y1="7" y2="7" stroke="#1c2230" stroke-width="1.6"/>${i.ws != null ? `<circle cx="${X(i.ws)}" cy="7" r="3.2" fill="${C.bag}" stroke="#fff" stroke-width=".8"/>` : ''}${i.wi != null ? `<circle cx="${X(i.wi)}" cy="7" r="3.2" fill="${C.navy2}" stroke="#fff" stroke-width=".8"/>` : ''}` : ''}</svg>`;
      const lvl = dist(i.rs.map(r => r['현재가수준']), ['낮은 편', '적정', '높은 편']), cmp = dist(i.rs.map(r => r['경쟁대비']), ['저렴', '비슷', '비쌈']), cm = i.rs.find(r => r['의견']);
      rows += `<div class="pr"><b>${i.sb}</b><div class="rg">${svg}</div><span class="rn">${i.lo != null ? `적정 ${n0(i.lo)}~${n0(i.hi)}` : '적정가 응답 없음'}<br>현재 ${i.ps.length ? `${n0(Math.min(...i.ps))}~${n0(Math.max(...i.ps))}` : '-'}<br><span class="wi">입고가중 ${n0(i.wi)}</span> · <span class="ws">판매가중 ${n0(i.ws)}</span></span>${verdict}<span class="ds">가격 수준 ${lvl}<br>경쟁 대비 ${cmp}</span><span class="cmx">${cm ? esc(clip(cm['의견'], 46)) : ''}</span></div>`;
    }
  }
  dash(`${mast(`KANGOL · ${SEASON} STORE VOICE`, '가격 적정선', '막대: 매장이 제시한 적정 가격대(중앙값) · 선: 현재 판매가 범위 · 적정 판정은 입고량 가중 중앙값 기준')}<div class="prs"><div class="note plg"><span class="lg wi">●</span> 입고량 가중 중앙값 (진한 남색) <span class="lg ws">●</span> 판매량 가중 중앙값 (주황) · 두 값 모두 상품 판매가를 입고량/판매량으로 가중해 구한 중앙값</div>${rows}</div>`, 'p6');
}

// ---- P7 경쟁브랜드 (클릭하면 매장 의견 상세)
const brandTpl = [];
function brandHtml(g, l) {
  const stores = [...new Set(l.map(r => r['매장명']))];
  const names = [...new Set(l.map(r => r['브랜드'].trim()))];
  const byCh = CHANNELS.map(ch => ({ ch, n: new Set(l.filter(r => channelOf(r['매장명']) === ch).map(r => r['매장명'])).size })).filter(x => x.n);
  const tally = k => { const m = new Map(); l.forEach(r => { const v = clean(r[k]).trim(); if (!v) return; if (!m.has(v)) m.set(v, new Set()); m.get(v).add(r['매장명']); }); return [...m.entries()].map(([v, st]) => ({ v, n: st.size })).sort((a, b) => b.n - a.n); };
  const box = (t, k) => `<div class="dbox"><h4>${t}</h4>${tally(k).map(x => `<div class="bl"><span>${esc(x.v)}</span><b>${x.n}곳</b></div>`).join('') || '<span class="mut">응답 없음</span>'}</div>`;
  const rows = l.slice().sort((a, b) => CHANNELS.indexOf(channelOf(a['매장명'])) - CHANNELS.indexOf(channelOf(b['매장명'])) || a['매장명'].localeCompare(b['매장명'], 'ko')).map(r => `<tr><td>${esc(r['매장명'])}</td><td>${chLabel(channelOf(r['매장명']))}</td><td>${esc(clean(r['가격대']))}</td><td>${esc(clean(r['강점']))}</td><td>${esc(clean(r['프로모션·동향']))}</td><td>${esc(clean(r['고객반응']))}</td></tr>`).join('');
  return `<div class="dd"><div class="dcat"><u style="background:${C.navy}"></u>${g} 경쟁브랜드</div><h2>${esc(bname(l))}</h2>
  <div class="dm"><span class="tag g">${stores.length}개 매장 언급</span>${byCh.map(x => `<span class="tag">${chLabel(x.ch)} ${x.n}</span>`).join('')}${names.length > 1 ? `<span class="tag c">표기: ${names.map(esc).join(' / ')}</span>` : ''}</div>
  <div class="bgrid">${box('가격대', '가격대')}${box('강점', '강점')}${box('프로모션·동향', '프로모션·동향')}${box('고객 반응', '고객반응')}</div>
  <div class="dbox" style="margin-top:12px"><h4>매장별 의견 (${l.length}건)</h4><table class="bt"><thead><tr><th>매장</th><th>채널</th><th>가격대</th><th>강점</th><th>프로모션·동향</th><th>고객 반응</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
{
  const col = g => {
    const rs = CP.filter(r => r['복종'] === g && r['브랜드']), by = {};
    rs.forEach(r => (by[bkey(r['브랜드'])] ||= []).push(r));
    const all = Object.values(by).map(l => ({ l, n: new Set(l.map(r => r['매장명'])).size })).sort((a, b) => b.n - a.n || bname(a.l).localeCompare(bname(b.l), 'ko'));
    all.forEach((x, i) => { x.id = (g === '의류' ? 'a' : 'b') + i; brandTpl.push(`<template id="b-${x.id}">${brandHtml(g, x.l)}</template>`); });
    const lid = g === '의류' ? 'a' : 'b';
    const lrows = all.map((x, i) => { const j = k => [...new Set(x.l.map(r => clean(r[k])).filter(Boolean))].map(esc).join(' / '); const ch = CHANNELS.map(c => { const n = new Set(x.l.filter(r => channelOf(r['매장명']) === c).map(r => r['매장명'])).size; return n ? chLabel(c) + ' ' + n : ''; }).filter(Boolean).join(' · '); const nm = [...new Set(x.l.map(r => r['브랜드'].trim()))]; return '<tr data-brand="' + x.id + '"><td class="n">' + (i + 1) + '</td><td class="nw"><b>' + esc(bname(x.l)) + '</b>' + (nm.length > 1 ? '<br><small class="mut">표기: ' + nm.map(esc).join(' / ') + '</small>' : '') + '</td><td class="n">' + x.n + '</td><td class="nw">' + ch + '</td><td>' + (j('가격대') || '-') + '</td><td>' + (j('강점') || '-') + '</td></tr>'; }).join('');
    brandTpl.push('<template id="l-' + lid + '"><div class="dd"><div class="dcat"><u style="background:' + C.navy + '"></u>' + g + ' 경쟁브랜드 전체</div><h2>언급된 브랜드 ' + all.length + '개</h2><div class="dcat">언급 매장 수 순 · 브랜드를 누르면 매장별 의견 상세</div><table class="bt gl" style="margin-top:10px"><thead><tr><th class="n">순위</th><th>브랜드</th><th class="n">언급 매장</th><th>채널</th><th>가격대</th><th>강점</th></tr></thead><tbody>' + lrows + '</tbody></table></div></template>');
    const top = all.slice(0, 5), rest = all.slice(5, 17), mx = Math.max(1, ...top.map(x => x.n));
    return `<div class="bx"><h3>${g} 대표 경쟁브랜드 <span class="mut">언급 매장 수 순</span><span class="so mut"> · 클릭하면 매장 의견 상세</span></h3>` + (top.map(({ l, n, id }, i) => { const j = k => [...new Set(l.map(r => clean(r[k])).filter(Boolean))].map(esc).join(' / '); return `<div class="cp" data-brand="${id}"><div class="cpt"><span class="rk">${i + 1}</span><b>${esc(bname(l))}</b><div class="bar"><i style="width:${(n / mx) * 100}%"></i></div><em>${n}개 매장</em></div><dl><dt>가격대</dt><dd>${j('가격대') || '-'}</dd><dt>강점</dt><dd>${j('강점') || '-'}</dd><dt>동향</dt><dd>${j('프로모션·동향') || '-'}</dd><dt>고객 반응</dt><dd>${j('고객반응') || '-'}</dd></dl></div>`; }).join('') || '<div class="empty">응답 없음</div>') + (rest.length ? `<div class="rest"><small>그 외 언급 브랜드 ${all.length - 5}개${all.length > 17 ? ' (상위 12개 표시)' : ''}</small> <span class="kw all" data-bl="${lid}" style="background:#1F3A5C;color:#fff">전체 ${all.length}개 브랜드 보기 ▸</span><div class="kws">${rest.map(x => `<span class="kw neu" data-brand="${x.id}">${esc(bname(x.l))} ${x.n}</span>`).join('')}</div></div>` : '') + '</div>';
  };
  dash(`${mast(`KANGOL · ${SEASON} STORE VOICE`, '경쟁브랜드 현황', '매장이 꼽은 대표 경쟁브랜드 (의류·가방 각 2곳)<span class="so"><br>브랜드를 클릭하면 매장별 의견을 자세히 볼 수 있습니다</span>')}<div class="g2">${col('의류')}${col('가방')}</div>`, 'p7');
}

// ---- P8 상품 4분면 (전 카테고리)
{
  const merged = { HH: [], HL: [], LH: [], LL: [] };
  for (const c of CATS) { const q = quadrants(c); for (const k in merged) merged[k].push(...q.q[k]); }
  for (const k in merged) merged[k].sort((a, b) => qscore(k, b) - qscore(k, a));
  const tot = Object.values(merged).reduce((a, l) => a + l.length, 0);
  dash(`${mast(`KANGOL · ${SEASON} STORE VOICE`, '상품 4분면 · 디자인 × 가격', `기준: 카테고리별 디자인·가격 점수 중앙값<br>전체 ${tot}개 평가 상품`)}
  <div class="g4">${QDEF.map(d => quadBox(d, merged[d.k], 6, true, merged[d.k].length)).join('')}</div>
  <div class="note"><u class="dt" style="background:${C.bag}"></u>가방 <u class="dt" style="background:${C.cloth}"></u>의류 <u class="dt" style="background:${C.hat}"></u>모자 · 각 칸은 해당 구간에서 점수 차이가 큰 순서 · 상품별 상세와 매장별 의견은 부록에 있습니다</div>`, 'p8');
}

// ---- P9 전 상품 리스트 (8페이지 이후, 행을 클릭하면 상세)
{
  const dsc = (a, b) => (b.comp ?? -1) - (a.comp ?? -1);
  let rowIdx = 0;
  let body = `<div class="so lsearch"><input id="pq" type="search" placeholder="상품명·품번 검색"><label><input type="checkbox" id="pgrp" checked> 카테고리별로 묶어서 보기</label><button type="button" id="psort0">기본 정렬로</button><span class="mut">열 제목을 클릭하면 오름차순/내림차순으로 정렬됩니다</span></div><table class="allp"><thead><tr><th></th><th data-sort>품번</th><th data-sort>상품명</th><th data-sort>세부 복종</th><th class="n" data-sort>판매가</th><th data-sort>등급</th><th class="n" data-sort>입고</th><th class="n" data-sort>판매</th><th class="n" data-sort>판매율</th><th class="n" data-sort>응답</th><th class="n" data-sort>디자인</th><th class="n" data-sort>가격</th><th class="n" data-sort>종합</th><th class="n" data-sort>미입점</th></tr></thead>`;
  for (const c of CATS) {
    const list = products.filter(p => p.cat === c).sort((a, b) => a.sub.localeCompare(b.sub, 'ko') || dsc(a, b));
    body += `<tbody data-cat="${c}"><tr class="grp"><td colspan="14"><u class="dt" style="background:${catColor[c]};margin:0 1.4mm 0 0"></u>${c} · ${list.length}개</td></tr>`;
    for (const p of list) body += `<tr data-no="${esc(p.no)}" data-cat="${c}" data-i="${rowIdx++}" class="${p.n ? '' : 'none'}"><td class="im">${p.img ? `<img src="${imgSrc(p)}" alt="">` : ''}</td><td>${esc(p.no)}</td><td><b>${esc(p.name)}</b></td><td>${esc(p.sub)}</td><td class="n">${n0(p.price)}</td><td>${esc(p.grade || '')}</td><td class="n">${n0(p.inbound)}</td><td class="n">${n0(p.sales)}</td><td class="n">${pct(p.rate)}</td><td class="n">${p.n || '-'}</td>${sc(p.design)}${sc(p.pscore)}${sc(p.comp)}<td class="n">${p.notIn || ''}</td></tr>`;
    body += '</tbody>';
  }
  page('전 상품 리스트', `<div class="sub">출고된 ${SEASON} 상품 ${products.length}개 · 카테고리 → 세부 복종 순, 같은 복종 안에서는 종합점수 높은 순 · 점수는 ${LOW.toFixed(1)} 미만 빨강, ${WARN.toFixed(1)} 미만 주황<span class="so"> · 행을 클릭하면 상품 상세가 열립니다</span></div>${body}</table>`, 'flow', 'main');
}

// ---- 상품 상세 (HTML 전용, 상품 클릭 시 팝업)
const dist5 = (rows, key) => { const a = [0, 0, 0, 0, 0]; rows.forEach(r => { const v = num(r[key]); if (v >= 1 && v <= 5) a[Math.round(v) - 1]++; }); return a; };
const distBars = a => { const mx = Math.max(1, ...a); return a.map((n, i) => `<div class="db"><span>${i + 1}점</span><div><i class="s${i + 1}" style="width:${(n / mx) * 100}%"></i></div><b>${n}</b></div>`).join(''); };
const QSAY = { HH: '디자인·가격 모두 카테고리 평균 이상', HL: '디자인은 평균 이상이나 가격 점수가 평균보다 낮음', LH: '가격은 평균 이상이나 디자인 점수가 평균보다 낮음', LL: '디자인·가격 모두 카테고리 평균 미만' };
function detailHtml(p) {
  const rows = p.rows || [], valid = rows.filter(r => num(r['디자인']) != null || num(r['가격']) != null);
  const catRs = respByCat(p.cat), cd = dAvg(catRs), cpv = pAvg(catRs), medR = med(products.filter(x => x.cat === p.cat).map(x => x.rate));
  const dl = (v, b) => (v == null || b == null ? '' : `<em class="${v - b >= 0 ? 'up' : 'dn'}">카테고리 평균 대비 ${v - b >= 0 ? '+' : ''}${(v - b).toFixed(2)}</em>`);
  const quad = p.design != null && p.pscore != null ? QDEF.find(q => (q.k[0] === 'H') === isH(p, 0) && (q.k[1] === 'H') === isH(p, 1)) : null;
  const kws = kwOf(p), stores = new Set(valid.map(r => r['매장명'])).size;
  const topK = kws.filter(k => k.count >= (stores >= 5 ? KW.minCount : 1)).slice(0, 4);
  const say = !stores ? '아직 평가 응답이 없습니다.' : `${stores}개 매장이 평가했습니다.${quad ? ' ' + QSAY[quad.k] + '입니다.' : ''}${topK.length ? ' 주요 의견은 ' + topK.map(k => `<b>${esc(k.label)}</b>(${k.count}곳)`).join(', ') + '입니다.' : ''}${p.notIn ? ` ${p.notIn}개 매장은 미입점·미입고로 응답했습니다.` : ''}`;
  const ch = CHANNELS.map(c => { const rr = valid.filter(r => channelOf(r['매장명']) === c); return `<tr><td>${chLabel(c)}</td><td class="n">${new Set(rr.map(r => r['매장명'])).size || '-'}</td><td class="n">${cell(dAvg(rr), 2)}</td><td class="n">${cell(pAvg(rr), 2)}</td></tr>`; }).join('');
  const cm = p.comments.slice(0, 12).map(c => `<li><b>${esc(c.store)}</b> ${esc(clean(c.text))}</li>`).join('');
  return `<div class="dd">
  <div class="dh"><div class="dimg">${p.img ? `<img src="${imgSrc(p)}" alt="">` : '<span>이미지 준비중</span>'}</div>
   <div class="di"><div class="dcat"><u style="background:${catColor[p.cat]}"></u>${p.cat} · ${esc(p.sub)}</div><h2>${esc(p.name)}</h2>
    <div class="dm"><span class="tag">${p.no}</span><span class="tag">판매가 ${p.price ? n0(p.price) + '원' : '-'}</span>${p.grade ? `<span class="tag g">${esc(p.grade)}등급</span>` : ''}${p.colors.map(c => `<span class="tag c">${esc(c)}</span>`).join('')}</div>
    ${quad ? `<div class="dq" style="border-color:${quad.col}"><b style="color:${quad.col}">${quad.h}</b><span>${QSAY[quad.k]}</span></div>` : ''}
    <div class="dsale"><div><small>입고</small><b>${n0(p.inbound)}</b></div><div><small>판매</small><b>${n0(p.sales)}</b></div><div><small>판매율</small><b>${pct(p.rate)}</b><em>${medR != null ? '카테고리 중앙값 ' + pct(medR) : ''}</em></div></div>
   </div></div>
  <div class="dcards"><div class="dc"><small>종합점수</small><b class="${heat(p.comp)}">${p.comp == null ? '-' : p.comp.toFixed(2)}</b><em>디자인 60 · 가격 40</em></div><div class="dc"><small>디자인</small><b class="${heat(p.design)}">${p.design == null ? '-' : p.design.toFixed(2)}</b>${dl(p.design, cd)}</div><div class="dc"><small>가격</small><b class="${heat(p.pscore)}">${p.pscore == null ? '-' : p.pscore.toFixed(2)}</b>${dl(p.pscore, cpv)}</div><div class="dc"><small>평가 매장</small><b>${stores}</b><em>미입점·미입고 ${p.notIn}곳</em></div></div>
  <div class="dgrid">
   <div class="dbox"><h4>점수 분포</h4><div class="dd2"><div><small>디자인</small>${distBars(dist5(valid, '디자인'))}</div><div><small>가격</small>${distBars(dist5(valid, '가격'))}</div></div><h4 style="margin-top:12px">매장형태별</h4><table><thead><tr><th>구분</th><th class="n">매장</th><th class="n">디자인</th><th class="n">가격</th></tr></thead><tbody>${ch}</tbody></table></div>
   <div class="dbox"><h4>매장 의견 종합</h4><p class="dsay">${say}</p><div class="dkw">${kws.map(k => chip(k)).join('') || '<span class="mut">반복 키워드 없음</span>'}${p.notIn ? `<span class="kw st">미입점·미입고 ${p.notIn}</span>` : ''}</div>${cm ? `<h4 style="margin-top:12px">매장 한줄평 (${p.comments.length}건)</h4><ul class="dcm">${cm}</ul>` : ''}</div>
  </div></div>`;
}
const detailTemplates = products.map(p => `<template id="d-${esc(p.no)}">${detailHtml(p)}</template>`).join('') + brandTpl.join('') + seasonTpl.join('');
const modalHtml = `<div class="modal" id="modal" hidden><div class="mp"><button class="mx" type="button" aria-label="닫기">×</button><div id="mbody"></div></div></div>${detailTemplates}<script>(function(){var m=document.getElementById('modal'),b=document.getElementById('mbody');function close(){m.hidden=true;document.body.style.overflow=''}document.addEventListener('click',function(e){var it=e.target.closest('[data-no],[data-brand],[data-bl],[data-sop]');if(it){var id=it.hasAttribute('data-no')?'d-'+it.getAttribute('data-no'):it.hasAttribute('data-brand')?'b-'+it.getAttribute('data-brand'):it.hasAttribute('data-bl')?'l-'+it.getAttribute('data-bl'):'s-'+it.getAttribute('data-sop');var t=document.getElementById(id);if(t){b.innerHTML=t.innerHTML;m.hidden=false;document.body.style.overflow='hidden';m.querySelector('.mp').scrollTop=0}return}if(e.target===m||e.target.closest('.mx'))close()});document.addEventListener('keydown',function(e){if(e.key==='Escape')close()});var tbl=document.querySelector('table.allp');if(tbl){var ths=[].slice.call(tbl.querySelectorAll('thead th')),bodies=[].slice.call(tbl.tBodies),st={col:-1,dir:1},grouped=true;function val(tr,i){var t=tr.cells[i].textContent.replace(/[,%\\s]/g,'');if(ths[i].className.indexOf('n')>=0){if(t===''||t==='-')return null;var n=parseFloat(t);return isNaN(n)?null:n}return tr.cells[i].textContent.trim()}function cmpf(i,d){return function(a,b){var x=val(a,i),y=val(b,i);if(x===null&&y===null)return 0;if(x===null)return 1;if(y===null)return -1;return(typeof x==='number'?x-y:x.localeCompare(y,'ko'))*d}}function apply(){var all=[];bodies.forEach(function(b){all=all.concat([].slice.call(b.querySelectorAll('tr[data-no]')))});all.sort(st.col<0?function(a,b){return a.getAttribute('data-i')-b.getAttribute('data-i')}:cmpf(st.col,st.dir));if(grouped){bodies.forEach(function(b){var c=b.getAttribute('data-cat');b.querySelector('tr.grp').hidden=false;all.forEach(function(r){if(r.getAttribute('data-cat')===c)b.appendChild(r)})})}else{bodies.forEach(function(b){b.querySelector('tr.grp').hidden=true});all.forEach(function(r){bodies[0].appendChild(r)})}ths.forEach(function(th,i){var si=th.querySelector('.si');if(!si&&th.hasAttribute('data-sort')){si=document.createElement('span');si.className='si';th.appendChild(si)}if(si)si.textContent=i===st.col?(st.dir>0?' ▲':' ▼'):''})}ths.forEach(function(th,i){if(th.hasAttribute('data-sort'))th.addEventListener('click',function(){if(st.col===i)st.dir=-st.dir;else{st.col=i;st.dir=th.className.indexOf('n')>=0?-1:1}apply()})});var g=document.getElementById('pgrp');if(g)g.addEventListener('change',function(){grouped=g.checked;apply()});var r0=document.getElementById('psort0');if(r0)r0.addEventListener('click',function(){st={col:-1,dir:1};grouped=true;if(g)g.checked=true;apply()})}var q=document.getElementById('pq');if(q)q.addEventListener('input',function(){var v=q.value.trim().toLowerCase();document.querySelectorAll('table.allp tbody tr[data-no]').forEach(function(tr){tr.hidden=!!v&&tr.textContent.toLowerCase().indexOf(v)<0})})})();<\/script>`;

/* ---------- HTML ---------- */
const css = `
:root{--ink:#1c2230;--mut:#6b7385;--line:#e6e8ec;--navy:#1F3A5C;--navy2:#16283F;--gold:#D9C68C;--brass:#8C6B1F;--mist:#e3e8f0;--bg:#F2F2F2;--lowbg:#f2dcd9;--lowfg:#8a2a22;--warnbg:#f4e8c8;--warnfg:#6b5010;--okbg:#e3e8f0;--okfg:#1F3A5C;--hibg:#cdd9ea;--hifg:#16283F}
*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:'Noto Sans KR','Noto Sans','Malgun Gothic',sans-serif;color:var(--ink);font-size:8.5pt;line-height:1.4;background:var(--bg)}
.pg{width:297mm;min-height:210mm;margin:8mm auto;padding:8mm 8mm 12mm;background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.15)}
.pg.dash{height:210mm;overflow:hidden;display:flex;flex-direction:column;gap:3.2mm}
h2{margin:0 0 3mm;font-size:14pt;color:var(--navy);border-bottom:1.5pt solid var(--navy);padding-bottom:2mm}
h3{margin:0 0 1.8mm;font-size:9.5pt;font-weight:700;color:var(--navy2)}
.mut{color:var(--mut);font-weight:400}.sub{color:var(--mut);margin:0 0 3mm}
.mast{background:var(--navy2);color:#fff;border-radius:2mm;padding:4mm 6mm;display:flex;justify-content:space-between;align-items:flex-end;gap:6mm}
.mast span{display:block;font-size:7.5pt;letter-spacing:.12em;color:var(--gold);font-weight:500}.mast h1{margin:1mm 0 0;font-size:17pt;font-weight:700;letter-spacing:-.01em}
.mast .meta{font-size:7.5pt;color:#c6d0df;text-align:right;line-height:1.5}.mast u{display:inline-block;width:2.4mm;height:2.4mm;border-radius:50%;margin-right:1.6mm;vertical-align:0}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:2.6mm}.kpis.k7{grid-template-columns:repeat(7,1fr)}
.kp{border:.5pt solid var(--line);border-radius:1.6mm;padding:2mm 3mm;background:#fff}.kp small{display:block;font-size:7.2pt;color:var(--mut)}.kp b{display:inline-block;font-size:16pt;font-weight:700;font-variant-numeric:tabular-nums;color:var(--navy2);line-height:1.2}.kp b i{font-style:normal;font-size:10pt;color:var(--mut);font-weight:400}.kp em{display:block;font-style:normal;font-size:6.9pt;color:var(--mut);line-height:1.3;white-space:nowrap}
.kp b.hl,.kp b.hw{padding:0 1.6mm;border-radius:1mm}
.g3{display:grid;grid-template-columns:1.1fr 1fr 1fr;gap:3.2mm;flex:1;min-height:0}.g6{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:3.2mm;flex:1;min-height:0}.g6 .bx{display:flex;flex-direction:column}.g2{display:grid;grid-template-columns:1fr 1fr;gap:3.2mm;flex:1;min-height:0}.g4{display:grid;grid-template-columns:1fr 1fr;gap:3mm;flex:1;min-height:0}
.bx{border:.5pt solid var(--line);border-radius:1.6mm;padding:3mm 3.5mm;min-width:0;overflow:hidden}
.note{font-size:7.5pt;color:var(--mut)}.sw{display:inline-block;width:2.6mm;height:2.6mm;border-radius:.6mm;vertical-align:-.4mm}.sw.hl{background:var(--lowbg)}.sw.hw{background:var(--warnbg)}
.hm{display:grid;grid-template-columns:16mm repeat(3,1fr);gap:1mm;font-size:8.5pt;text-align:center}.hm.c5{grid-template-columns:14mm repeat(4,1fr)}.hm .hd{color:var(--mut);font-size:7.5pt;padding:.6mm 0}.hm .rl{text-align:left;color:var(--mut);font-size:7.8pt;padding:1.6mm 0}
.cellv{display:block;padding:1.6mm 0;border-radius:1mm;font-variant-numeric:tabular-nums;font-weight:700}
.h0{background:#f1f3f7;color:#9aa0ab}.hl{background:var(--lowbg);color:var(--lowfg)}.hw{background:var(--warnbg);color:var(--warnfg)}.ho{background:var(--okbg);color:var(--okfg)}.hh{background:var(--hibg);color:var(--hifg)}
em.hl,em.hw,em.ho,em.hh,em.h0{font-style:normal;padding:0 1mm;border-radius:.8mm;font-weight:700}
.ins{display:grid;gap:2mm;font-size:8.2pt}.ins div{border-left:1mm solid var(--navy);padding:.4mm 0 .4mm 2.4mm}
.qns{display:grid;grid-template-columns:1fr 1fr;gap:2mm}.qn{border-left:1mm solid;padding:1mm 2.4mm;background:#f7f8fa;border-radius:0 1mm 1mm 0}.qn b{font-size:14pt;display:block;line-height:1.2}.qn span{font-size:7.5pt;color:var(--mut)}
.gc{display:grid;grid-template-columns:1fr 1.35fr;gap:3.2mm;flex:1;min-height:0}.lc{display:grid;grid-template-rows:auto 1fr;gap:3mm;min-height:0}.rc{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:3mm;min-height:0}
.qb{border:.5pt solid var(--line);border-radius:1.6mm;padding:2.4mm 3mm;overflow:hidden;min-width:0}.qh{border-left:1.2mm solid;padding-left:2mm;margin-bottom:1.6mm;line-height:1.25}.qh b{font-size:9.5pt;display:block}.qh span{font-size:7pt;color:var(--mut)}
.it{display:grid;grid-template-columns:9.5mm 1fr;gap:2mm;align-items:center;padding:.9mm 0;border-top:.5pt solid #f0f1f4}.th{width:9.5mm;height:11mm;border:.5pt solid var(--line);display:grid;place-items:center;overflow:hidden;background:#fff}.th img{width:100%;height:100%;object-fit:contain}.th i{font-size:6pt;color:#b0b5c0;font-style:normal}
.tx{min-width:0;display:grid}.tx b{font-size:8pt;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tx span{font-size:7pt;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tx small{font-size:7pt;color:#4a5263;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tx u{display:inline-block;width:1.8mm;height:1.8mm;border-radius:50%;margin-right:1mm}
.sr{display:grid;grid-template-columns:18mm 1fr 30mm;gap:2mm;align-items:center;margin-bottom:1.6mm;font-size:8pt}.sr span u{display:inline-block;width:2mm;height:2mm;border-radius:50%;margin-right:1.2mm}.bar2{position:relative;height:3mm;background:#f1f3f7;border-radius:1mm}.bar2 i{position:absolute;left:0;top:0;bottom:0;border-radius:1mm}.bar2 i+i{height:1.2mm;top:.9mm;opacity:1}.sr em .py{display:block;font-weight:400;font-size:6.8pt;color:var(--mut)}.subm{margin-top:1.4mm;font-size:7pt;color:#c6d0df}.subm span{margin-left:2.4mm}.subm b{color:#fff;font-weight:500}.sr em{font-style:normal;font-size:7pt;color:var(--mut);text-align:right;line-height:1.2}.sr em b{display:block;color:var(--navy2);font-size:8pt}
.nm{display:flex;align-items:baseline;gap:1.6mm;min-width:0}.nm b{flex:0 1 auto;min-width:0;display:block}.nm .pv{flex:none;font-style:normal;font-size:7.4pt;color:var(--navy);font-weight:500}
.kws{display:flex;flex-wrap:wrap;gap:.8mm 1mm;margin-top:.4mm}.kw{font-size:6.6pt;padding:.1mm 1.4mm;border-radius:2mm;white-space:nowrap;background:#eef1f6;color:#3b475c}.kw.pos{background:#e1ece6;color:#2c5f46}.kw.neg{background:#f2dcd9;color:#8a2a22}.kw.neu{background:#eef1f6;color:#3b475c}.kw.st{background:#f1f3f7;color:#7b8190;border:.4pt solid #d4d8e0}
.it{cursor:pointer}.it:hover{background:#f7f8fb}.so{display:inline}
.modal{position:fixed;inset:0;background:rgba(15,25,40,.55);display:grid;place-items:center;z-index:50;padding:16px}.modal[hidden]{display:none}
.mp{background:#fff;border-radius:10px;max-width:980px;width:100%;max-height:92vh;overflow:auto;padding:22px 26px;position:relative;font-size:13px;line-height:1.5}
.mx{position:absolute;top:10px;right:14px;border:0;background:none;font-size:26px;line-height:1;color:#6b7385;cursor:pointer}
.dd .dh{display:grid;grid-template-columns:220px 1fr;gap:20px}.dd .dimg{aspect-ratio:4/3;border:1px solid var(--line);border-radius:8px;display:grid;place-items:center;overflow:hidden;color:#9aa0ab}.dd .dimg img{width:100%;height:100%;object-fit:contain}
.dd h2{border:0;margin:2px 0 6px;font-size:20px;color:var(--navy2);padding:0}.dcat{font-size:12px;color:var(--mut)}.dcat u{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.dm{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}.tag{font-size:12px;padding:2px 10px;border-radius:99px;background:#eef1f6;color:var(--navy2);font-weight:500}.tag.g{background:var(--navy2);color:#fff}.tag.c{background:none;border:1px solid var(--line);color:var(--mut)}
.dq{border-left:4px solid;padding:3px 10px;margin-bottom:10px;background:#f7f8fa}.dq b{margin-right:8px}.dq span{color:var(--mut);font-size:12px}
.dsale{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.dsale div{background:#f7f8fa;border-radius:6px;padding:6px 10px}.dsale small{display:block;font-size:11px;color:var(--mut)}.dsale b{font-size:16px;font-variant-numeric:tabular-nums}.dsale em{display:block;font-style:normal;font-size:10.5px;color:var(--mut)}
.dcards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}.dc{border:1px solid var(--line);border-radius:8px;padding:8px 12px}.dc small{display:block;font-size:11px;color:var(--mut)}.dc b{font-size:24px;font-variant-numeric:tabular-nums;padding:0 6px;border-radius:4px;display:inline-block;margin:2px 0}.dc em{display:block;font-style:normal;font-size:11px;color:var(--mut)}.dc em.up{color:#2c5f46}.dc em.dn{color:#8a2a22}
.dgrid{display:grid;grid-template-columns:1fr 1.2fr;gap:14px}.dbox{border:1px solid var(--line);border-radius:8px;padding:12px 14px}.dbox h4{margin:0 0 6px;font-size:13px;color:var(--navy2)}
.dd2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.dd2 small{font-size:11px;color:var(--mut)}.db{display:grid;grid-template-columns:28px 1fr 20px;gap:6px;align-items:center;font-size:11px;margin:2px 0}.db div{height:8px;background:#f1f3f7;border-radius:3px}.db i{display:block;height:100%;background:var(--navy);border-radius:3px;opacity:.75}.db i.s1,.db i.s2{background:#b5524a}.db b{text-align:right;font-weight:500}
.dd table{font-size:12px}.dsay{margin:0 0 8px;font-size:13px}.dkw{display:flex;flex-wrap:wrap;gap:6px}.dd .kw{font-size:12px;padding:2px 10px}
.dcm{margin:0;padding:0;list-style:none;font-size:12px}.dcm li{padding:4px 0;border-top:1px solid #f0f1f4}.dcm b{color:var(--navy2);margin-right:6px}
@media (max-width:760px){.dd .dh,.dgrid{grid-template-columns:1fr}.dcards{grid-template-columns:1fr 1fr}}
.cp[data-brand],.kw[data-brand],.kw[data-bl],table.allp tr[data-no],table.gl tr[data-brand]{cursor:pointer}table.gl tr[data-brand]:hover td{background:#f7f8fb}table.gl td,table.gl th{font-size:12px}.cp[data-brand]:hover,table.allp tr[data-no]:hover td{background:#f7f8fb}.kw[data-brand]:hover{background:#dfe6ef}
.rest{margin-top:2mm;border-top:.5pt solid #f0f1f4;padding-top:1.6mm}.rest small{font-size:7.2pt;color:var(--mut)}.rest .kw{font-size:7.2pt;padding:.3mm 1.8mm}
.lsearch{display:block;margin-bottom:2mm}.lsearch input[type=search]{width:100%;max-width:70mm;font:inherit;font-size:9pt;padding:1.4mm 2.4mm;border:.5pt solid var(--line);border-radius:1.4mm}
table.allp th[data-sort]{cursor:pointer;user-select:none}table.allp th[data-sort]:hover{background:#dfe6ef}table.allp .si{font-size:7pt;color:var(--navy)}.lsearch label{margin:0 3mm;font-size:8.5pt;white-space:nowrap}.lsearch button{font:inherit;font-size:8.5pt;padding:1.2mm 3mm;border:.5pt solid var(--line);background:#fff;border-radius:1.4mm;cursor:pointer;margin-right:3mm}.lsearch .mut{font-size:8pt}
table.allp{font-size:7.4pt}table.allp td{vertical-align:middle;padding:.5mm 1.4mm}table.allp td.im{width:10mm;padding:.4mm .8mm}table.allp td.im img{display:block;width:8.6mm;height:9mm;object-fit:contain}table.allp tr[hidden]{display:none}
.bgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.bl{overflow-wrap:anywhere;display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:3px 0;border-top:1px solid #f0f1f4}.bl b{font-weight:500;color:var(--navy2);white-space:nowrap}.bt{font-size:12px}.bt td{vertical-align:top;overflow-wrap:anywhere}
.sbx{display:flex;flex-direction:column;gap:3.4mm;overflow:hidden}.sbk{border-top:.5pt solid #f0f1f4;padding-top:2.4mm}.sbk:first-child{border-top:0;padding-top:0}.sbsum{margin:0 0 1.6mm;font-size:8pt;color:#3b475c}
.sth{display:grid;grid-template-columns:34mm 1fr 10mm;gap:.4mm 2.4mm;align-items:center;padding:.5mm 0;font-size:8pt}.sth .sl{font-weight:700;color:var(--navy2)}.sth b{text-align:right;font-weight:500}.sth small{grid-column:1/4;color:var(--mut);font-size:7pt;line-height:1.25;margin-top:-.4mm}
.bar.pos i{background:#4f8a6f}.bar.neg i{background:#b5524a}.bar.neu i{background:var(--navy)}.sth[data-sop],.sall{cursor:pointer}.sth[data-sop]:hover{background:#f7f8fb}.sbh{display:flex;justify-content:space-between;align-items:baseline}.sall{font-size:7.6pt;color:var(--navy);font-weight:400}.sall:hover{text-decoration:underline}
mark{background:#fbe8a8;color:inherit;padding:0 .3mm;border-radius:.4mm}
.empty{color:#9aa0ab;font-size:7.8pt;padding:2mm 0}
.qt{font-size:8pt;border-left:.8mm solid var(--mist);padding:.6mm 0 .6mm 2.4mm;margin-bottom:1.6mm}.qt b{color:var(--navy2)}
.pgh{font-weight:700;font-size:9pt;margin:.8mm 0 .2mm;color:var(--navy2);border-bottom:.5pt solid var(--line);padding-bottom:.6mm}.pgh u{display:inline-block;width:2.4mm;height:2.4mm;border-radius:50%;margin-right:1.6mm}
.prs{flex:1;min-height:0;overflow:hidden}.pr{display:grid;grid-template-columns:22mm 1fr 40mm 20mm 38mm 46mm;gap:3mm;align-items:center;padding:.15mm 0;border-bottom:.5pt solid #f0f1f4;font-size:8pt}.pr b{font-weight:500}.rn{font-size:7pt;color:var(--mut);line-height:1.25;white-space:nowrap}.rn .wi,.lg.wi{color:#16283F;font-weight:700}.rn .ws,.lg.ws{color:#c98a55;font-weight:700}.plg{margin:.6mm 0 1.4mm}.ds{font-size:7pt;color:var(--mut);line-height:1.25}.cmx{font-size:7.2pt;color:#4a5263}
.vd{font-size:7pt;font-weight:700;padding:.4mm 1.6mm;border-radius:1mm;white-space:nowrap;text-align:center}.vr{background:var(--lowbg);color:var(--lowfg)}.vb{background:var(--okbg);color:var(--okfg)}.vg{background:#e1ece6;color:#2c5f46}.v0{background:#f1f3f7;color:#9aa0ab}
.cp{border-top:.5pt solid #f0f1f4;padding:1.6mm 0}.cpt{display:grid;grid-template-columns:5mm 28mm 1fr 18mm;gap:2mm;align-items:center}.rk{width:4.4mm;height:4.4mm;border-radius:50%;background:var(--navy2);color:#fff;font-size:7pt;display:grid;place-items:center}.cpt b{font-size:9pt}.bar{height:2.2mm;background:#f1f3f7;border-radius:1mm}.bar i{display:block;height:100%;background:var(--navy);border-radius:1mm;opacity:.7}.cpt em{font-style:normal;font-size:7.5pt;color:var(--mut);text-align:right}
.cp dl{display:grid;grid-template-columns:14mm 1fr;gap:.3mm 2mm;margin:1mm 0 0 7mm;font-size:7.6pt}.cp dt{color:var(--mut)}.cp dd{margin:0}
.dt{display:inline-block;width:2mm;height:2mm;border-radius:50%;margin:0 1mm 0 3mm}
table{width:100%;border-collapse:collapse;font-size:8pt}th,td{border:.5pt solid var(--line);padding:1.2mm 1.6mm;text-align:left;vertical-align:top}th{background:#eef1f6;font-weight:700}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}th.c{text-align:center}
tr{break-inside:avoid}thead{display:table-header-group}tfoot{display:table-footer-group}
tr.grp td{background:#f5f6fa;font-weight:700}tr.tot td{background:#eef1f6;font-weight:700}tr.none td{color:#9aa1b2}
td.cm{font-size:7.5pt;min-width:60mm}td.cm div{margin-bottom:.6mm}td.low,.low{background:var(--lowbg)!important;color:var(--lowfg)!important;font-weight:700}td.warn,.warn{background:var(--warnbg)!important;color:var(--warnfg)!important}
.legend{margin:0 0 2.5mm;font-size:8pt}.legend .sw{margin:0 1pt 0 8pt}.legend .sw.low{background:var(--lowbg)}.legend .sw.warn{background:var(--warnbg)}
.kpis.small{margin:2mm 0 3mm}.three{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm}.three p{margin:0 0 1mm;font-size:8pt}.two{display:grid;grid-template-columns:1fr 1fr;gap:6mm}
.kpi{border:.5pt solid var(--line);padding:2mm 3mm}.kpi b{display:block;font-size:13pt}.kpi span{font-size:7.5pt;color:var(--mut)}
.tagr{background:var(--lowbg);color:var(--lowfg);padding:0 1.5mm;font-weight:700;white-space:nowrap}.tagb{background:var(--okbg);color:var(--okfg);padding:0 1.5mm;font-weight:700;white-space:nowrap}.tagg{background:#e1ece6;color:#2c5f46;padding:0 1.5mm;font-weight:700;white-space:nowrap}.nw{white-space:nowrap}
@page dash{size:A4 landscape;margin:0}@page flow{size:A4 landscape;margin:8mm 8mm 12mm}.pg.dash{page:dash}.pg.flow{page:flow}
@media print{.modal,template{display:none!important}.so{display:none}.it{cursor:auto}body{background:#fff}.pg{width:297mm;min-height:210mm;margin:0;box-shadow:none;break-after:page}.pg:last-child{break-after:auto}.pg.dash{height:210mm}.pg.flow{width:auto;min-height:0;padding:0}}
`;
const fontLink = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&family=Noto+Sans:wght@400;500;700&display=swap">';
const wrap = (title, pagesArr, extra = '') => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>${fontLink}<style>${css}</style></head><body>${pagesArr.join('\n')}${extra}</body></html>`;
const outDir = join(ROOT, 'reports', SEASON); mkdirSync(outDir, { recursive: true });
const outMain = HUBPUB ? join(HUB, 'etc-reports', `${SEASON}_store_survey_report.html`) : join(outDir, `취합리포트_${today}.html`), outApp = join(outDir, `취합리포트_부록_${today}.html`);
writeFileSync(outMain, wrap(`${SEASON} 매장 반응도 조사 취합 리포트`, mainPages, modalHtml));
if (PORTAL) {
  // 비밀번호: --password > reports/portal-password.txt > 새로 생성(저장). 비밀번호는 git 에 올라가지 않음(reports/ 는 .gitignore)
  const pwFile = join(ROOT, 'reports', 'portal-password.txt');
  let pw = arg('password', existsSync(pwFile) ? readFileSync(pwFile, 'utf8').trim() : '');
  if (!pw) { pw = randomBytes(9).toString('base64url').replace(/[-_]/g, 'x'); mkdirSync(dirname(pwFile), { recursive: true }); writeFileSync(pwFile, pw); console.log('새 비밀번호를 만들어 reports/portal-password.txt 에 저장했습니다.'); }
  else if (arg('password', '')) { mkdirSync(dirname(pwFile), { recursive: true }); writeFileSync(pwFile, pw); }
  const salt = randomBytes(16), iv = randomBytes(12), iter = 200000;
  const key = pbkdf2Sync(pw, salt, iter, 32, 'sha256'), cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(gzipSync(Buffer.from(wrap(`${SEASON} 매장 반응도 조사 취합 리포트`, mainPages, modalHtml), 'utf8'))), cipher.final(), cipher.getAuthTag()]);   // WebCrypto 형식: 암호문 뒤에 태그
  const outDirP = join(ROOT, 'report'); mkdirSync(outDirP, { recursive: true });
  writeFileSync(join(outDirP, 'report.enc.json'), JSON.stringify({ v: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iter, gz: true, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') }));
  writeFileSync(join(outDirP, 'report.meta.json'), JSON.stringify({ updated: nowK, season: SEASON }));
  console.log(`포털용 암호화 리포트 저장: report/report.enc.json (${(ct.length / 1024).toFixed(0)}KB)`);
}
if (!flag('main-only') && !HUBPUB && !PORTAL) writeFileSync(outApp, wrap(`${SEASON} 매장 반응도 조사 취합 리포트 · 부록`, appPages));
console.log(`리포트 생성: ${outMain}\n부록: ${outApp}\n  제출 ${storeCount}/${stores.length}개 매장 · 상품평가 ${PR.length}건 · 가격 ${PC.length}건 · 경쟁브랜드 ${CP.length}건 · 본문 ${mainPages.length}페이지 + 부록 ${appPages.length}개 섹션`);

if (flag('pdf')) {
  const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
  if (!chrome) console.log('Chrome 을 찾지 못해 PDF 는 건너뜁니다. HTML 을 열어 인쇄 > PDF 로 저장하세요.');
  else for (const f of flag('main-only') ? [outMain] : [outMain, outApp]) { const pdf = f.replace(/\.html$/, '.pdf'); execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=8000', `--print-to-pdf=${pdf}`, 'file:///' + resolve(f).replace(/\\/g, '/')], { stdio: 'ignore' }); console.log('PDF:', pdf); }
}
