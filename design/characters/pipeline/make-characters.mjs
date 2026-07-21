#!/usr/bin/env node
// 캐릭터 에셋 dist 발행 (#104 → #121)
//
// out/ 의 캐릭터 산출물(ingest.mjs) + hue 변형본을 **아틀라스로 묶어 dist/characters/ 로 발행**한다.
// #121(LEGEND 매핑)이 소비: manifest.characters[charId] → 타일 좌표. 선수↔캐릭터 매핑은 #121(data/) 소유.
//
//   node design/characters/pipeline/make-characters.mjs
//
// 결정론: hue 변형은 고정 각도, 순서는 CHARACTERS 배열 순. 난수·시각 의존 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from './lib/png.mjs';
import { img, blit, hueShift, hex2rgb } from './lib/img.mjs';
import { composeCard } from './lib/card.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const OUT = path.join(ROOT, 'out');
const DIST = path.join(ROOT, 'dist', 'characters');

const AVATAR_SIZES = [64, 32, 16];
const SPRITE_SIZES = [64, 32, 16, 8];

// 레퍼 12캐릭터 — pilot-crop 순서와 동일. (id, position)
const BASE = [
  ['ragna', 'FW'], ['sail', 'MF'], ['lupus', 'DF'], ['aura', 'GK'],
  ['natzt', 'FW'], ['mio', 'MF'], ['leo', 'DF'], ['riya', 'MF'],
  ['anubis', 'FW'], ['penguin-king', 'GK'], ['bark', 'DF'], ['bella', 'MF'],
];

// LEGEND 14명 - 캐릭터 12종 = 부족분 2. 매니저 규칙(선수 id 정렬순) + 포지션 매칭으로 결정론 배정:
//   슬롯 13 = P143(MF) → MF 캐릭터 sail 재사용 + hue 150°
//   슬롯 14 = P144(FW) → FW 캐릭터 ragna 재사용 + hue 210°
// (최종 선수↔캐릭터 배정은 #121 이 확정 — 여기서는 변형 에셋만 준비한다.)
const VARIANTS = [
  { id: 'sail-h150', of: 'sail', position: 'MF', hueDeg: 150, forSlot: 13, forPlayer: 'P143' },
  { id: 'ragna-h210', of: 'ragna', position: 'FW', hueDeg: 210, forSlot: 14, forPlayer: 'P144' },
];

const rd = (charId, file) => decodePNG(fs.readFileSync(path.join(OUT, charId, file)));
const write = (file, im) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, encodePNG(im)); };

/** 타일 배열 → 격자 아틀라스. */
function atlas(tiles, size) {
  const cols = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / cols);
  const sheet = img(cols * size, rows * size);
  tiles.forEach((t, i) => blit(sheet, t, (i % cols) * size, Math.floor(i / cols) * size));
  return { sheet, cols, rows };
}

// 발행 대상 = 원본 12 + 변형 2. 각 엔트리는 { id, position, source:{charId, hueDeg} }
const ENTRIES = [
  ...BASE.map(([id, position]) => ({ id, position, source: { charId: id, hueDeg: 0 } })),
  ...VARIANTS.map((v) => ({ id: v.id, position: v.position, variant: { of: v.of, hueDeg: v.hueDeg },
                            forSlot: v.forSlot, forPlayer: v.forPlayer, source: { charId: v.of, hueDeg: v.hueDeg } })),
];

const report = (charId) => JSON.parse(fs.readFileSync(path.join(OUT, charId, 'report.json'), 'utf8'));

/** 아바타·스프라이트 로드(변형이면 hue 적용 — 아트 전체라 그대로 걸어도 팀링은 web 이 얹으므로 무오염). */
const loadTile = (entry, file) => {
  const im = rd(entry.source.charId, file);
  return entry.source.hueDeg ? hueShift(im, entry.source.hueDeg) : im;
};

/**
 * 카드 로드. **변형은 아트에만 hue 를 걸고 재합성**한다 —
 * 카드 완성본에 hue 를 걸면 포지션 뱃지·프레임·별 색이 돌아 포지션이 오인된다(FW→DF).
 * 프레임/시그니처 색은 변형의 정체성이므로 함께 시프트하되, 뱃지는 POS_COLOR 로 고정된다.
 */
const loadCard = (entry) => {
  if (!entry.source.hueDeg) return rd(entry.source.charId, 'card.png');
  const m = report(entry.source.charId).meta;
  const art = hueShift(rd(entry.source.charId, 'card-art.png'), entry.source.hueDeg);
  const sig = hueShift1(hex2rgb(m.signatureResolved), entry.source.hueDeg);
  const frame = hueShift1(hex2rgb(m.frameResolved), entry.source.hueDeg);
  return composeCard(art, { position: entry.position, stars: m.stars || 5, signature: sig, frame });
};

/** 단일 색 hue 회전(피부 보호 없음 — 시그니처/프레임 색은 캐릭터 색이지 피부가 아니다). */
function hueShift1(rgb, deg) {
  const one = img(1, 1); one.data.set([...rgb, 255], 0);
  const out = hueShift(one, deg, false);
  return [out.data[0], out.data[1], out.data[2]];
}

fs.rmSync(DIST, { recursive: true, force: true });

const manifest = {
  version: 1,
  kind: 'characters',
  note: 'hero 확정(2026-07-21): 레퍼 12캐릭터를 게임 자산으로 확정. #121 LEGEND 매핑 소비용.',
  source: 'ref-pixel-fantasy-football',
  count: ENTRIES.length,
  variantRule: 'LEGEND 14 - 캐릭터 12 = 부족분 2. 선수 id 정렬순 + 포지션 매칭. hue 회전(채도·명도·피부톤 보존).',
  atlases: {},
  characters: {},
};

// 아바타·스프라이트 아틀라스
for (const size of AVATAR_SIZES) {
  const { sheet, cols, rows } = atlas(ENTRIES.map((e) => loadTile(e, `avatar-${size}.png`)), size);
  write(path.join(DIST, `avatars-${size}.png`), sheet);
  manifest.atlases[`avatars-${size}`] = { file: `characters/avatars-${size}.png`, tile: size, cols, rows };
}
for (const size of SPRITE_SIZES) {
  const { sheet, cols, rows } = atlas(ENTRIES.map((e) => loadTile(e, `sprite-${size}.png`)), size);
  write(path.join(DIST, `sprites-${size}.png`), sheet);
  manifest.atlases[`sprites-${size}`] = { file: `characters/sprites-${size}.png`, tile: size, cols, rows };
}
// 카드는 226×425 로 커서 아틀라스보다 개별 파일이 낫다.
for (const e of ENTRIES) write(path.join(DIST, `card-${e.id}.png`), loadCard(e));

const cols = manifest.atlases['avatars-64'].cols;
ENTRIES.forEach((e, i) => {
  manifest.characters[e.id] = {
    index: i, col: i % cols, row: Math.floor(i / cols),
    position: e.position, card: `characters/card-${e.id}.png`,
    ...(e.variant ? { variant: e.variant, forSlot: e.forSlot, forPlayer: e.forPlayer } : {}),
  };
});

fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`✓ 캐릭터 에셋 ${ENTRIES.length}종(원본 ${BASE.length} + 변형 ${VARIANTS.length}) → design/characters/dist/characters/`);
console.log(`  아바타 ${AVATAR_SIZES.join('/')} · 스프라이트 ${SPRITE_SIZES.join('/')} 아틀라스 + 카드 ${ENTRIES.length}장 + manifest.json`);
console.log(`  변형: ${VARIANTS.map((v) => `${v.id}(${v.of}+${v.hueDeg}° → 슬롯${v.forSlot}/${v.forPlayer})`).join(', ')}`);
