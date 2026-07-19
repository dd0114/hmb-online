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
  removeBackground, cutoutQuality, trim, hardAlpha, fitCanvas, circleWithRing,
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

const TOL_SWEEP = [4, 5, 6, 7, 8, 9, 10, 11, 12, 14];
const KNEE_DROP = 2.0; // %p — 이보다 크게 면적이 꺾이면 캐릭터를 먹기 시작한 것

/**
 * localTol 자동 선택. tolerance 를 올리면 배경이 더 지워지다가(완만한 감소)
 * 어느 지점부터 캐릭터를 먹기 시작한다(급격한 감소). 그 **무릎 직전** 값을 고른다.
 *
 * 고정 기본값은 위험하다 — 무릎 위치가 소스마다 다르다(라그나 8, 아우라 6).
 * 초판이 14 로 고정 출하해 3종 모두 훼손시킨 것이 이 함수를 만든 이유다.
 */
function autoTol(im) {
  let prev = null, chosen = TOL_SWEEP[0];
  const curve = [];
  for (const t of TOL_SWEEP) {
    const q = cutoutQuality(removeBackground(im, { localTol: t }).image);
    curve.push({ tol: t, opaquePct: Number(q.opaquePct.toFixed(2)) });
    if (prev !== null && prev - q.opaquePct > KNEE_DROP) break; // 무릎 — 직전 값 유지
    prev = q.opaquePct;
    chosen = t;
  }
  return { chosen, curve };
}

/**
 * 원화 → 정리된 소스(배경 제거 + 트림). 산출 3형태의 공통 입력.
 * tolerance 는 무릎 검출로 자동 선택하고, 남는 손상은 파편화·내부구멍으로 검출해 경고한다.
 */
function clean(im, warnings, label, override) {
  const auto = override === undefined ? autoTol(im) : { chosen: override, curve: [] };
  const localTol = auto.chosen;
  const { image, stats } = removeBackground(im, { localTol });
  if (!stats.hadAlpha) {
    warnings.push(`${label}: 배경이 불투명 — SPEC §2 는 투명 배경을 요구한다(자동 분리는 보조 수단).`);
  }
  const q = cutoutQuality(image);
  q.localTol = localTol;
  q.tolCurve = auto.curve;

  // 파편화(흩어진 손실) — 연속적 손실은 이걸로 안 잡히므로 tolerance 자동선택이 1차 방어다.
  if (q.largestShare < 0.7)
    warnings.push(
      `${label}: 컷아웃 파편화(조각 ${q.components}개, 최대 덩어리 ${(q.largestShare * 100).toFixed(0)}%)` +
      ` — 배경 제거가 캐릭터를 잠식했다. 투명 배경으로 재입고할 것.`,
    );
  if (q.holes > image.width * image.height * 0.005)
    warnings.push(`${label}: 컷아웃 내부 구멍 ${q.holes}px — 캐릭터 내부가 배경으로 오인됐다.`);
  return { src: trim(image, 0.02), quality: q };
}

/** 도트화 = 박스 다운스케일 → 하드 알파(안티에일리어싱 제거) → 팔레트 양자화. */
function dotify(src, w, h, colors, alignY = 'center') {
  return quantize(hardAlpha(fitCanvas(src, w, h, { alignY })), colors);
}

function loadMeta(id) {
  const f = path.join(IN, `${id}.json`);
  const m = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  return { id, name: m.name || id, title: m.title || '', position: m.position || 'MF',
           stars: m.stars || 5, desc: m.desc || '', signature: m.signature, frame: m.frame,
           bgTol: Number.isFinite(m.bgTol) ? m.bgTol : undefined };
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
    const { src, quality } = clean(raw, report.warnings, 'portrait', meta.bgTol);
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
    const { src, quality } = clean(raw, report.warnings, 'full', meta.bgTol);
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
