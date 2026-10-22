// 설문 페이지에 '이전 제출 내용 불러오기'(공통 규칙)를 넣습니다. 새 설문도 같은 블록을 넣으세요. 사용: node scripts/patch_prefill_client.mjs
import fs from 'node:fs';

const COMMON = `
/* ---------- 이전 제출 불러오기 (공통 규칙): 이 기기에서 제출한 매장의 제출ID 로만 서버에서 불러옴 ---------- */
const LKEY=DKEY+'-last';
function lastMap(){try{return JSON.parse(localStorage.getItem(LKEY)||'{}')}catch(e){return{}}}
function rememberSid(store,sid){try{const m=lastMap();m[store]=sid;localStorage.setItem(LKEY,JSON.stringify(m))}catch(e){}}
function prevSid(){return CFG.endpoint&&st.store.name?lastMap()[st.store.name]:''}
async function loadPrev(auto){
  const sid=prevSid();if(!sid)return false;
  try{const r=await fetch(CFG.endpoint+(CFG.endpoint.indexOf('?')>=0?'&':'?')+'action=load&token='+encodeURIComponent(sid));const j=await r.json();
    if(j&&j.ok&&j.data){applyPrev(j.data);ui.sent=null;ui.loaded=st.store.name;ui.canPrev=false;save();render();toast('이전에 제출한 내용을 불러왔습니다. 수정 후 다시 제출하면 덮어씁니다.');return true}}catch(e){}
  if(!auto)toast('이전 제출 내용을 불러오지 못했습니다.');return false}
function offerPrev(){if(!prevSid()||ui.loaded===st.store.name)return;if(isBlank())loadPrev(true);else{ui.canPrev=true;render()}}
function prevNotice(){return (ui.canPrev&&st.store.name&&prevSid()&&ui.loaded!==st.store.name)?'<div class="card"><div><b>이 기기에서 이전에 제출한 기록이 있습니다.</b></div><div class="sub">불러오면 지금 입력한 내용이 이전 제출 내용으로 바뀝니다. 수정 후 다시 제출하면 이전 응답을 덮어씁니다.</div><button type="button" class="btn" data-loadprev="1">이전 제출 내용 불러오기</button></div>':''}
`;

const SPECIFIC = {
  '매장SKU조사/26AW/index.html': `
function applyPrev(d){const o=blank();o.store=Object.assign({},d.store);CATS.forEach(c=>{o.sku[c]=Object.assign({},(d.sku||{})[c]);const g=rows=>{const a=(rows||[]).filter(x=>x.cat===c).map(x=>({no:x.no,q:''}));while(a.length<INITN)a.push({no:'',q:''});return a};o.remove[c]=g(d.remove);o.add[c]=g(d.add)});o.opinion=Object.assign({},d.opinion);o.over=Object.assign({},d.over);o.dir=d.dir||'';o.free=d.free||'';st=o}
function isBlank(){return CATS.every(c=>{const v=st.sku[c]||{};return(v.actual===undefined||v.actual==='')&&(v.ideal===undefined||v.ideal==='')})&&!Object.keys(st.opinion||{}).some(k=>st.opinion[k])&&!(st.over&&st.over.choice)&&!st.dir&&!(st.free||'').trim()&&CATS.every(c=>!chosen(c,'remove').length&&!chosen(c,'add').length)}
`,
  '상품반응도_26AW/26AW/index.html': `
function applyPrev(d){const o=blank();o.store=Object.assign({},d.store);o.season=Object.assign({},d.seasonQ);(d.products||[]).forEach(p=>{const v={};if(p.design)v.design=p.design;if(p.price_score)v.price=p.price_score;if(p.comment)v.comment=p.comment;o.products[p.no]=v});(d.prices||[]).forEach(p=>{o.prices[p.sub]={min:p.min||undefined,max:p.max||undefined,vsCur:p.vsCur||undefined,vsComp:p.vsComp||undefined,note:p.note||undefined}});const idx={};(d.comps||[]).forEach(c=>{const g=c.grp,i=idx[g]=(idx[g]===undefined?0:idx[g]+1);(o.comps[g]=o.comps[g]||{})[i]={brand:c.brand,range:c.range,strength:c.strength,promo:c.promo,reaction:c.reaction}});o.extra=d.extra||'';st=o}
function isBlank(){return !Object.keys(st.products||{}).length&&!Object.keys(st.season||{}).some(k=>st.season[k])&&!Object.keys(st.prices||{}).length&&!Object.keys(st.comps||{}).length&&!(st.extra||'').trim()}
`,
};

for (const [f, spec] of Object.entries(SPECIFIC)) {
  let s = fs.readFileSync(f, 'utf8');
  if (s.includes('loadPrev')) { console.log('이미 적용됨:', f); continue; }
  const rep = (a, b) => { if (!s.includes(a)) { console.log('MISS', f, a.slice(0, 60)); return; } s = s.replace(a, () => b); };
  // 코드 블록 삽입 (ui 선언 다음 줄)
  const m = s.match(/^let ui=\{[^\n]*\};$/m); if (!m) { console.log('ui 선언을 찾지 못함', f); continue; }
  s = s.replace(m[0], () => m[0] + '\n' + COMMON + spec);
  // 매장 선택 직후 안내/자동 불러오기, 매장 변경 시 상태 초기화
  rep("if(id==='sel_name'){st.store.name=v;save();render()}", "if(id==='sel_name'){st.store.name=v;ui.canPrev=false;save();render();offerPrev()}");
  rep("if(id==='sel_type'){st.store={type:v};save();render()}", "if(id==='sel_type'){st.store={type:v};ui.canPrev=false;ui.loaded=null;save();render()}");
  rep("if(id==='sel_group'){st.store={type:st.store.type,group:v};save();render()}", "if(id==='sel_group'){st.store={type:st.store.type,group:v};ui.canPrev=false;ui.loaded=null;save();render()}");
  // 매장 선택 화면 하단 안내 카드
  rep("${s.name?'':'<div class=\"sub\">매장을 선택해야 다음 단계로 넘어갈 수 있습니다.</div>'}</div>`}", "${s.name?'':'<div class=\"sub\">매장을 선택해야 다음 단계로 넘어갈 수 있습니다.</div>'}</div>${prevNotice()}`}");
  // 버튼 처리 + 제출 성공 시 제출ID 기억
  rep("if(d.again){", "if(d.loadprev){loadPrev(false);return}\n  if(d.again){");
  rep("ui.sent=payload.store.name;clearTimeout(saveT);", "ui.sent=payload.store.name;if(CFG.endpoint)rememberSid(payload.store.name,payload.sid);clearTimeout(saveT);");
  // 시작할 때 임시저장에서 복원된 매장이 있으면 안내
  rep("   render()})", "   render();offerPrev()})");
  fs.writeFileSync(f, s);
  console.log('적용:', f, s.includes('loadPrev(false)'));
}
