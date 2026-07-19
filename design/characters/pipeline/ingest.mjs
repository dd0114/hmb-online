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

const LOCAL_SWEEP = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28];
const GLOBAL_SWEEP = [40, 60, 90, 140, 255];
const INTEGRITY = 0.98;   // 최대 덩어리 비율 — 이 아래면 캐릭터가 조각난 것
const EROSION_LIMIT = 1.0; // % — 배경 모델에서 벗어난 것을 지운 비율. 연속 침식 방어.
const PROXY_MAX = 320;    // 파라미터 탐색은 축소 프록시에서(하드 엣지 보존 위해 nearest)

/**
 * 배경 제거 파라미터 자동 선택.
 *
 * **목표는 명시적 최적화다**: 캐릭터 무결성을 유지하는 범위에서 **배경을 최대한 제거**한다.
 *   maximize removedPct  subject to  largestShare ≥ 0.98 ∧ holes 작음
 *
 * 세 가지 실패 모드를 **각각 다른 항**이 막는다 — 검증에서 네 번 실패하며 하나씩 추가됐다:
 *  - **파편형 과잉 제거**(캐릭터가 조각남) → `largestShare ≥ 0.98` 제약.
 *  - **과소 제거**(배경 잔류) → 목적함수 `maximize removedPct`.
 *    largestShare 로는 안 잡힌다(잔류 배경이 캐릭터에 병합돼 지표를 오히려 올린다).
 *  - **연속형 과잉 제거**(외곽부터 갉아먹기) → `erodedPct ≤ 1%` 제약.
 *    위상이 안 변해서 파편·구멍 지표에 안 걸리는데, 목적함수는 오히려 이 방향을
 *    선호한다(제거량이 늘므로). 실측: 아우라 full 24/255 는 largestShare 98.1% 로
 *    제약을 통과하면서 날개를 먹었다 — erodedPct 는 0.23% → 4.30% 로 18배 반응한다.
 *  - `globalTol` 도 함께 탐색한다. 고정하면 그 축의 더 나은 값을 영영 못 찾는다.
 */
function autoTol(im) {
  const scale = Math.min(1, PROXY_MAX / Math.max(im.width, im.height));
  const proxy = scale < 1
    ? nearest(im, Math.max(1, Math.round(im.width * scale)), Math.max(1, Math.round(im.height * scale)))
    : im;
  const holeLimit = proxy.width * proxy.height * 0.005;

  let best = null;
  const all = [];

  for (const globalTol of GLOBAL_SWEEP) {
    for (const localTol of LOCAL_SWEEP) {
      const { image, stats } = removeBackground(proxy, { localTol, globalTol });
      const q = cutoutQuality(image);
      const ok = q.largestShare >= INTEGRITY && q.holes <= holeLimit
        && stats.erodedPct <= EROSION_LIMIT;
      all.push({ localTol, globalTol, removedPct: Number(stats.removedPct.toFixed(2)),
                 erodedPct: Number(stats.erodedPct.toFixed(2)),
                 largestShare: Number(q.largestShare.toFixed(4)), ok });
      if (!ok) continue;
      if (!best || stats.removedPct > best.removedPct)
        best = { localTol, globalTol, removedPct: stats.removedPct, erodedPct: stats.erodedPct };
    }
  }
  // 후보가 하나도 없으면 가장 보수적인 설정으로 폴백(배경은 남지만 캐릭터는 보존).
  if (!best) best = { localTol: LOCAL_SWEEP[0], globalTol: GLOBAL_SWEEP[0], removedPct: 0, fallback: true };

  // 경계 포화 경고는 **위쪽 경계에서만** 의미가 있다. 제거량을 최대화하므로 최적점은
  // 제약에 걸릴 때까지 위로 밀린다 → 위쪽 끝에서 멈췄다면 범위 밖에 더 나은 값이 있을 수 있다.
  // 아래쪽 끝은 "입력이 어려워 제약이 즉시 걸린 것"이지 범위 문제가 아니다(경고 오탐).
  const lastL = LOCAL_SWEEP[LOCAL_SWEEP.length - 1], lastG = GLOBAL_SWEEP[GLOBAL_SWEEP.length - 1];
  best.atBoundary = best.localTol === lastL || best.globalTol === lastG;
  // 진단 곡선은 **채택된 globalTol** 행을 남긴다(고정 행은 선택과 무관해 쓸모가 없다).
  const curve = all.filter((r) => r.globalTol === best.globalTol).map(({ globalTol, ...r }) => r);
  return { ...best, curve };
}

/**
 * 원화 → 정리된 소스(배경 제거 + 트림). 산출 3형태의 공통 입력.
 * 배경 제거 파라미터는 autoTol 로 최적화 선택하고, 남는 손상은 파편화·내부구멍으로 경고한다.
 */
function clean(im, warnings, label, override) {
  // 투명 배경(SPEC 권장 경로)이면 파라미터 탐색이 불필요하다.
  // 단 품질 게이트는 **건너뛰지 않는다** — 알파가 있어도 컷아웃이 나쁠 수 있다.
  const preAlpha = removeBackground(im, { localTol: LOCAL_SWEEP[0] });
  if (preAlpha.stats.hadAlpha) {
    const q0 = cutoutQuality(preAlpha.image);
    gateQuality(q0, preAlpha.image, warnings, label);
    return { src: trim(preAlpha.image, 0.02), quality: { ...q0, localTol: null, alphaPreserved: true } };
  }

  warnings.push(`${label}: 배경이 불투명 — SPEC §2 는 투명 배경을 요구한다(자동 분리는 보조 수단).`);
  const auto = override === undefined
    ? autoTol(im)
    : { localTol: override.localTol, globalTol: override.globalTol, curve: [], atBoundary: false };
  // 프록시에서 고른 값이 원본 해상도에서도 무결한지 재검증한다.
  // 프록시(320px)와 원본은 지역 기울기가 미세하게 달라 통과값이 어긋날 수 있다
  // (실측: 펭킹킹 full 이 프록시 통과 후 원본에서 96.2% → 망토 소실).
  let { localTol, globalTol } = auto;
  let image = removeBackground(im, { localTol, globalTol }).image;
  let exhausted = false;
  if (override === undefined) {
    const holeLimitFull = im.width * im.height * 0.005;
    let guard = 0, stats = removeBackground(im, { localTol, globalTol }).stats;
    while (guard++ < LOCAL_SWEEP.length) {
      const qq = cutoutQuality(image);
      const ok = qq.largestShare >= INTEGRITY && qq.holes <= holeLimitFull
        && stats.erodedPct <= EROSION_LIMIT;
      if (ok) break;
      const i = LOCAL_SWEEP.indexOf(localTol);
      if (i <= 0) { exhausted = true; break; } // 더 물러날 곳이 없는데 여전히 미달
      localTol = LOCAL_SWEEP[i - 1]; // 한 단계 보수적으로 물러난다
      const r = removeBackground(im, { localTol, globalTol });
      image = r.image; stats = r.stats;
      auto.backedOff = true;
    }
  }
  if (auto.backedOff)
    warnings.push(`${label}: 프록시 탐색값이 원본에서 기준 미달 → localTol=${localTol} 로 후퇴.`);
  if (exhausted || auto.fallback)
    warnings.push(
      `${label}: **기준을 만족하는 배경제거 설정을 찾지 못했다** — 배경 잔류 또는 캐릭터 손상이 남는다.` +
      ` 투명 배경으로 재입고할 것.`);
  if (auto.atBoundary)
    warnings.push(`${label}: 선택값(localTol=${localTol}, globalTol=${globalTol})이 탐색 범위 경계 — 더 나은 값이 범위 밖에 있을 수 있다.`);
  const q = cutoutQuality(image);
  q.localTol = localTol;
  q.globalTol = globalTol;
  q.tolCurve = auto.curve;

  gateQuality(q, image, warnings, label);
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
