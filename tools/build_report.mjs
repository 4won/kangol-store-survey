// 취합 리포트(A4 가로 HTML) 생성: 구글시트 raw 응답 + 허브 productmap(입고·판매·판매율) 결합
//   node tools/build_report.mjs [--season 26AW] [--sheet <시트ID>] [--hub D:/claude/kangol-work-hub] [--csv <폴더>] [--pdf]
//   · 응답: 구글시트(링크 보기 공유) 의 raw 탭을 CSV 로 읽음. --csv 폴더를 주면 그 안의 {탭명}.csv 사용(오프라인 확인용)
//   · 출력: reports/{시즌}/취합리포트_{기준일}.html  (판매 수치가 들어가므로 git 에 올리지 않음 — .gitignore)
//   · --pdf: 설치된 Chrome 으로 같은 위치에 PDF 도 생성
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes('--' + k);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEASON = arg('season', '26AW'), HUB = arg('hub', 'D:/claude/kangol-work-hub');
// 시트 ID 는 공개 저장소에 올리지 않음: --sheet 또는 reports/sheet.txt(gitignore) 에 보관
const sheetFile = join(ROOT, 'reports', 'sheet.txt');
const SHEET = arg('sheet', existsSync(sheetFile) ? readFileSync(sheetFile, 'utf8').trim() : ''), CSVDIR = arg('csv', '');
if (!SHEET && !CSVDIR) { console.error('시트 ID 가 없습니다. --sheet <ID> 를 주거나 reports/sheet.txt 에 ID 를 적어 두세요.'); process.exit(1); }
const LOW = 2.5, WARN = 3.0;                      // 점수 색 기준: LOW 미만 빨강, WARN 미만 주황
const CATS = ['가방', '의류', '모자'];
const PSUBS = { '가방': ['토트백', '크로스백', '백팩'], '의류': ['긴소매티셔츠', '라운드티셔츠', '집업', '바지', '자켓', '후드티셔츠', '셔츠', '니트'], '모자': ['벙거지', '야구모자'] };
const CHANNELS = ['백화점', '쇼핑몰', '아울렛'];

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

const [S, PR, PC, CP] = [await tab('시즌응답'), await tab('상품평가'), await tab('가격적정선'), await tab('경쟁브랜드')].map(latest);
const stores = JSON.parse(readFileSync(join(ROOT, SEASON, 'data/stores.json'), 'utf8'));
const prodList = JSON.parse(readFileSync(join(ROOT, SEASON, 'data/products.json'), 'utf8'));
const index = JSON.parse(readFileSync(join(HUB, 'data/summary/index.json'), 'utf8'));
const pmWeek = arg('week', index.latest);
const pm = JSON.parse(readFileSync(join(HUB, 'data/summary/productmap', pmWeek + '.json'), 'utf8'));
const pmBy = Object.fromEntries(pm.products.map(p => [p.product_no, p]));

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
const products = prodList.items.map(p => {
  const rs = byProd[p.no] || [], m = pmBy[p.no] || {};
  const inbound = m.inbound_qty ?? null, sales = m.sales_qty ?? null;
  return {
    ...p, n: rs.length, design: avg(rs.map(r => num(r['디자인']))), pscore: avg(rs.map(r => num(r['가격']))),
    inbound, sales, rate: inbound ? sales / inbound : (m.sell_through ?? null),
    comments: rs.filter(r => r['한줄평']).map(r => ({ store: r['매장명'], text: r['한줄평'] })),
  };
});
const respByCat = c => PR.filter(r => r['복종'] === c);
const agg = list => ({ inbound: sum(list.map(p => p.inbound)), sales: sum(list.map(p => p.sales)), n: sum(list.map(p => p.n)) });
const rateOf = a => (a.inbound ? a.sales / a.inbound : null);

/* ---------- 렌더 ---------- */
const today = new Date().toISOString().slice(0, 10);
const asOf = pm.meta?.data_as_of || pmWeek;
const pages = [];
const page = (title, body, cls2 = '') => pages.push(`<section class="pg ${cls2}"><h2>${title}</h2>${body}</section>`);
const legend = `<div class="legend"><span class="sw low"></span>${LOW.toFixed(1)}점 미만 <span class="sw warn"></span>${LOW.toFixed(1)}~${WARN.toFixed(1)}점 미만 <span class="mut">· 점수는 1~5점 평균 (시즌 전반은 전년 25AW = 3점 기준)</span></div>`;

// 1) 요약
{
  const ov = avg(S.map(r => num(r['전체만족도']))), as = avg(S.map(r => num(r['상품구성']))), tm = avg(S.map(r => num(r['물량·입고']))), cu = avg(S.map(r => num(r['고객반응'])));
  const kpi = (v, l, c = '') => `<div class="kpi"><b class="${c}">${v}</b><span>${l}</span></div>`;
  const chRows = CHANNELS.map(ch => {
    const all = stores.filter(s => s.type === ch), done = all.filter(s => S.some(r => r['매장명'] === s.name)), ss = S.filter(r => channelOf(r['매장명']) === ch);
    return `<tr><td>${ch}</td><td class="n">${all.length}</td><td class="n">${done.length}</td><td class="n">${all.length ? pct(done.length / all.length) : '-'}</td>${sc(avg(ss.map(r => num(r['전체만족도']))), 1)}${sc(avg(ss.map(r => num(r['상품구성']))), 1)}${sc(avg(ss.map(r => num(r['물량·입고']))), 1)}${sc(avg(ss.map(r => num(r['고객반응']))), 1)}</tr>`;
  }).join('');
  const catRows = CATS.map(c => {
    const l = products.filter(p => p.cat === c), a = agg(l), rs = respByCat(c);
    return `<tr><td>${c}</td><td class="n">${l.length}</td><td class="n">${new Set(rs.map(r => r['품번'])).size}</td><td class="n">${n0(a.inbound)}</td><td class="n">${n0(a.sales)}</td><td class="n">${pct(rateOf(a))}</td>${sc(avg(rs.map(r => num(r['디자인']))))}${sc(avg(rs.map(r => num(r['가격']))))}</tr>`;
  }).join('');
  page(`${SEASON} 매장 반응도 조사 · 취합 리포트`, `
  <div class="sub">응답 기준 ${today} · 판매 데이터 ${asOf} 기준(주차 ${pmWeek}) · 출고된 ${products.length}개 상품 대상</div>
  <div class="kpis">${kpi(`${storeCount} / ${stores.length}`, '제출 매장')}${kpi(f1(ov), '시즌 전체 만족도 (기준 3.0)', cls(ov).trim())}${kpi(f2(avg(PR.map(r => num(r['디자인'])))), '디자인 평균', cls(avg(PR.map(r => num(r['디자인'])))).trim())}${kpi(f2(avg(PR.map(r => num(r['가격'])))), '가격 평균', cls(avg(PR.map(r => num(r['가격'])))).trim())}${kpi(n0(PR.length), '상품 평가 건수')}</div>
  <div class="two"><div><h3>채널형태별 제출 현황 · 시즌 평가</h3><table><thead><tr><th>채널</th><th class="n">대상</th><th class="n">제출</th><th class="n">제출률</th><th class="n">전체</th><th class="n">구성</th><th class="n">입고</th><th class="n">고객</th></tr></thead><tbody>${chRows}
  <tr class="tot"><td>전체</td><td class="n">${stores.length}</td><td class="n">${storeCount}</td><td class="n">${pct(storeCount / stores.length)}</td>${sc(ov, 1)}${sc(as, 1)}${sc(tm, 1)}${sc(cu, 1)}</tr></tbody></table></div>
  <div><h3>복종별 요약</h3><table><thead><tr><th>복종</th><th class="n">상품</th><th class="n">평가됨</th><th class="n">입고</th><th class="n">판매</th><th class="n">판매율</th><th class="n">디자인</th><th class="n">가격</th></tr></thead><tbody>${catRows}</tbody></table></div></div>
  ${legend}
  <div class="toc"><b>구성</b> 1 요약 · 2 복종별 상품 취합(가방/의류/모자) · 3 가격 적정선 · 4 채널별 비교 · 5 경쟁브랜드 · 6 시즌 전반 의견 · 부록 매장별 의견</div>`, 'cover');
}

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
  page(`2. ${c} 상품 취합`, legend + body, 'flow');
}

// 3) 가격 적정선
{
  let body = `<table><thead><tr><th>복종</th><th>세부복종</th><th class="n">현재 판매가 범위</th><th class="n">판매가 중앙값</th><th class="n">응답</th><th class="n">적정 하한</th><th class="n">적정 상한</th><th>판정</th><th>우리 가격 수준</th><th>경쟁브랜드 대비</th><th>의견</th></tr></thead><tbody>`;
  for (const c of CATS) for (const s of PSUBS[c]) {
    const ps = products.filter(p => p.cat === c && p.sub === s && p.price).map(p => p.price), rs = PC.filter(r => r['세부복종'] === s);
    const lo = med(rs.map(r => num(r['적정하한']))), hi = med(rs.map(r => num(r['적정상한']))), pm_ = med(ps);
    let verdict = '<span class="mut">-</span>';
    if (pm_ != null && hi != null && lo != null) verdict = pm_ > hi ? '<span class="tagr">적정가 초과</span>' : pm_ < lo ? '<span class="tagb">적정가 미만</span>' : '<span class="tagg">적정 범위</span>';
    const cm = rs.filter(r => r['의견']).slice(0, 3).map(r => `<div><b>${esc(r['매장명'])}</b> ${esc(r['의견'].replace(/^\[테스트\]\s*/, ''))}</div>`).join('');
    body += `<tr><td class="nw">${c}</td><td class="nw">${s}</td><td class="n">${ps.length ? n0(Math.min(...ps)) + ' ~ ' + n0(Math.max(...ps)) : '-'}</td><td class="n">${n0(pm_)}</td><td class="n">${rs.length || '-'}</td><td class="n">${n0(lo)}</td><td class="n">${n0(hi)}</td><td>${verdict}</td><td>${dist(rs.map(r => r['현재가수준']), ['낮은 편', '적정', '높은 편'])}</td><td>${dist(rs.map(r => r['경쟁대비']), ['저렴', '비슷', '비쌈'])}</td><td class="cm">${cm}</td></tr>`;
  }
  page('3. 가격 적정선', `<div class="sub">매장이 제시한 적정 가격대(중앙값)와 현재 판매가를 비교합니다. 판정: 판매가 중앙값이 적정 상한을 넘으면 "적정가 초과".</div>${body}</tbody></table>`, 'flow');
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
  page('4. 채널별 비교', legend + body + '</tbody></table>', 'flow');
}

// 5) 경쟁브랜드
{
  let body = '';
  for (const g of ['의류', '가방']) {
    const rs = CP.filter(r => r['복종'] === g && r['브랜드']), by = {};
    rs.forEach(r => (by[r['브랜드'].trim().toLowerCase()] ||= []).push(r));
    const rows = Object.values(by).sort((a, b) => new Set(b.map(r => r['매장명'])).size - new Set(a.map(r => r['매장명'])).size);
    body += `<h3>${g}</h3><table><thead><tr><th>브랜드</th><th class="n">언급 매장</th><th>가격대</th><th>강점</th><th>프로모션·동향</th><th>고객 반응</th></tr></thead><tbody>` +
      (rows.map(l => { const j = k => [...new Set(l.map(r => r[k]).filter(Boolean))].map(esc).join(' / '); return `<tr><td><b>${esc(l[0]['브랜드'])}</b></td><td class="n">${new Set(l.map(r => r['매장명'])).size}</td><td>${j('가격대')}</td><td>${j('강점')}</td><td>${j('프로모션·동향')}</td><td>${j('고객반응')}</td></tr>`; }).join('') || '<tr><td colspan="6" class="mut">응답 없음</td></tr>') + '</tbody></table>';
  }
  page('5. 경쟁브랜드 현황', `<div class="sub">매장이 꼽은 대표 경쟁브랜드(의류·가방 각 2곳). 같은 브랜드는 합쳐서 언급 매장 수 순으로 정렬.</div>${body}`, 'flow');
}

// 6) 시즌 전반 의견
{
  const rows = S.slice().sort((a, b) => (a['채널형태'] + a['매장명']).localeCompare(b['채널형태'] + b['매장명'], 'ko')).map(r => `<tr><td>${esc(r['채널형태'])}<br><b>${esc(r['매장명'])}</b></td>${sc(num(r['전체만족도']), 0)}${sc(num(r['상품구성']), 0)}${sc(num(r['물량·입고']), 0)}${sc(num(r['고객반응']), 0)}<td class="cm">${esc((r['잘된점'] || '').replace(/^\[테스트\]\s*/, ''))}</td><td class="cm">${esc((r['아쉬운점'] || '').replace(/^\[테스트\]\s*/, ''))}</td><td class="cm">${esc((r['기타의견'] || '').replace(/^\[테스트\]\s*/, ''))}${r['경쟁환경의견'] ? `<div class="mut">경쟁환경: ${esc(r['경쟁환경의견'].replace(/^\[테스트\]\s*/, ''))}</div>` : ''}</td></tr>`).join('');
  page('6. 시즌 전반 의견', `<div class="sub">전년(25AW) = 3점 기준. 3점 미만은 색으로 표시.</div><table><thead><tr><th>매장</th><th class="n">전체</th><th class="n">구성</th><th class="n">입고</th><th class="n">고객</th><th>잘 된 점</th><th>아쉬운 점</th><th>기타</th></tr></thead><tbody>${rows}</tbody></table>`, 'flow');
}

// 부록) 매장별 의견 — 매장마다 새 페이지
for (const s of S.slice().sort((a, b) => (a['채널형태'] + a['채널계열'] + a['매장명']).localeCompare(b['채널형태'] + b['채널계열'] + b['매장명'], 'ko'))) {
  const name = s['매장명'], pr = PR.filter(r => r['매장명'] === name), pc = PC.filter(r => r['매장명'] === name), cp = CP.filter(r => r['매장명'] === name);
  const clean = t => esc(String(t || '').replace(/^\[테스트\]\s*/, ''));
  const prodRows = pr.map(r => { const m = pmBy[r['품번']] || {}; return `<tr><td>${esc(r['복종'])}·${esc(r['세부복종'])}</td><td>${esc(r['품번'])}</td><td>${esc(r['상품명'])}</td><td class="n">${n0(num(r['판매가']))}</td><td class="n">${pct(m.inbound_qty ? m.sales_qty / m.inbound_qty : null)}</td>${sc(num(r['디자인']), 0)}${sc(num(r['가격']), 0)}<td class="cm">${clean(r['한줄평'])}</td></tr>`; }).join('');
  page(`부록 · ${esc(name)} <span class="mut">${esc(s['채널형태'])} · ${esc(s['채널계열'])}</span>`, `
  <div class="kpis small"><div class="kpi"><b class="${cls(num(s['전체만족도'])).trim()}">${s['전체만족도'] || '-'}</b><span>전체</span></div><div class="kpi"><b class="${cls(num(s['상품구성'])).trim()}">${s['상품구성'] || '-'}</b><span>구성</span></div><div class="kpi"><b class="${cls(num(s['물량·입고'])).trim()}">${s['물량·입고'] || '-'}</b><span>입고</span></div><div class="kpi"><b class="${cls(num(s['고객반응'])).trim()}">${s['고객반응'] || '-'}</b><span>고객반응</span></div><div class="kpi"><b>${pr.length}</b><span>평가 상품</span></div></div>
  <div class="three"><div><h3>잘 된 점</h3><p>${clean(s['잘된점']) || '-'}</p></div><div><h3>아쉬운 점</h3><p>${clean(s['아쉬운점']) || '-'}</p></div><div><h3>기타 · 경쟁환경</h3><p>${clean(s['기타의견']) || '-'}</p><p>${clean(s['경쟁환경의견'])}</p></div></div>
  <h3>상품 평가</h3><table><thead><tr><th>복종</th><th>품번</th><th>상품명</th><th class="n">판매가</th><th class="n">판매율</th><th class="n">디자인</th><th class="n">가격</th><th>한줄평</th></tr></thead><tbody>${prodRows || '<tr><td colspan="8" class="mut">평가한 상품 없음</td></tr>'}</tbody></table>
  <div class="two"><div><h3>가격 적정선</h3><table><thead><tr><th>복종</th><th class="n">하한</th><th class="n">상한</th><th>가격 수준</th><th>경쟁 대비</th><th>의견</th></tr></thead><tbody>${pc.map(r => `<tr><td>${esc(r['세부복종'])}</td><td class="n">${n0(num(r['적정하한']))}</td><td class="n">${n0(num(r['적정상한']))}</td><td>${esc(r['현재가수준'])}</td><td>${esc(r['경쟁대비'])}</td><td class="cm">${clean(r['의견'])}</td></tr>`).join('') || '<tr><td colspan="6" class="mut">-</td></tr>'}</tbody></table></div>
  <div><h3>경쟁브랜드</h3><table><thead><tr><th>구분</th><th>브랜드</th><th>가격대</th><th>강점·동향·반응</th></tr></thead><tbody>${cp.map(r => `<tr><td>${esc(r['복종'])}</td><td><b>${esc(r['브랜드'])}</b></td><td>${esc(r['가격대'])}</td><td class="cm">${[r['강점'], r['프로모션·동향'], r['고객반응']].filter(Boolean).map(clean).join(' / ')}</td></tr>`).join('') || '<tr><td colspan="4" class="mut">-</td></tr>'}</tbody></table></div></div>`, 'flow store');
}

/* ---------- HTML ---------- */
const css = `
:root{--ink:#161b26;--mut:#6b7385;--line:#cfd4df;--head:#eceff6;--acc:#1f3a8a;--lowbg:#f6cfc9;--lowfg:#8a1c12;--warnbg:#fbe8bd;--warnfg:#7a5200}
*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:'Malgun Gothic','Noto Sans KR','Apple SD Gothic Neo',sans-serif;color:var(--ink);font-size:8.5pt;line-height:1.35;background:#e4e6ec}
.pg{width:297mm;min-height:210mm;margin:10mm auto;padding:12mm 10mm 14mm;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.18)}
h2{margin:0 0 3mm;font-size:15pt;color:var(--acc);border-bottom:1.5pt solid var(--acc);padding-bottom:2mm}
h3{margin:4mm 0 1.5mm;font-size:10pt}
.sub{color:var(--mut);margin:0 0 3mm}.mut{color:var(--mut);font-weight:400}
table{width:100%;border-collapse:collapse;font-size:8pt}
th,td{border:.5pt solid var(--line);padding:1.2mm 1.6mm;text-align:left;vertical-align:top}
th{background:var(--head);font-weight:700}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}th.c{text-align:center}
tr{break-inside:avoid}thead{display:table-header-group}tfoot{display:table-footer-group}
tr.grp td{background:#f5f6fa;font-weight:700}tr.tot td{background:var(--head);font-weight:700}tr.none td{color:#9aa1b2}
td.cm{font-size:7.5pt;min-width:60mm}td.cm div{margin-bottom:.6mm}
.low{background:var(--lowbg)!important;color:var(--lowfg)!important;font-weight:700}
.warn{background:var(--warnbg)!important;color:var(--warnfg)!important}
.legend{margin:0 0 2.5mm;font-size:8pt}.sw{display:inline-block;width:9pt;height:9pt;margin:0 2pt 0 8pt;vertical-align:-1pt;border:.5pt solid var(--line)}.sw.low{background:var(--lowbg)}.sw.warn{background:var(--warnbg)}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:3mm;margin:3mm 0 4mm}.kpi{border:.5pt solid var(--line);padding:2.5mm 3mm}.kpi b{display:block;font-size:17pt;font-variant-numeric:tabular-nums}.kpi span{font-size:7.5pt;color:var(--mut)}
.kpi b.low,.kpi b.warn{display:inline-block;padding:0 2mm}
.kpis.small{margin:2mm 0 3mm}.kpis.small .kpi b{font-size:13pt}
.two{display:grid;grid-template-columns:1fr 1fr;gap:6mm}.three{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm}.three p{margin:0 0 1mm;font-size:8pt}
.toc{margin-top:6mm;color:var(--mut)}
.nw{white-space:nowrap}.tagr,.tagb,.tagg{white-space:nowrap}.tagr{background:var(--lowbg);color:var(--lowfg);padding:0 1.5mm;font-weight:700}.tagb{background:#d9e6fb;color:#1c3f8c;padding:0 1.5mm;font-weight:700}.tagg{background:#d8efdf;color:#17602f;padding:0 1.5mm;font-weight:700}
@page{size:A4 landscape;margin:12mm 10mm 14mm;@bottom-left{content:"${SEASON} 매장 반응도 조사 취합 리포트";font-size:7pt;color:#6b7385}@bottom-right{content:counter(page) " / " counter(pages);font-size:7pt;color:#6b7385}}
@media print{body{background:#fff}.pg{width:auto;min-height:0;margin:0;padding:0;box-shadow:none;break-after:page}.pg:last-child{break-after:auto}.pg.cover{height:182mm}}
`;
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${SEASON} 매장 반응도 조사 취합 리포트</title><style>${css}</style></head><body>${pages.join('\n')}</body></html>`;
const outDir = join(ROOT, 'reports', SEASON); mkdirSync(outDir, { recursive: true });
const out = join(outDir, `취합리포트_${today}.html`);
writeFileSync(out, html);
console.log(`리포트 생성: ${out}\n  제출 ${storeCount}/${stores.length}개 매장 · 상품평가 ${PR.length}건 · 가격 ${PC.length}건 · 경쟁브랜드 ${CP.length}건 · 페이지 구성 ${pages.length}개 섹션`);

if (flag('pdf')) {
  const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
  if (!chrome) console.log('Chrome 을 찾지 못해 PDF 는 건너뜁니다. HTML 을 열어 인쇄 > PDF 로 저장하세요.');
  else { const pdf = out.replace(/\.html$/, '.pdf'); execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdf}`, 'file:///' + resolve(out).replace(/\\/g, '/')], { stdio: 'ignore' }); console.log('PDF:', pdf); }
}
