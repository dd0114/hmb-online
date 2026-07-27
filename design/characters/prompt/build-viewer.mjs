#!/usr/bin/env node
// 프롬프트 문서 뷰어 빌더 — 이 폴더의 .md 를 탭 하나짜리 자립 HTML 로 굽는다.
//   node design/characters/prompt/build-viewer.mjs && open design/characters/prompt/prompt-docs.html
//
// 왜 생성기인가: HTML 에 본문을 복붙하면 .md 가 SoT 인데 사본이 조용히 낡는다.
// .md 만 고치고 다시 굽는다. 외부 의존 0·난수 0 → 같은 입력 = 같은 산출.
// 렌더러는 이 폴더가 쓰는 마크다운 부분집합만 지원한다(제목·표·목록·코드펜스·인용·강조).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

// ── 마크다운 → HTML (부분집합) ─────────────────────────────────────
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const NUL = '\u0001CODE';  // 본문에 나올 수 없는 자리표시자 경계

/**
 * 인라인: `code` → **bold** → [text](url). code 안은 다른 규칙을 적용하지 않는다.
 * 자리표시자는 NUL 로 감싼다 — 공백으로 감싸면 복원 때 없던 공백이 생기고
 * 본문의 " 12 " 같은 숫자를 코드로 오인한다.
 */
function inline(s) {
  const code = [];
  let t = s.replace(/`([^`]+)`/g, (_, c) => NUL + (code.push(`<code>${esc(c)}</code>`) - 1) + NUL);
  t = esc(t)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>') // 굵게 처리 뒤에 와야 한다
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return t.replace(new RegExp(NUL + '(\\d+)' + NUL, 'g'), (_, i) => code[+i]);
}

/**
 * 목록 항목의 **연속 줄**(마커 없이 들여쓴 줄)을 항목 줄에 합친다.
 * 안 하면 연속 줄이 문단으로 떨어지며 목록이 닫혀 **번호가 1로 리셋된다**(실측 버그).
 * 중첩 항목은 마커가 있으므로 여기 걸리지 않는다.
 */
function joinListContinuations(md) {
  const out = [];
  let inItem = false, fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; inItem = false; out.push(line); continue; }
    if (fence) { out.push(line); continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) { inItem = true; out.push(line); continue; }
    if (inItem && /^\s+\S/.test(line)) { out[out.length - 1] += ' ' + line.trim(); continue; }
    inItem = false;
    out.push(line);
  }
  return out.join('\n');
}

/** 표 셀 분리 — `\|`(이스케이프된 파이프)는 구분자가 아니다. */
const cells = (row) =>
  row.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

const isTableSep = (l) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes('-');

function render(src) {
  const lines = joinListContinuations(src.replace(/<!--[\s\S]*?-->/g, '')).split('\n');
  const out = [];
  let i = 0;
  const listStack = []; // 들여쓰기 깊이별 목록 태그
  const closeLists = (toDepth = 0) => {
    while (listStack.length > toDepth) out.push(`</${listStack.pop()}>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    // 코드펜스
    if (/^\s*```/.test(line)) {
      closeLists();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 표
    if (/^\s*\|/.test(line) && isTableSep(lines[i + 1] ?? '')) {
      closeLists();
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(cells(lines[i++]));
      out.push(
        '<div class="tw"><table><thead><tr>' +
          head.map((c) => `<th>${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>',
      );
      continue;
    }

    // 제목
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeLists(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

    // 구분선
    if (/^\s*---+\s*$/.test(line)) { closeLists(); out.push('<hr>'); i++; continue; }

    // 인용
    if (/^\s*>/.test(line)) {
      closeLists();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 목록 (중첩 = 들여쓰기 2칸 단위)
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      const depth = Math.floor(li[1].length / 2) + 1;
      const tag = /\d/.test(li[2]) ? 'ol' : 'ul';
      closeLists(depth);
      if (listStack.length === depth && listStack[depth - 1] !== tag) closeLists(depth - 1);
      while (listStack.length < depth) { out.push(`<${tag}>`); listStack.push(tag); }
      const box = li[3].match(/^\[( |x)\]\s*(.*)$/);
      out.push(box
        ? `<li class="cb"><span class="box">${box[1] === 'x' ? '✔' : ''}</span>${inline(box[2])}</li>`
        : `<li>${inline(li[3])}</li>`);
      i++;
      continue;
    }

    // 빈 줄 / 문단
    if (!line.trim()) { i++; continue; }
    closeLists();
    const buf = [];
    while (i < lines.length && lines[i].trim() &&
           !/^\s*(#{1,4}\s|[-*]\s|\d+\.\s|\||>|```|---+\s*$)/.test(lines[i]))
      buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  closeLists();
  return out.join('\n');
}

// ── 탭 구성 ────────────────────────────────────────────────────────
// 붙여넣기용 프롬프트와 문서(근거·이력)를 **탭으로 분리**한다 — 프롬프트 탭은 그대로 복사되고,
// 왜 그런 규격인지는 문서 탭에서 뒤진다.
const v1 = read('shared-prompt-v1.md');
const draft = read('draft-hero-v0.md');

/** ✂ 마커 구간 추출 — 마커 이름으로 짧은 판/상세판을 가른다. */
const cut = (name) => {
  const m = v1.match(new RegExp(`✂ ${name} 시작[^\\n]*-->\\n([\\s\\S]*?)<!--[^\\n]*✂ ${name} 끝`));
  if (!m) throw new Error(`프롬프트 구간(✂ ${name})을 찾지 못했다 — shared-prompt-v1.md 확인`);
  return m[1].trim();
};
const shortBody = cut('짧은 판');
const longBody = cut('상세판');

const section = (from, to) => {
  const s = v1.indexOf(from);
  if (s < 0) throw new Error(`섹션 없음: ${from}`);
  const e = to ? v1.indexOf(to, s) : -1;
  return v1.slice(s, e < 0 ? undefined : e).trim();
};

const TABS = [
  { id: 'prompt', label: '📋 짧은 판 (권장)', copy: shortBody,
    note: 'ChatGPT·Gemini 등 대화형 이미지 AI 용. 어기면 산출이 실제로 깨지는 규칙만 남겼다. '
        + '레퍼런스와 함께 붙여넣고, 테마는 다음 메시지로 준다.',
    html: render(shortBody) },
  { id: 'full', label: '📜 상세판', copy: longBody,
    note: '배치 생성 도구(Midjourney/SD)나 시트로 뽑을 때. 규격 근거 포함 — 사람이 규격을 '
        + '재확인할 때도 이쪽을 본다.',
    html: render(longBody) },
  { id: 'diff', label: '🔧 수정 diff (초안 대비)',
    note: 'hero 초안 v0 의 어디를 왜 바꿨나 — 실측 근거와 함께.',
    html: render(section('# 부록 A.', '# 부록 B.')) },
  { id: 'spec', label: '📐 실측 근거표',
    note: '우리 소비 규격의 SoT. 파일·라인 인용.',
    html: render(section('# 부록 B.')) },
  { id: 'draft', label: '📄 초안 v0 (원문)',
    note: 'hero 원본. 비교용 보존.',
    html: render(draft) },
];

const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>캐릭터 아트 공용 프롬프트 v1</title>
<style>
:root{--bg:#0b1117;--surface:#111a1c;--surface2:#151d1f;--line:#2a3439;
--gold:#e4991c;--gold-hi:#ffdb4a;--txt:#e0d8cf;--txt2:#a7a090;--muted:#7f7e79;--accent:#57b775}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);
font:15px/1.75 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
header{position:sticky;top:0;z-index:10;background:var(--surface);border-bottom:1px solid var(--line)}
.hd{max-width:1000px;margin:0 auto;padding:14px 24px 0}
h1.title{margin:0;font-size:17px;color:var(--gold-hi);letter-spacing:-.2px}
.sub{color:var(--muted);font-size:12.5px;margin:2px 0 12px}
nav{display:flex;gap:4px;flex-wrap:wrap}
nav button{background:none;border:0;border-bottom:2px solid transparent;color:var(--txt2);
font:inherit;font-size:13.5px;padding:8px 14px;cursor:pointer;border-radius:6px 6px 0 0}
nav button:hover{color:var(--txt);background:var(--surface2)}
nav button[aria-selected=true]{color:var(--gold-hi);border-bottom-color:var(--gold)}
main{max-width:1000px;margin:0 auto;padding:26px 24px 96px}
.note{color:var(--muted);font-size:12.5px;margin:0 0 18px;padding-left:10px;border-left:2px solid var(--line)}
section[hidden]{display:none}
h1{font-size:21px;color:var(--gold-hi);margin:34px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h2{font-size:17px;color:var(--gold);margin:28px 0 10px}
h3{font-size:15px;color:var(--txt);margin:22px 0 8px}
h4{font-size:14px;color:var(--txt2);margin:18px 0 6px}
p{margin:10px 0}
a{color:var(--accent)}
strong{color:var(--gold-hi);font-weight:600}
code{background:#1a2023;color:#f0c674;padding:1px 5px;border-radius:4px;font-size:12.5px;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:#0e1416;border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow-x:auto}
pre code{background:none;color:#cfe3d0;padding:0;font-size:12.5px;line-height:1.6}
blockquote{margin:14px 0;padding:2px 0 2px 16px;border-left:3px solid var(--gold);color:var(--txt2);background:rgba(228,153,28,.04)}
blockquote p{margin:6px 0}
hr{border:0;border-top:1px solid var(--line);margin:26px 0}
ul,ol{margin:8px 0;padding-left:24px}
li{margin:5px 0}
li.cb{list-style:none;margin-left:-20px}
li.cb .box{display:inline-block;width:15px;height:15px;border:1px solid var(--muted);border-radius:3px;
margin-right:8px;vertical-align:-2px;text-align:center;line-height:14px;font-size:11px;color:var(--accent)}
.tw{overflow-x:auto;margin:14px 0;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
th{background:var(--surface2);color:var(--gold);font-weight:600;white-space:nowrap}
tr:last-child td{border-bottom:0}
.copybar{display:flex;align-items:center;gap:12px;margin:0 0 16px}
.copybar button{background:var(--gold);color:#1a1206;border:0;border-radius:7px;font:inherit;
font-size:13px;font-weight:600;padding:8px 16px;cursor:pointer}
.copybar button:hover{background:var(--gold-hi)}
.copybar span{color:var(--muted);font-size:12.5px}
.paste{border:1px dashed var(--line);border-radius:10px;padding:4px 20px 18px;background:rgba(255,255,255,.012)}
</style></head><body>
<header><div class="hd">
<h1 class="title">캐릭터 아트 공용 프롬프트 — v1</h1>
<p class="sub">외부 이미지 AI 용 · 소비 규격 SoT = design/characters/pipeline + apps/web · 2026-07-27</p>
<nav>${TABS.map((t, n) => `<button role="tab" data-t="${t.id}" aria-selected="${n === 0}">${t.label}</button>`).join('')}</nav>
</div></header>
<main>
${TABS.map((t, n) => `<section id="t-${t.id}"${n ? ' hidden' : ''}>
<p class="note">${t.note}</p>
${t.copy ? `<div class="copybar"><button class="copy" data-for="${t.id}">프롬프트 전체 복사</button><span class="copied">${t.copy.length.toLocaleString('en-US')}자 · 레퍼런스 이미지와 함께 붙여넣는다</span></div>
<div class="paste">${t.html}</div>` : t.html}
</section>`).join('\n')}
</main>
<script>
const tabs=[...document.querySelectorAll('nav button')];
const show=id=>{tabs.forEach(b=>b.setAttribute('aria-selected',b.dataset.t===id));
document.querySelectorAll('main section').forEach(s=>s.hidden=s.id!=='t-'+id);
history.replaceState(null,'','#'+id);scrollTo(0,0)};
tabs.forEach(b=>b.onclick=()=>show(b.dataset.t));
if(location.hash)show(location.hash.slice(1));
const RAW=${JSON.stringify(Object.fromEntries(TABS.filter((t) => t.copy).map((t) => [t.id, t.copy])))};
document.querySelectorAll('button.copy').forEach(b=>{
  const out=b.parentElement.querySelector('.copied'), txt=RAW[b.dataset.for];
  b.onclick=async()=>{
    try{await navigator.clipboard.writeText(txt);out.textContent='✔ 복사됐다 ('+txt.length.toLocaleString()+'자)';}
    catch(e){out.textContent='복사 실패 — 원문: shared-prompt-v1.md';}
  };
});
</script></body></html>
`;

fs.writeFileSync(path.join(DIR, 'prompt-docs.html'), html);
console.log(`✓ prompt-docs.html  탭 ${TABS.length}개 · 짧은 판 ${shortBody.length}자 / 상세판 ${longBody.length}자 · ${html.length} bytes`);
