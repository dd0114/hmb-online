#!/usr/bin/env node
// 대조 시트 생성 (#104 P1) — 원본 vs 산출 3형태를 나란히. hero 승인 게이트용.
//   node design/characters/pipeline/sheet.mjs
// 산출: design/characters/contact-sheet.html (브라우저로 열기)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanIncoming, AVATAR_LADDER, SPRITE_LADDER, TEAM_RING } from './ingest.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const OUT = path.join(ROOT, 'out');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const reports = fs.existsSync(path.join(OUT, 'index.json'))
  ? JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8'))
  : [];
const incoming = scanIncoming();

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// 사다리는 "같은 표시 크기"로 나란히 봐야 간소화 정도가 비교된다(ref-1·ref-3 가 그렇게 보여준다).
const LADDER_PX = 112, RING_PX = 84;

const section = (r) => {
  const f = incoming[r.id] || {};
  const av = AVATAR_LADDER.map((st) => `
    <figure><img src="out/${r.id}/avatar-${st.size}.png" style="width:${LADDER_PX}px">
      <figcaption><b>${st.size}px</b><br>${esc(st.label)}</figcaption></figure>`).join('');
  const rings = AVATAR_LADDER.map((st) => Object.keys(TEAM_RING).map((t) => `
    <figure><img src="out/${r.id}/avatar-${st.size}-${t}.png" style="width:${RING_PX}px">
      <figcaption>${st.size} ${t}</figcaption></figure>`).join('')).join('');
  const sp = SPRITE_LADDER.map((st) => `
    <figure><img src="out/${r.id}/sprite-${st.size}.png" style="width:${LADDER_PX}px">
      <figcaption><b>${st.size}px</b><br>${esc(st.label)}</figcaption></figure>`).join('');

  return `
<section>
  <h2>${esc(r.meta.name)} <span class="id">${esc(r.id)}</span>
    <span class="pos ${esc(r.meta.position)}">${esc(r.meta.position)}</span>
    <span class="sig" style="background:${esc(r.meta.signatureResolved || '#666')}"></span>
    <small>signature ${esc(r.meta.signatureResolved || '-')}</small></h2>
  ${r.warnings.length ? `<p class="warn">⚠ ${r.warnings.map(esc).join(' · ')}</p>` : ''}
  <div class="cols">
    <div class="col">
      <h3>원본 입고</h3>
      <div class="row">
        ${f.portrait ? `<figure><img src="${esc(rel(f.portrait))}" class="orig"><figcaption>portrait</figcaption></figure>` : ''}
        ${f.full ? `<figure><img src="${esc(rel(f.full))}" class="orig"><figcaption>full</figcaption></figure>` : ''}
      </div>
    </div>
    <div class="col">
      <h3>아바타 사다리 <small>(ref-1)</small></h3>
      <div class="row">${av}</div>
      <h3>팀 링 적용</h3>
      <div class="row">${rings}</div>
    </div>
    <div class="col">
      <h3>스프라이트 간소화 <small>(ref-3)</small></h3>
      <div class="row">${sp}</div>
    </div>
    <div class="col">
      <h3>카드 <small>(ref-2, 226×425)</small></h3>
      <div class="cardwrap">
        <img src="out/${r.id}/card.png" class="card">
        <div class="cname">${esc(r.meta.title)} <b>${esc(r.meta.name)}</b></div>
        <div class="cdesc">${esc(r.meta.desc)}</div>
      </div>
      <p class="note">텍스트는 게임 UI 오버레이(파이프라인은 프레임·아트·별까지)</p>
    </div>
  </div>
</section>`;
};

const html = `<!doctype html><meta charset="utf-8"><title>캐릭터 인테이크 대조 시트 — #104</title>
<style>
:root{--bg:#0b1117;--surf:#111a1c;--surf2:#1a2023;--text:#e0d8cf;--muted:#7f7e79;--gold:#e4991c}
body{margin:0;padding:28px;background:var(--bg);color:var(--text);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif}
h1{margin:0 0 4px;font-size:22px;color:#f8e8a0}
.lead{color:var(--muted);margin:0 0 24px}
section{background:var(--surf);border:1px solid #22303a;border-radius:10px;padding:18px;margin-bottom:20px}
h2{margin:0 0 12px;font-size:18px;display:flex;align-items:center;gap:10px}
h2 .id{font-size:12px;color:var(--muted);font-weight:400}
h3{margin:0 0 8px;font-size:12px;color:var(--gold);text-transform:uppercase;letter-spacing:.06em}
h3 small{color:var(--muted);text-transform:none;letter-spacing:0}
.pos{font-size:11px;padding:2px 8px;border-radius:4px;background:#222;border:1px solid var(--gold)}
.pos.FW{color:#f17869}.pos.MF{color:#57b775}.pos.DF{color:#0b90d8}.pos.GK{color:#fce148}
.sig{width:14px;height:14px;border-radius:3px;display:inline-block;border:1px solid #0006}
h2 small{font-size:11px;color:var(--muted);font-weight:400}
.warn{color:#f1b499;background:#210e0b;padding:6px 10px;border-radius:6px;font-size:12px}
.cols{display:flex;gap:22px;flex-wrap:wrap}
.col{min-width:160px}
.row{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px}
figure{margin:0;text-align:center}
figure img{image-rendering:pixelated;display:block}
figcaption{font-size:10px;color:var(--muted);margin-top:6px;max-width:112px;line-height:1.35}
figcaption b{color:var(--text)}
img.orig{max-width:150px;max-height:230px;background:#0006;border:1px solid #2a3640;border-radius:4px}
img.card{width:226px;border-radius:6px;display:block;image-rendering:pixelated}
/* 카드 밴드 좌표 = card.mjs 의 CARD 상수와 동일(226×425, inset 10) */
.cardwrap{position:relative;width:226px}
.cname{position:absolute;left:10px;right:10px;top:334px;height:26px;line-height:26px;
  text-align:center;font-size:12px;color:#f8e8a0;pointer-events:none;overflow:hidden}
/* 설명은 설명판(386..415) 안에 가둔다 — 넘치면 잘라낸다(프레임 밖으로 새면 안 됨) */
.cdesc{position:absolute;left:46px;right:12px;top:389px;height:24px;overflow:hidden;
  font-size:9px;color:#a7a090;text-align:left;line-height:1.35;pointer-events:none}
.note{font-size:10px;color:var(--muted);margin:8px 0 0;max-width:226px}
footer{color:var(--muted);font-size:12px;margin-top:8px}
</style>
<h1>캐릭터 인테이크 대조 시트</h1>
<p class="lead">원본 입고 이미지 vs 파이프라인 산출 3형태(아바타·카드·스프라이트). 규격 근거 = refs/ref-1·2·3 + SPEC.md.
  <b>판정 = hero</b> (#104 게이트) — 자동 도트화 품질이 충분한가 / '픽셀아트 직접 생성'으로 확정할 것인가.</p>
${reports.map(section).join('\n')}
<footer>생성: node design/characters/pipeline/sheet.mjs · 대상 ${reports.length}종 · 결정론(같은 입력 = 같은 산출)</footer>
`;

fs.writeFileSync(path.join(ROOT, 'contact-sheet.html'), html);
console.log(`✓ contact-sheet.html (${reports.length}종) — open design/characters/contact-sheet.html`);
