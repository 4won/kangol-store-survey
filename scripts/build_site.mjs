// 사이트 조립 (GitHub Actions 가 실행): 각 조사 폴더의 survey.json 을 읽어
//   · 설문 페이지  {조사폴더}/{site}      → _site/{sitePath}/
//   · 암호화 리포트 {조사폴더}/{report}/report.enc.json → _site/reports/{slug}.json
//   · 포털 목록    _site/surveys.json  (루트 index.html 의 탭이 이 목록으로 자동 생성됨)
// 새 조사를 추가하려면: 폴더를 만들고 survey.json 만 넣으면 포털에 탭이 하나 생깁니다.
//   survey.json: { slug, title, order, status, desc, site(설문 폴더명), sitePath(배포 경로), report(리포트 폴더명 또는 null) }
// 로컬 확인: node scripts/build_site.mjs  → _site/ 생성
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), OUT = join(ROOT, '_site');
rmSync(OUT, { recursive: true, force: true }); mkdirSync(join(OUT, 'reports'), { recursive: true });
cpSync(join(ROOT, 'index.html'), join(OUT, 'index.html'));

const surveys = [];
for (const dir of readdirSync(ROOT)) {
  if (dir.startsWith('.') || dir === '_site' || dir === 'node_modules' || dir === 'scripts') continue;
  const base = join(ROOT, dir);
  if (!statSync(base).isDirectory() || !existsSync(join(base, 'survey.json'))) continue;
  const m = JSON.parse(readFileSync(join(base, 'survey.json'), 'utf8'));
  if (m.site && existsSync(join(base, m.site))) cpSync(join(base, m.site), join(OUT, m.sitePath || m.site), { recursive: true });
  else console.warn('! 설문 폴더 없음:', dir, m.site);
  let report = null, updated = '';
  if (m.report && existsSync(join(base, m.report, 'report.enc.json'))) {
    cpSync(join(base, m.report, 'report.enc.json'), join(OUT, 'reports', m.slug + '.json'));
    report = `reports/${m.slug}.json`;
    try { updated = JSON.parse(readFileSync(join(base, m.report, 'report.meta.json'), 'utf8')).updated || ''; } catch { /* 메타 없음 */ }
  }
  surveys.push({ slug: m.slug, title: m.title, order: m.order ?? 99, status: m.status || '', desc: m.desc || '', surveyPath: (m.sitePath || m.site) + '/', report, updated });
}
surveys.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'ko'));
writeFileSync(join(OUT, 'surveys.json'), JSON.stringify(surveys));
writeFileSync(join(OUT, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
writeFileSync(join(OUT, '.nojekyll'), '');
console.log('사이트 조립 완료:', surveys.map(s => `${s.title}(${s.surveyPath}${s.report ? ', 리포트' : ''})`).join(' · '));
