#!/usr/bin/env node
// 캐릭터 인제스트 파이프라인 (#104 P1)
//   incoming/<id>__portrait.png, <id>__full.png  →  out/<id>/{avatar,card,sprite}
// 순수 node(외부 의존 0). 난수·시각 의존 없음 → 같은 입력 = 같은 산출(결정론).
//
//   node design/characters/pipeline/ingest.mjs            # incoming/ 전부
//   node design/characters/pipeline/ingest.mjs ragna      # 특정 id 만
//
// 비-PNG 입력은 macOS 내장 sips 로 PNG 변환 후 처리한다.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from './lib/png.mjs';
import {
  removeBackground, cutoutQuality, trim, hardAlpha, fitCanvas, circleWithRing, nearest,
  dominantColor, shade, rgb2hex, hex2rgb,
} from './lib/img.mjs';
import { quantize } from './lib/quantize.mjs';
import { composeCard, POS_COLOR } from './lib/card.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const IN = path.join(ROOT, 'incoming');
const OUT = path.join(ROOT, 'out');

// ── 규격 (SPEC.md §1) ──────────────────────────────────────────────
// 아바타 = ref-1 얼굴 사다리 3단계. 스프라이트 = ref-3 전신 간소화 4단계.
export const AVATAR_LADDER = [
  { size: 64, colors: 24, label: '1단계(원안) 디테일 유지' },
  { size: 32, colors: 14, label: '2단계(간소화) 색 축소·실루엣 강조' },
  { size: 16, colors: 8, label: '3단계(더 간소화) 아이콘화' },
];
export const SPRITE_LADDER = [
  { size: 64, colors: 28, label: '원본(기준)' },
  { size: 32, colors: 18, label: '1단계 디테일 축소' },
  { size: 16, colors: 10, label: '2단계 색 수 축소·실루엣 강조' },
  { size: 8, colors: 5, label: '3단계 최소 색상·아이콘화' },
];
export const TEAM_RING = { blue: '#3da9f1', red: '#ef4f44' };

// 배경 제거 tolerance 는 소스마다 자동 선택된다(autoTol). 강제하려면 incoming/<id>.json 의 "bgTol".

const readImage = (file) => {
  if (path.extname(file).toLowerCase() !== '.png') {
    const tmp = path.join(OUT, '.tmp-' + path.basename(file) + '.png');
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync('sips', ['-s', 'format', 'png', file, '--out', tmp], { stdio: 'ignore' });
    const im = decodePNG(fs.readFileSync(tmp));
    fs.unlinkSync(tmp);
    return im;
  }
  return decodePNG(fs.readFileSync(file));
};

const write = (file, im) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG(im));
};

// 자동 탐색은 폐기했다. 아래 "왜"를 반드시 읽을 것.
const CONSERVATIVE = { localTol: 2, globalTol: 40 };
const DIAG_LOCAL = [2, 4, 6, 8, 10, 12, 14, 18, 24];
const DIAG_GLOBAL = [30, 40, 60, 90, 140, 255];

/**
 * 진단용 스윕 표 — **선택에 쓰지 않는다.** 운영자가 `bgTol` 값을 고를 때 참고하는 자료다.
 * 자동 선택에 쓰지 않는 이유는 clean() 주석 참조.
 */
function diagnoseTol(im) {
  const scale = Math.min(1, 320 / Math.max(im.width, im.height));
  const proxy = scale < 1
    ? nearest(im, Math.max(1, Math.round(im.width * scale)), Math.max(1, Math.round(im.height * scale)))
    : im;
  const rows = [];
  for (const globalTol of DIAG_GLOBAL)
    for (const localTol of DIAG_LOCAL) {
      const { image, stats } = removeBackground(proxy, { localTol, globalTol });
      const q = cutoutQuality(image);
      rows.push({ localTol, globalTol,
                  removedPct: Number(stats.removedPct.toFixed(1)),
                  largestShare: Number(q.largestShare.toFixed(3)) });
    }
  return rows;
}

/**
 * 원화 → 정리된 소스(배경 제거 + 트림). 산출 3형태의 공통 입력.
 *
 * ## 배경 제거 파라미터를 자동으로 고르지 않는 이유 (중요)
 *
 * 자동 선택을 **다섯 번** 시도했고 매번 독립 검증이 새로운 실패 모드를 찾았다:
 *  1. 전역 tolerance 고정 → 어두운 캐릭터를 먹었다.
 *  2. "분리 불가"로 단정 → 더 낮은 값으로 반증됐다.
 *  3. 무릎 검출 → 최적점이 아니라 스윕 시작점을 반환, 배경이 대량 잔류했다.
 *  4. `maximize 제거량 s.t. 무결성` → **연속 침식**(외곽부터 갉아먹기)을 선호했다.
 *  5. 침식률 지표 추가 → 글로우 배경에서 정답을 탈락시키고(위양성),
 *     그라디언트 배경에서 캐릭터 전멸을 통과시켰다(위음성).
 *
 * 지표(파편·구멍·색모델)마다 반례가 있고, 탐색 격자를 넓히면 목적함수가
 * 캐릭터를 먹는 지점을 고른다. 이건 일반 이미지 매팅 문제이고 이 트랙의 범위가 아니다.
 *
 * 그래서: **값은 사람이 정한다**(`incoming/<id>.json` 의 `bgTol`).
 * 지정이 없으면 **가장 보수적인 설정**으로 물러난다 — 배경이 남을지언정 캐릭터는 안 먹는다.
 * 실패를 **눈에 보이는 쪽**(배경 상자)으로만 내는 것이 설계 의도다.
 * 보이지 않는 손상(캐릭터 소실)은 게이트에서 정상으로 오인되지만, 배경 상자는 즉시 보인다.
 *
 * SPEC §2 대로 **투명 배경으로 입고하면 이 경로 자체를 타지 않는다.**
 */
function clean(im, warnings, label, override) {
  // 투명 배경(SPEC 권장 경로) — 파라미터가 아예 필요 없다. 품질 게이트는 그대로 적용.
  const preAlpha = removeBackground(im, CONSERVATIVE);
  if (preAlpha.stats.hadAlpha) {
    const q0 = cutoutQuality(preAlpha.image);
    gateQuality(q0, preAlpha.image, warnings, label);
    return { src: trim(preAlpha.image, 0.02), quality: { ...q0, alphaPreserved: true } };
  }

  warnings.push(`${label}: 배경이 불투명 — SPEC §2 위반(투명 배경 필수).`);
  const cfg = override || CONSERVATIVE;
  if (!override)
    warnings.push(
      `${label}: bgTol 미지정 → 보수적 설정(localTol=${CONSERVATIVE.localTol})으로 처리했다.` +
      ` **배경이 남는다.** 값을 고르려면 report.json 의 tolDiagnostic 표를 보고` +
      ` incoming/<id>.json 에 bgTol 을 지정할 것. 자동 선택은 하지 않는다(신뢰할 수 없어서).`);

  const { image } = removeBackground(im, cfg);
  const q = cutoutQuality(image);
  q.localTol = cfg.localTol;
  q.globalTol = cfg.globalTol;
  if (!override) q.tolDiagnostic = diagnoseTol(im);
  gateQuality(q, image, warnings, label);
  warnings.push(`${label}: 컷아웃은 **육안 확인 필수** — 지표만으로는 손상을 보증할 수 없다(대조 시트 확인).`);
  return { src: trim(image, 0.02), quality: q };
}

/** 컷아웃 품질 경고 — 투명배경 경로와 자동분리 경로 **양쪽 모두**에 적용한다. */
function gateQuality(q, image, warnings, label) {
  if (q.largestShare < 0.7)
    warnings.push(
      `${label}: 컷아웃 파편화(조각 ${q.components}개, 최대 덩어리 ${(q.largestShare * 100).toFixed(0)}%)` +
      ` — 캐릭터가 조각나 있다.`,
    );
  if (q.holes > image.width * image.height * 0.005)
    warnings.push(`${label}: 컷아웃 내부 구멍 ${q.holes}px — 캐릭터 내부가 배경으로 오인됐다.`);
}

/** 도트화 = 박스 다운스케일 → 하드 알파(안티에일리어싱 제거) → 팔레트 양자화. */
function dotify(src, w, h, colors, alignY = 'center') {
  return quantize(hardAlpha(fitCanvas(src, w, h, { alignY })), colors);
}

/**
 * bgTol 해석 → `{localTol, globalTol}` 또는 undefined(자동 탐색).
 * 허용 형태: `8` · `{portrait:9, full:8}` · `{localTol:8, globalTol:60}` ·
 *            `{portrait:{localTol:9,globalTol:40}, full:8}`
 * globalTol 을 지정 못 하면 자동선택이 고른 축(실측 6건 중 4건이 90 아님)에 손이 안 닿는다.
 */
const pickTol = (bgTol, variant) => {
  const norm = (v) => {
    if (Number.isFinite(v)) return { localTol: v, globalTol: 90 };
    if (v && Number.isFinite(v.localTol))
      return { localTol: v.localTol, globalTol: Number.isFinite(v.globalTol) ? v.globalTol : 90 };
    return undefined;
  };
  return norm(bgTol) || (bgTol ? norm(bgTol[variant]) : undefined);
};

function loadMeta(id) {
  const f = path.join(IN, `${id}.json`);
  const m = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  return { id, name: m.name || id, title: m.title || '', position: m.position || 'MF',
           stars: m.stars || 5, desc: m.desc || '', signature: m.signature, frame: m.frame,
           // bgTol 은 variant 별로 다를 수 있다(실측: 라그나 portrait 9 / full 8).
           // 숫자면 양쪽 공통, 객체면 {portrait, full} 개별 지정.
           bgTol: m.bgTol };
}

export function processCharacter(id, files) {
  const outDir = path.join(OUT, id);
  const meta = loadMeta(id);
  const report = { id, meta, produced: [], warnings: [] };

  // ── 아바타 (portrait) ──
  if (files.portrait) {
    const raw = readImage(files.portrait);
    // SPEC §2: portrait 512×512 이상 정사각(필수)
    if (raw.width < 512 || raw.height < 512)
      report.warnings.push(`portrait ${raw.width}×${raw.height} — SPEC 최소 512×512 미달`);
    if (raw.width !== raw.height)
      report.warnings.push(`portrait ${raw.width}×${raw.height} — SPEC 은 정사각을 요구(레터박싱되어 해상도 손실)`);
    const { src, quality } = clean(raw, report.warnings, 'portrait', pickTol(meta.bgTol, 'portrait'));
    report.portraitCutout = quality;
    for (const st of AVATAR_LADDER) {
      const dot = dotify(src, st.size, st.size, st.colors);
      write(path.join(outDir, `avatar-${st.size}.png`), dot);
      report.produced.push(`avatar-${st.size}.png`);
      for (const [team, hex] of Object.entries(TEAM_RING)) {
        write(path.join(outDir, `avatar-${st.size}-${team}.png`), circleWithRing(dot, st.size, hex));
        report.produced.push(`avatar-${st.size}-${team}.png`);
      }
    }
  } else report.warnings.push('portrait 없음 — 아바타 미산출');

  // ── 스프라이트 + 카드 (full) ──
  if (files.full) {
    const raw = readImage(files.full);
    // SPEC §2: full 512×1024 이상, 세로 1:2
    if (raw.width < 512 || raw.height < 1024)
      report.warnings.push(`full ${raw.width}×${raw.height} — SPEC 최소 512×1024 미달`);
    const ar = raw.height / raw.width;
    if (ar < 1.6 || ar > 2.4)
      report.warnings.push(`full 비율 1:${ar.toFixed(2)} — SPEC 은 세로 1:2 를 요구`);
    const { src, quality } = clean(raw, report.warnings, 'full', pickTol(meta.bgTol, 'full'));
    report.fullCutout = quality;
    const sig = meta.signature ? hex2rgb(meta.signature) : dominantColor(src);
    const frame = meta.frame ? hex2rgb(meta.frame) : shade(sig, 0.72);
    report.meta.signatureResolved = rgb2hex(sig);
    report.meta.frameResolved = rgb2hex(frame);

    // 스프라이트 = 게임 내 균일 셀이므로 정사각 캔버스(바닥 정렬).
    for (const st of SPRITE_LADDER) {
      const dot = dotify(src, st.size, st.size, st.colors, 'bottom');
      write(path.join(outDir, `sprite-${st.size}.png`), dot);
      report.produced.push(`sprite-${st.size}.png`);
    }
    // 카드 아트 = 아트 영역(192×314)의 정확히 1/2 로 도트화 → nearest ×2 업스케일(픽셀 격자 보존).
    const art = dotify(src, 96, 157, 32, 'bottom');
    const card = composeCard(art, { position: meta.position, stars: meta.stars, signature: sig, frame });
    write(path.join(outDir, 'card.png'), card);
    report.produced.push('card.png');
  } else report.warnings.push('full 없음 — 스프라이트·카드 미산출');

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

export function scanIncoming() {
  if (!fs.existsSync(IN)) return {};
  const chars = {};
  for (const f of fs.readdirSync(IN).sort()) {
    const m = f.match(/^(.+?)__(portrait|full)\.(png|jpg|jpeg|webp)$/i);
    if (!m) continue;
    // SPEC §2: charId = 소문자 ASCII kebab-case. 대문자를 허용하면 Ragna/ragna 가
    // 경고 없이 서로 다른 캐릭터 2개가 된다.
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m[1])) {
      console.log(`⚠ 건너뜀 ${f} — charId "${m[1]}" 가 SPEC 네이밍(소문자 kebab-case) 위반`);
      continue;
    }
    (chars[m[1]] ||= {})[m[2].toLowerCase()] = path.join(IN, f);
  }
  return chars;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv[2];
  const chars = scanIncoming();
  const ids = Object.keys(chars).filter((id) => !only || id === only);
  if (!ids.length) {
    console.log(`입고 없음: ${IN}\nSPEC.md §2 네이밍 규칙 확인 — <charId>__portrait.png / <charId>__full.png`);
    process.exit(0);
  }
  const reports = ids.map((id) => {
    const r = processCharacter(id, chars[id]);
    console.log(`✓ ${id}: ${r.produced.length}개 산출${r.warnings.length ? ` (경고 ${r.warnings.length})` : ''}`);
    r.warnings.forEach((w) => console.log(`   ⚠ ${w}`));
    return r;
  });
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(reports, null, 2) + '\n');
  console.log(`\n다음: node design/characters/pipeline/sheet.mjs  → contact-sheet.html (hero 게이트 #104)`);
}
