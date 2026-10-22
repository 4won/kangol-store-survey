// 매장 SKU 조사 취합 리포트 (A4 가로 HTML): 구글시트 raw 응답 + 상품기초정보 + (선택) 허브 판매 데이터
//   node tools/build_report.mjs [--sheet <시트ID>] [--season 26AW] [--hub D:/claude/kangol-work-hub] [--portal [--password 비번]]
//   · 시트 ID 는 --sheet 또는 reports/sheet.txt (git 에 올리지 않음)
//   · 기본 출력: reports/{시즌}/SKU리포트_{날짜}.html (로컬 확인용)
//   · --portal : 허브 페이지(루트 주소)용으로 비밀번호 암호화해 report/report.enc.json 저장
//   · 3번(과다 SKU 운영 실태)은 매장명 없이 합계·익명 문구만 표시합니다.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, pbkdf2Sync, createCipheriv } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes('--' + k);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEASON = arg('season', '26AW'), HUB = arg('hub', 'D:/claude/kangol-work-hub'), PORTAL = flag('portal');
const sheetFile = join(ROOT, 'reports', 'sheet.txt');
const SHEET = arg('sheet', existsSync(sheetFile) ? readFileSync(sheetFile, 'utf8').trim() : '');
if (!SHEET) { console.error('시트 ID 가 없습니다. --sheet <ID> 또는 reports/sheet.txt 에 적어 두세요.'); process.exit(1); }
const CATS = ['의류', '가방', '모자'], CHANNELS = ['백화점', '아울렛', '쇼핑몰'];
const chLabel = ch => (ch === '쇼핑몰' ? '복합쇼핑몰' : ch);
const LEVELS = ['너무 많다', '많다', '적당하다', '모자르다', '너무 모자르다'];
const OVER = ['DP하지 않고 창고에 적재', '넘치더라도 매장에 추가 DP', '기타'];
const DIR = ['매장에서 제거(반품 등)', '매장 내 보유(창고 보관 등)', '과다하지만 추가 DP'];

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
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${name} 탭 읽기 실패 (HTTP ${r.status}) — 시트가 '링크가 있는 모든 사용자: 보기' 인지 확인`);
  const [h, ...rows] = parseCsv(await r.text());
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}
const latest = rows => rows.filter(r => r['최신'] === 'Y');
const [R, RM, AD] = [await tab('응답'), await tab('제거요청'), await tab('추가요청')].map(latest);
const stores = JSON.parse(readFileSync(join(ROOT, SEASON, 'data/stores.json'), 'utf8'));
const prods = JSON.parse(readFileSync(join(ROOT, SEASON, 'data/products.json'), 'utf8')).items;
const byNo = Object.fromEntries(prods.map(p => [p.no, p]));
// 이미지: 상품반응도 설문의 상품 이미지 폴더 (출고 상품만 있음)
let imgOf = {};
try { for (const p of JSON.parse(readFileSync(join(ROOT, '..', '상품반응도_26AW', SEASON, 'data/products.json'), 'utf8')).items) if (p.img) imgOf[p.no] = p.img.split('/').pop(); } catch { /* 이미지 없음 */ }
// 판매 데이터(입고·판매·판매율): 허브 productmap 최신 주차 (없으면 생략)
let sales = {};
try {
  const idx = JSON.parse(readFileSync(join(HUB, 'data/summary/index.json'), 'utf8'));
  for (const p of JSON.parse(readFileSync(join(HUB, 'data/summary/productmap', idx.latest + '.json'), 'utf8')).products) sales[p.product_no] = { inbound: p.inbound_qty, sales: p.sales_qty, rate: p.inbound_qty ? p.sales_qty / p.inbound_qty : null };
} catch { console.log('판매 데이터를 읽지 못해 판매율 없이 생성합니다.'); }

/* ---------- 계산 ---------- */
const num = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return v === '' || v == null || isNaN(n) ? null : n; };
const sum = a => a.reduce((s, x) => s + (x || 0), 0);
const avg = a => { a = a.filter(x => x != null); return a.length ? sum(a) / a.length : null; };
const med = a => { a = a.filter(x => x != null).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const f1 = x => (x == null ? '-' : x.toFixed(1)), n0 = x => (x == null ? '-' : Math.round(x).toLocaleString('ko-KR'));
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '-');
const sgn = x => (x == null ? '-' : x > 0 ? '+' + Math.round(x) : String(Math.round(x)));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clip = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const typeOf = Object.fromEntries(stores.map(s => [s.name, s.type]));
const chOf = r => typeOf[r['매장명']] || r['채널형태'];
const row = r => Object.fromEntries(CATS.map(c => [c, { a: num(r[`${c}_실제DP`]), i: num(r[`${c}_적정DP`]), d: num(r[`${c}_차이`]), lv: LEVELS.indexOf(r[`${c}_의견`]) + 1 }]));
const D = R.map(r => ({ r, store: r['매장명'], ch: chOf(r), grp: r['채널계열'], c: row(r), over: r['과다SKU_운영실태'], other: r['과다SKU_기타'], dir: r['차이_방향'], free: (r['SKU_자유의견'] || '').trim() }));
const N = D.length;
const today = new Date().toISOString().slice(0, 10);
const C = { navy: '#1F3A5C', navy2: '#16283F', steel: '#8fa3bf', low: '#b5524a', warn: '#b98f3c', good: '#3f6f5a', gold: '#D9C68C', bag: '#c98a55', cloth: '#5f9e84', hat: '#8a7bbf' };
const catColor = { '의류': C.cloth, '가방': C.bag, '모자': C.hat };

/* ---------- 요청 품번 집계 ---------- */
function tally(list) {
  const m = new Map();
  for (const r of list) { const no = r['품번']; if (!no) continue; if (!m.has(no)) m.set(no, { no, name: r['상품명'], cat: r['복종'], stores: new Map() }); m.get(no).stores.set(r['매장명'], chOf(r)); }
  return [...m.values()].map(x => ({ ...x, n: x.stores.size })).sort((a, b) => b.n - a.n || a.no.localeCompare(b.no));
}
const rem = tally(RM), add = tally(AD);
const remBy = Object.fromEntries(rem.map(x => [x.no, x])), addBy = Object.fromEntries(add.map(x => [x.no, x]));

/* ---------- 키워드(주제) 규칙 ---------- */
const THEMES = {
  other: [
    ['신상 우선 DP · 이월/비인기 제외', '신상품을 먼저 진열하고 이월·반응 없는 상품은 뺌', ['신상', '이월', '반응\\s*(안|좋지)', '손이?\\s*(타지|한번)', '판매되지']],
    ['창고 보관 · 재패킹', '진열하지 않는 상품은 창고에 보관', ['창고', '재\\s*패킹']],
    ['주기적 DP 교체 (날씨·두께·반응)', '날씨·시즌·반응에 맞춰 수시로 진열 변경', ['주기', '날씨', '교체', '두께', '수시로']],
    ['반품 · 지시 알티로 조절', '창고 공간이 없으면 반품·알티로 재고 조절', ['반품', '알티', '지시']],
    ['공간 한계로 일부만 DP', '공간·고객 동선 때문에 일부만 진열', ['공간', '일부', '천천히', '빽빽']],
    ['공간 여유 있음', '현재 진열에 문제 없음', ['충분히']],
  ],
  free: [
    ['진열 공간 · 창고 부족', '행거·창고 공간이 부족', ['공간', '창고', '행거', '좁']],
    ['물량·배분 방식', '입고 물량·사이즈/컬러 배분 의견', ['물량', '배분', '입고', '초도', '수량']],
    ['이월·재고 소진', '이월/기존 재고 정리·소진', ['이월', '재고', '소진']],
    ['반품·정리 요청', '반품·정리 필요', ['반품', '정리', '제거']],
    ['상품 구성(스타일·사이즈·컬러)', '상품 구성·스타일 중복 의견', ['구성', '스타일', '사이즈', '컬러', '종류', '중복']],
  ],
};
const themed = (key, items) => THEMES[key].map(([label, desc, ps]) => { const res = ps.map(p => new RegExp(p)); return { label, desc, res, hits: items.filter(it => res.some(re => re.test(it.text))) }; }).filter(t => t.hits.length).sort((a, b) => b.hits.length - a.hits.length);
const hl = (text, res) => { let t = esc(text); for (const re of res) t = t.replace(new RegExp(re.source, 'g'), m => `<mark>${m}</mark>`); return t; };

/* ---------- 렌더 ---------- */
const pages = [], tpl = [];
const dash = (inner, cls = '') => pages.push(`<section class="pg dash ${cls}">${inner}</section>`);
const mast = (title, meta) => `<div class="mast"><div><span>KANGOL · ${SEASON} STORE SKU</span><h1>${title}</h1></div><div class="meta">${meta}</div></div>`;
const kp = (v, l, s = '') => `<div class="kp"><small>${l}</small><b>${v}</b>${s ? `<em>${s}</em>` : ''}</div>`;
const imgSrc = no => (imgOf[no] ? (PORTAL ? `${SEASON}/img/${imgOf[no]}` : `../../../상품반응도_26AW/${SEASON}/img/${imgOf[no]}`) : '');
const thumb = no => (imgSrc(no) ? `<img src="${imgSrc(no)}" alt="">` : '<i>-</i>');
const bars = (rows, tone = 'navy') => { const mx = Math.max(1, ...rows.map(r => r.n)); return rows.map(r => `<div class="sr2"><span>${esc(r.label)}</span><div class="bar2"><i style="width:${(r.n / mx) * 100}%;background:${r.color || C[tone]}"></i></div><b>${r.n}곳</b><em>${pct(r.n, r.base ?? N)}</em></div>`).join(''); };

// P1 요약
{
  const cs = CATS.map(c => { const v = D.map(d => d.c[c]).filter(x => x.a != null && x.i != null); return { c, a: avg(v.map(x => x.a)), i: avg(v.map(x => x.i)), md: med(v.map(x => x.a - x.i)), over: v.filter(x => x.a > x.i).length, ok: v.filter(x => x.a === x.i).length, short: v.filter(x => x.a < x.i).length, n: v.length }; });
  const tot = D.map(d => sum(CATS.map(c => d.c[c].a)) - sum(CATS.map(c => d.c[c].i)));
  const overStores = tot.filter(x => x > 0).length;
  const mx = Math.max(1, ...cs.flatMap(x => [x.a, x.i]));
  const dpCard = cs.map(x => `<div class="dpc"><div class="dh"><u style="background:${catColor[x.c]}"></u><b>${x.c}</b><span>중앙값 차이 ${sgn(x.md)}</span></div>
    <div class="sr2"><span>실제 DP</span><div class="bar2"><i style="width:${((x.a || 0) / mx) * 100}%;background:${C.navy}"></i></div><b>${n0(x.a)}</b></div>
    <div class="sr2"><span>적정 DP</span><div class="bar2"><i style="width:${((x.i || 0) / mx) * 100}%;background:${C.steel}"></i></div><b>${n0(x.i)}</b></div></div>`).join('');
  const lvColors = ['#b5524a', '#d8a28f', '#dfe3ea', '#9fb3cf', '#1F3A5C'];
  const opCard = CATS.map(c => { const cnt = LEVELS.map((_, i) => D.filter(d => d.c[c].lv === i + 1).length), t = sum(cnt) || 1; return `<div class="dpc"><div class="dh"><u style="background:${catColor[c]}"></u><b>${c}</b><span>평균 ${f1(avg(D.map(d => d.c[c].lv || null)))} / 5</span></div><div class="stk">${cnt.map((n, i) => n ? `<i style="width:${(n / t) * 100}%;background:${lvColors[i]};color:${i === 2 ? '#3b475c' : '#fff'}">${n}</i>` : '').join('')}</div></div>`; }).join('') + `<div class="lg">${LEVELS.map((l, i) => `<span><u style="background:${lvColors[i]}"></u>${i + 1}) ${l}</span>`).join('')}</div>`;
  const ovCard = cs.map(x => { const t = x.n || 1; return `<div class="dpc"><div class="dh"><u style="background:${catColor[x.c]}"></u><b>${x.c}</b><span>${x.n}개 매장</span></div><div class="stk">${x.over ? `<i style="width:${(x.over / t) * 100}%;background:${C.low}">${x.over}</i>` : ''}${x.ok ? `<i style="width:${(x.ok / t) * 100}%;background:#dfe3ea;color:#3b475c">${x.ok}</i>` : ''}${x.short ? `<i style="width:${(x.short / t) * 100}%;background:${C.warn}">${x.short}</i>` : ''}</div></div>`; }).join('') + `<div class="lg"><span><u style="background:${C.low}"></u>과다(실제>적정)</span><span><u style="background:#dfe3ea"></u>적정</span><span><u style="background:${C.warn}"></u>부족</span></div>`;
  const overRows = OVER.map((l, i) => ({ label: l, n: D.filter(d => d.over === l || (i === 2 && d.over === '기타')).length })), dirRows = DIR.map(l => ({ label: l, n: D.filter(d => d.dir === l).length }));
  const topOver = cs.slice().sort((a, b) => (b.md ?? -9) - (a.md ?? -9))[0];
  const pts = [
    `<div style="border-color:${C.navy}">전체 ${N}개 매장 응답 · 실제 DP가 적정을 넘는 매장 <b>${overStores}곳</b> (${pct(overStores, N)})</div>`,
    topOver && `<div style="border-color:${C.low}"><b>${topOver.c}</b>의 실제−적정 중앙값이 가장 큼 (${sgn(topOver.md)})</div>`,
    dirRows[0].n ? `<div style="border-color:${C.warn}">차이 해소 방향: ${dirRows.slice().sort((a, b) => b.n - a.n)[0].label} <b>${dirRows.slice().sort((a, b) => b.n - a.n)[0].n}곳</b></div>` : '',
    rem[0] ? `<div style="border-color:${C.good}">제거 요청 1위 <b>${esc(rem[0].name)}</b> (${rem[0].n}곳) · 추가 요청 1위 <b>${add[0] ? esc(add[0].name) + ' (' + add[0].n + '곳)' : '-'}</b></div>` : '',
  ].filter(Boolean).join('');
  dash(`${mast('매장 디스플레이 SKU 조사 · 요약', `응답 ${today} 기준<br>제출 ${N} / ${stores.length}개 매장 · DP수는 매장이 입력한 AW 현재 기준`)}
  <div class="kpis">${kp(`${N}<i> / ${stores.length}</i>`, '제출 매장', pct(N, stores.length))}${kp(n0(avg(D.map(d => sum(CATS.map(c => d.c[c].a))))), '매장당 실제 DP', '3개 카테고리 합')}${kp(n0(avg(D.map(d => sum(CATS.map(c => d.c[c].i))))), '매장당 적정 DP', '3개 카테고리 합')}${kp(`${pct(overStores, N)}`, '과다 DP 매장', `${overStores}곳`)}${kp(`${rem.reduce((s, x) => s + x.n, 0)} / ${add.reduce((s, x) => s + x.n, 0)}`, '제거 / 추가 요청', `품번 ${rem.length} / ${add.length}개`)}</div>
  <div class="g6">
   <div class="bx"><h3>카테고리별 DP수 (매장 평균)</h3>${dpCard}</div>
   <div class="bx"><h3>운영 SKU 수에 대한 의견</h3>${opCard}</div>
   <div class="bx"><h3>과다·적정·부족 매장 수</h3>${ovCard}</div>
   <div class="bx"><h3>과다 SKU 운영 실태 <span class="sec">비공개</span></h3><div class="note">매장명 없이 합계만 표시합니다.</div>${bars(overRows, 'navy')}</div>
   <div class="bx"><h3>적정 − 실제 차이에 대한 방향</h3>${bars(dirRows, 'good')}</div>
   <div class="bx"><h3>핵심 포인트</h3><div class="ins">${pts}</div></div>
  </div>`, 'p1');
}

// P2 채널별
{
  const cell = (v) => `<span class="cellv ${v == null ? 'h0' : v > 10 ? 'hl' : v > 0 ? 'hw' : v < -5 ? 'hb' : 'ho'}">${v == null ? '-' : sgn(v)}</span>`;
  const heatRows = (key, labelFn) => key.map(g => { const ds = D.filter(d => g.f(d)); return `<span class="rl">${esc(g.l)} <small>(${ds.length})</small></span>${CATS.map(c => cell(avg(ds.map(d => (d.c[c].a != null && d.c[c].i != null ? d.c[c].a - d.c[c].i : null))))).join('')}`; }).join('');
  const chGroups = CHANNELS.map(ch => ({ l: chLabel(ch), f: d => d.ch === ch }));
  const grGroups = [...new Set(D.map(d => d.ch + '|' + d.grp))].sort().map(k => { const [ch, g] = k.split('|'); return { l: `${chLabel(ch)} · ${g}`, f: d => d.ch === ch && d.grp === g }; });
  const dpTbl = CHANNELS.map(ch => { const ds = D.filter(d => d.ch === ch); return `<tr><td>${chLabel(ch)}</td><td class="n">${ds.length}</td>${CATS.map(c => `<td class="n">${n0(avg(ds.map(d => d.c[c].a)))}</td><td class="n">${n0(avg(ds.map(d => d.c[c].i)))}</td>`).join('')}</tr>`; }).join('');
  const dirBy = CHANNELS.map(ch => { const ds = D.filter(d => d.ch === ch), t = ds.length || 1; return `<div class="dpc"><div class="dh"><b>${chLabel(ch)}</b><span>${ds.length}개 매장</span></div><div class="stk">${DIR.map((l, i) => { const n = ds.filter(d => d.dir === l).length; return n ? `<i style="width:${(n / t) * 100}%;background:${[C.low, C.steel, C.good][i]}">${n}</i>` : ''; }).join('')}</div></div>`; }).join('') + `<div class="lg">${DIR.map((l, i) => `<span><u style="background:${[C.low, C.steel, C.good][i]}"></u>${l}</span>`).join('')}</div>`;
  dash(`${mast('채널별 DP 현황', '평균 차이 = 실제 DP − 적정 DP<br>빨강: 과다 · 파랑: 부족')}
  <div class="g2">
   <div class="bx"><h3>매장형태별 평균 차이 (실제−적정)</h3><div class="hm"><span></span>${CATS.map(c => `<span class="hd">${c}</span>`).join('')}${heatRows(chGroups)}</div>
    <h3 style="margin-top:5mm">채널계열별 평균 차이</h3><div class="hm sm"><span></span>${CATS.map(c => `<span class="hd">${c}</span>`).join('')}${heatRows(grGroups)}</div></div>
   <div class="bx"><h3>매장형태별 평균 DP수 (실제 / 적정)</h3><table><thead><tr><th>구분</th><th class="n">매장</th>${CATS.map(c => `<th class="n">${c} 실제</th><th class="n">${c} 적정</th>`).join('')}</tr></thead><tbody>${dpTbl}</tbody></table>
    <h3 style="margin-top:5mm">차이에 대한 하고 싶은 방향</h3>${dirBy}</div>
  </div>`, 'p2');
}

// P3·P4 제거/추가 요청 품번
function reqPage(title, sub, list, other, kind) {
  const cols = CATS.map(c => {
    const l = list.filter(x => x.cat === c), top = l.slice(0, 10), rest = l.slice(10, 22), mx = Math.max(1, ...l.map(x => x.n));
    const row = x => { const s = sales[x.no], p = byNo[x.no]; return `<div class="rq" data-no="${esc(x.no)}"><div class="th">${thumb(x.no)}</div><div class="rt"><div class="nm"><b>${esc(x.name)}</b>${p && p.price ? `<i class="pv">${n0(p.price)}원</i>` : ''}</div><span>${esc(x.no)}${p ? ' · ' + esc(p.sub) : ''}${s && s.rate != null ? ' · 판매율 ' + Math.round(s.rate * 1000) / 10 + '%' : ''}${other[x.no] ? ` · <u class="x">${kind === 'rem' ? '추가' : '제거'} 요청 ${other[x.no].n}곳도 있음</u>` : ''}</span><div class="bar"><i style="width:${(x.n / mx) * 100}%"></i></div></div><b class="cn">${x.n}곳</b></div>`; };
    return `<div class="bx"><h3><u style="background:${catColor[c]}"></u>${c} <span class="mut">${l.reduce((s, x) => s + x.n, 0)}건 · ${l.length}개 품번</span></h3>${top.map(row).join('') || '<div class="empty">요청 없음</div>'}${rest.length ? `<div class="rest"><small>그 외 요청 품번 ${l.length - 10}개${l.length > 22 ? ' (상위 12개 표시)' : ''}</small><div class="kws">${rest.map(x => `<span class="kw" data-no="${esc(x.no)}">${esc(clip(x.name, 18))} ${x.n}</span>`).join('')}</div></div>` : ''}</div>`;
  }).join('');
  dash(`${mast(title, sub + '<span class="so"><br>품번을 클릭하면 요청한 매장을 볼 수 있습니다</span>')}<div class="g3c">${cols}</div>`, 'p3');
}
reqPage('제거하고 싶은 품번', '요청 매장 수가 많은 순 · 판매율은 허브 판매 데이터 기준', rem, addBy, 'rem');
reqPage('추가로 받고 싶은 품번', '요청 매장 수가 많은 순 · 판매율은 허브 판매 데이터 기준', add, remBy, 'add');

// 품번 상세 템플릿 (클릭 시)
for (const no of new Set([...rem, ...add].map(x => x.no))) {
  const p = byNo[no] || {}, s = sales[no], r = remBy[no], a = addBy[no], nm = (r || a).name;
  const stList = (x, label, color) => x ? `<div class="dbox"><h4 style="color:${color}">${label} ${x.n}개 매장</h4><table class="bt"><thead><tr><th>매장</th><th>채널</th></tr></thead><tbody>${[...x.stores.entries()].sort((u, v) => CHANNELS.indexOf(u[1]) - CHANNELS.indexOf(v[1]) || u[0].localeCompare(v[0], 'ko')).map(([st, ch]) => `<tr><td>${esc(st)}</td><td>${chLabel(ch)}</td></tr>`).join('')}</tbody></table></div>` : '';
  tpl.push(`<template id="d-${esc(no)}"><div class="dd"><div class="dh2"><div class="dimg">${imgSrc(no) ? `<img src="${imgSrc(no)}" alt="">` : '<span>이미지 없음</span>'}</div><div><div class="dcat"><u style="background:${catColor[(r || a).cat] || C.navy}"></u>${esc((r || a).cat)}${p.sub ? ' · ' + esc(p.sub) : ''}</div><h2>${esc(nm)}</h2><div class="dm"><span class="tag">${esc(no)}</span>${p.price ? `<span class="tag">판매가 ${n0(p.price)}원</span>` : ''}${s ? `<span class="tag">입고 ${n0(s.inbound)} · 판매 ${n0(s.sales)} · 판매율 ${s.rate != null ? Math.round(s.rate * 1000) / 10 + '%' : '-'}</span>` : '<span class="tag c">판매 데이터 없음</span>'}</div></div></div><div class="bgrid">${stList(r, '제거 요청', C.low)}${stList(a, '추가 요청', C.good)}</div></div></template>`);
}

// P5 운영 실태(기타 입력) · 자유 의견
{
  const others = D.filter(d => d.other.trim()).map(d => ({ store: d.store, ch: d.ch, text: d.other.trim() }));
  const frees = D.filter(d => d.free).map(d => ({ store: d.store, ch: d.ch, text: d.free }));
  const block = (id, title, items, key, anon) => {
    const th = themed(key, items), top = th.slice(0, 6), mx = Math.max(1, ...top.map(t => t.hits.length));
    const rowT = x => `<tr>${anon ? '' : `<td class="nw">${esc(x.store)}</td><td class="nw">${chLabel(x.ch)}</td>`}<td>__T__</td></tr>`;
    const tbl = list => `<table class="bt"><thead><tr>${anon ? '' : '<th>매장</th><th>채널</th>'}<th>의견</th></tr></thead><tbody>${list.join('')}</tbody></table>`;
    th.forEach((t, i) => tpl.push(`<template id="s-${id}-${i}"><div class="dd"><div class="dcat">${title}</div><h2>${esc(t.label)}</h2><div class="dm"><span class="tag g">${t.hits.length}개 매장 언급</span></div><p class="dsay">${esc(t.desc)}</p><div class="dbox">${tbl(t.hits.map(x => rowT(x).replace('__T__', hl(x.text, t.res))))}</div></div></template>`));
    tpl.push(`<template id="s-${id}-all"><div class="dd"><div class="dcat">${title}</div><h2>전체 의견 (${items.length}건${anon ? ', 매장명 비공개' : ''})</h2><div class="dbox">${tbl(items.map(x => rowT(x).replace('__T__', esc(x.text))))}</div></div></template>`);
    return `<div class="bx"><h3 class="sbh"><span>${title} <span class="mut">${items.length}개 매장 작성</span></span>${items.length ? `<span class="sall" data-sop="${id}-all">전체 보기 ›</span>` : ''}</h3>${items.length ? (top.length ? `<p class="sbsum">${top.slice(0, 3).map(t => `<b>${esc(t.label)}</b>(${t.hits.length}곳)`).join(', ')} 순으로 많이 언급됐습니다.</p>` : '') + top.map((t, i) => `<div class="sth" data-sop="${id}-${i}"><span class="sl">${esc(t.label)}</span><div class="bar"><i style="width:${(t.hits.length / mx) * 100}%"></i></div><b>${t.hits.length}곳</b><small>${esc(t.desc)}</small></div>`).join('') : '<div class="empty">아직 작성된 의견이 없습니다.</div>'}</div>`;
  };
  dash(`${mast('운영 실태와 자유 의견', '주제를 클릭하면 의견 상세가 열립니다<span class="so"></span>')}<div class="g2">${block('o', '과다 SKU 운영 방식 (기타 입력) · 비공개', others, 'other', true)}${block('f', 'SKU 관련 하고 싶은 말씀', frees, 'free', false)}</div>`, 'p5');
}

// 매장별 DP 현황 표 (여러 페이지로 이어짐)
{
  const ds = D.slice().sort((a, b) => CHANNELS.indexOf(a.ch) - CHANNELS.indexOf(b.ch) || a.grp.localeCompare(b.grp, 'ko') || a.store.localeCompare(b.store, 'ko'));
  const dc = v => `<td class="n ${v == null ? '' : v > 10 ? 'low' : v > 0 ? 'warn' : v < 0 ? 'blu' : ''}">${sgn(v)}</td>`;
  const body = ds.map(d => `<tr><td class="nw">${esc(d.store)}</td><td class="nw">${chLabel(d.ch)}</td>${CATS.map(c => `<td class="n">${n0(d.c[c].a)}</td><td class="n">${n0(d.c[c].i)}</td>${dc(d.c[c].a != null && d.c[c].i != null ? d.c[c].a - d.c[c].i : null)}`).join('')}<td class="nw">${CATS.map(c => d.c[c].lv ? `${c[0]}${d.c[c].lv}` : '').filter(Boolean).join(' ')}</td><td class="nw">${esc(d.dir.replace(/\(.*\)/, ''))}</td><td class="n">${d.r['제거요청수'] || 0}</td><td class="n">${d.r['추가요청수'] || 0}</td></tr>`).join('');
  pages.push(`<section class="pg flow"><h2>매장별 DP 현황</h2><div class="sub">차이 = 실제 − 적정 (10 초과 빨강, 0 초과 주황, 음수 파랑) · 의견 1~5 = 너무 많다 ~ 너무 모자르다 · 과다 SKU 운영 실태(3번)는 비공개라서 표시하지 않습니다</div><table class="allp"><thead><tr><th rowspan="2">매장</th><th rowspan="2">채널</th>${CATS.map(c => `<th colspan="3" class="c">${c}</th>`).join('')}<th rowspan="2">의견</th><th rowspan="2">방향</th><th rowspan="2" class="n">제거</th><th rowspan="2" class="n">추가</th></tr><tr>${CATS.map(() => '<th class="n">실제</th><th class="n">적정</th><th class="n">차이</th>').join('')}</tr></thead><tbody>${body}</tbody></table></section>`);
}

/* ---------- HTML ---------- */
const css = `
:root{--ink:#1c2230;--mut:#6b7385;--line:#e6e8ec;--navy:#1F3A5C;--navy2:#16283F;--gold:#D9C68C;--bg:#F2F2F2;--lowbg:#f2dcd9;--lowfg:#8a2a22;--warnbg:#f4e8c8;--warnfg:#6b5010;--okbg:#e3e8f0;--okfg:#1F3A5C;--blubg:#d9e3f3;--blufg:#1c3f8c}
*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:'Noto Sans KR','Noto Sans','Malgun Gothic',sans-serif;color:var(--ink);font-size:8.5pt;line-height:1.4;background:var(--bg)}
.pg{width:297mm;min-height:210mm;margin:8mm auto;padding:8mm 8mm 12mm;background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.15)}
.pg.dash{height:210mm;overflow:hidden;display:flex;flex-direction:column;gap:3.2mm}
h2{margin:0 0 3mm;font-size:14pt;color:var(--navy);border-bottom:1.5pt solid var(--navy);padding-bottom:2mm}
h3{margin:0 0 1.8mm;font-size:9.5pt;font-weight:700;color:var(--navy2)}
.mut{color:var(--mut);font-weight:400}.sub{color:var(--mut);margin:0 0 3mm}
.mast{background:var(--navy2);color:#fff;border-radius:2mm;padding:4mm 6mm;display:flex;justify-content:space-between;align-items:flex-end;gap:6mm}
.mast span{display:block;font-size:7.5pt;letter-spacing:.12em;color:var(--gold);font-weight:500}.mast h1{margin:1mm 0 0;font-size:17pt;font-weight:700}
.mast .meta{font-size:7.5pt;color:#c6d0df;text-align:right;line-height:1.5}.mast .so{display:inline;color:var(--gold)}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:2.6mm}
.kp{border:.5pt solid var(--line);border-radius:1.6mm;padding:2mm 3mm}.kp small{display:block;font-size:7.2pt;color:var(--mut)}.kp b{display:inline-block;font-size:16pt;font-weight:700;font-variant-numeric:tabular-nums;color:var(--navy2);line-height:1.2}.kp b i{font-style:normal;font-size:10pt;color:var(--mut);font-weight:400}.kp em{display:block;font-style:normal;font-size:6.9pt;color:var(--mut)}
.g6{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:3.2mm;flex:1;min-height:0}.g2{display:grid;grid-template-columns:1fr 1fr;gap:3.2mm;flex:1;min-height:0}.g3c{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3.2mm;flex:1;min-height:0}
.bx{border:.5pt solid var(--line);border-radius:1.6mm;padding:3mm 3.5mm;min-width:0;overflow:hidden}.bx h3 u{display:inline-block;width:2.4mm;height:2.4mm;border-radius:50%;margin-right:1.4mm}
.note{font-size:7.5pt;color:var(--mut);margin-bottom:1.6mm}.sec{display:inline-block;font-size:6.8pt;font-weight:700;color:var(--lowfg);border:.5pt solid var(--lowfg);border-radius:9pt;padding:0 1.6mm;margin-left:1mm;vertical-align:.4mm}
.dpc{margin-bottom:2.2mm}.dh{display:flex;align-items:center;gap:1.4mm;margin-bottom:.8mm;font-size:8pt}.dh u{display:inline-block;width:2.2mm;height:2.2mm;border-radius:50%}.dh span{margin-left:auto;color:var(--mut);font-size:7pt}
.sr2{display:grid;grid-template-columns:24mm 1fr 11mm 9mm;gap:1.8mm;align-items:center;font-size:7.8pt;margin-bottom:1.2mm}.sr2 b{text-align:right;font-weight:700;font-variant-numeric:tabular-nums}.sr2 em{font-style:normal;color:var(--mut);font-size:7pt;text-align:right}
.dpc .sr2{grid-template-columns:14mm 1fr 10mm}
.bar2{position:relative;height:3mm;background:#f1f3f7;border-radius:1mm;overflow:hidden}.bar2 i{position:absolute;left:0;top:0;bottom:0;border-radius:1mm}
.stk{display:flex;height:5mm;border-radius:1mm;overflow:hidden;background:#f1f3f7}.stk i{display:grid;place-items:center;font-style:normal;font-size:7pt;font-weight:700;color:#fff;min-width:3mm}
.lg{display:flex;flex-wrap:wrap;gap:1mm 3mm;font-size:6.8pt;color:var(--mut);margin-top:1.4mm}.lg u{display:inline-block;width:2mm;height:2mm;border-radius:.5mm;margin-right:1mm;vertical-align:-.2mm}
.ins{display:grid;gap:2mm;font-size:8.2pt}.ins div{border-left:1mm solid var(--navy);padding:.4mm 0 .4mm 2.4mm}
.hm{display:grid;grid-template-columns:34mm repeat(3,1fr);gap:1mm;font-size:8.5pt;text-align:center}.hm.sm{font-size:8pt}.hm .hd{color:var(--mut);font-size:7.5pt;padding:.6mm 0}.hm .rl{text-align:left;color:var(--ink);font-size:7.8pt;padding:1.4mm 0}.hm .rl small{color:var(--mut)}
.cellv{display:block;padding:1.4mm 0;border-radius:1mm;font-variant-numeric:tabular-nums;font-weight:700}
.h0{background:#f1f3f7;color:#9aa0ab}.hl{background:var(--lowbg);color:var(--lowfg)}.hw{background:var(--warnbg);color:var(--warnfg)}.ho{background:var(--okbg);color:var(--okfg)}.hb{background:var(--blubg);color:var(--blufg)}
.rq{display:grid;grid-template-columns:9.5mm 1fr 9mm;gap:2mm;align-items:center;padding:.9mm 0;border-top:.5pt solid #f0f1f4;cursor:pointer}.rq:hover{background:#f7f8fb}
.th{width:9.5mm;height:11mm;border:.5pt solid var(--line);display:grid;place-items:center;overflow:hidden}.th img{width:100%;height:100%;object-fit:contain}.th i{font-size:6pt;color:#b0b5c0;font-style:normal}
.rt{min-width:0}.rt span{display:block;font-size:6.8pt;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rt .x{text-decoration:none;color:var(--lowfg)}
.nm{display:flex;align-items:baseline;gap:1.6mm;min-width:0}.nm b{flex:0 1 auto;min-width:0;display:block;font-size:8pt;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nm .pv{flex:none;font-style:normal;font-size:7.4pt;color:var(--navy);font-weight:500}
.bar{height:1.8mm;background:#f1f3f7;border-radius:1mm;margin-top:.5mm}.bar i{display:block;height:100%;background:var(--navy);border-radius:1mm;opacity:.75}.cn{text-align:right;font-size:8pt;font-variant-numeric:tabular-nums}
.rest{margin-top:2mm;border-top:.5pt solid #f0f1f4;padding-top:1.6mm}.rest small{font-size:7.2pt;color:var(--mut)}.kws{display:flex;flex-wrap:wrap;gap:.8mm 1mm}.kw{font-size:7pt;padding:.3mm 1.8mm;border-radius:2mm;background:#eef1f6;color:#3b475c;cursor:pointer}.kw:hover{background:#dfe6ef}
.empty{color:#9aa0ab;font-size:7.8pt;padding:2mm 0}
.sbh{display:flex;justify-content:space-between;align-items:baseline}.sall{font-size:7.6pt;color:var(--navy);font-weight:400;cursor:pointer}.sbsum{margin:0 0 1.6mm;font-size:8pt;color:#3b475c}
.sth{display:grid;grid-template-columns:44mm 1fr 10mm;gap:.4mm 2.4mm;align-items:center;padding:.5mm 0;font-size:8pt;cursor:pointer}.sth:hover{background:#f7f8fb}.sth .sl{font-weight:700;color:var(--navy2)}.sth b{text-align:right;font-weight:500}.sth small{grid-column:1/4;color:var(--mut);font-size:7pt;margin-top:-.4mm}
mark{background:#fbe8a8;color:inherit;padding:0 .3mm}
table{width:100%;border-collapse:collapse;font-size:8pt}th,td{border:.5pt solid var(--line);padding:1.2mm 1.6mm;text-align:left;vertical-align:top}th{background:#eef1f6;font-weight:700}th.c{text-align:center}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.nw{white-space:nowrap}
tr{break-inside:avoid}thead{display:table-header-group}table.allp{font-size:7.6pt}table.allp td{padding:.7mm 1.4mm}
td.low{background:var(--lowbg);color:var(--lowfg);font-weight:700}td.warn{background:var(--warnbg);color:var(--warnfg);font-weight:700}td.blu{background:var(--blubg);color:var(--blufg);font-weight:700}
.dpc.x{}
.modal{position:fixed;inset:0;background:rgba(15,25,40,.55);display:grid;place-items:center;z-index:50;padding:16px}.modal[hidden]{display:none}
.mp{background:#fff;border-radius:10px;max-width:900px;width:100%;max-height:92vh;overflow:auto;padding:22px 26px;position:relative;font-size:13px;line-height:1.5}
.mx{position:absolute;top:10px;right:14px;border:0;background:none;font-size:26px;line-height:1;color:#6b7385;cursor:pointer}
.dd h2{border:0;margin:2px 0 6px;font-size:20px;color:var(--navy2);padding:0}.dcat{font-size:12px;color:var(--mut)}.dcat u{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.dh2{display:grid;grid-template-columns:200px 1fr;gap:18px;margin-bottom:14px}.dimg{aspect-ratio:4/3;border:1px solid var(--line);border-radius:8px;display:grid;place-items:center;overflow:hidden;color:#9aa0ab}.dimg img{width:100%;height:100%;object-fit:contain}
.dm{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.tag{font-size:12px;padding:2px 10px;border-radius:99px;background:#eef1f6;color:var(--navy2);font-weight:500}.tag.g{background:var(--navy2);color:#fff}.tag.c{background:none;border:1px solid var(--line);color:var(--mut)}
.bgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.dbox{border:1px solid var(--line);border-radius:8px;padding:12px 14px}.dbox h4{margin:0 0 6px;font-size:13px}.dsay{margin:0 0 8px}.bt{font-size:12px}.bt td{overflow-wrap:anywhere}
@media (max-width:760px){.dh2,.bgrid{grid-template-columns:1fr}}
@page dash{size:A4 landscape;margin:0}@page flow{size:A4 landscape;margin:8mm 8mm 12mm}.pg.dash{page:dash}.pg.flow{page:flow}
@media print{.modal,template{display:none!important}.so{display:none}.rq,.sth,.sall,.kw{cursor:auto}body{background:#fff}.pg{width:297mm;min-height:210mm;margin:0;box-shadow:none;break-after:page}.pg:last-child{break-after:auto}.pg.dash{height:210mm}.pg.flow{width:auto;min-height:0;padding:0}}
`;
const fontLink = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&family=Noto+Sans:wght@400;500;700&display=swap">';
const modalHtml = `<div class="modal" id="modal" hidden><div class="mp"><button class="mx" type="button" aria-label="닫기">×</button><div id="mbody"></div></div></div>${tpl.join('')}<script>(function(){var m=document.getElementById('modal'),b=document.getElementById('mbody');function close(){m.hidden=true;document.body.style.overflow=''}document.addEventListener('click',function(e){var it=e.target.closest('[data-no],[data-sop]');if(it){var id=it.hasAttribute('data-no')?'d-'+it.getAttribute('data-no'):'s-'+it.getAttribute('data-sop');var t=document.getElementById(id);if(t){b.innerHTML=t.innerHTML;m.hidden=false;document.body.style.overflow='hidden';m.querySelector('.mp').scrollTop=0}return}if(e.target===m||e.target.closest('.mx'))close()});document.addEventListener('keydown',function(e){if(e.key==='Escape')close()})})();<\/script>`;
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${SEASON} 매장 SKU 조사 리포트</title>${fontLink}<style>${css}</style></head><body>${pages.join('\n')}${modalHtml}</body></html>`;

const outDir = join(ROOT, 'reports', SEASON); mkdirSync(outDir, { recursive: true });
const out = join(outDir, `SKU리포트_${today}.html`);
writeFileSync(out, html);
console.log(`리포트 생성: ${out}\n  제출 ${N}/${stores.length}개 매장 · 제거 요청 ${RM.length}건(${rem.length}개 품번) · 추가 요청 ${AD.length}건(${add.length}개 품번)`);

if (PORTAL) {
  const pwFile = join(ROOT, 'reports', 'portal-password.txt'), other = join(ROOT, '..', '상품반응도_26AW', 'reports', 'portal-password.txt');
  let pw = arg('password', existsSync(pwFile) ? readFileSync(pwFile, 'utf8').trim() : existsSync(other) ? readFileSync(other, 'utf8').trim() : '');
  if (!pw) { console.error('비밀번호가 없습니다. --password 를 지정하세요.'); process.exit(1); }
  mkdirSync(dirname(pwFile), { recursive: true }); writeFileSync(pwFile, pw);
  const salt = randomBytes(16), iv = randomBytes(12), iter = 200000, key = pbkdf2Sync(pw, salt, iter, 32, 'sha256'), cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(gzipSync(Buffer.from(html, 'utf8'))), cipher.final(), cipher.getAuthTag()]);
  const dirP = join(ROOT, 'report'); mkdirSync(dirP, { recursive: true });
  writeFileSync(join(dirP, 'report.enc.json'), JSON.stringify({ v: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iter, gz: true, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') }));
  writeFileSync(join(dirP, 'report.meta.json'), JSON.stringify({ updated: today, season: SEASON }));
  console.log(`포털용 암호화 리포트 저장: report/report.enc.json (${(ct.length / 1024).toFixed(0)}KB)`);
}
