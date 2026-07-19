#!/usr/bin/env node
// 디폴트(플레이스홀더) 캐릭터 에셋 생성 (#104 ①②)
//
// hero 원화가 들어오기 전에도 **게임이 플레이 가능**하도록, 선수 전원에게
// 규격에 맞는 플레이스홀더 아바타·스프라이트를 만들어 준다.
// 선수별로 **색이 다르게** 생성되므로 플레이테스트에서 선수 구분이 된다.
//
//   node design/characters/pipeline/make-defaults.mjs
//
// 산출: design/characters/dist/  (커밋 대상 — web 이 소비)
//   avatars-{64,32,16}.png · sprites-{64,32,16,8}.png  (아틀라스)
//   frame-{GRADE}.png (등급별 카드 프레임 템플릿)
//   manifest.json (선수 id → 아틀라스 타일 좌표)
//
// 결정론: 선수 id 해시로만 색을 정한다. 난수·시각 의존 0.
// 실제 원화가 입고되면 ingest.mjs 산출물이 이걸 대체한다(manifest 의 source 필드로 구분).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePNG } from './lib/png.mjs';
import { img, blit, fillRect, blendRect, setPx, hex2rgb, shade } from './lib/img.mjs';
import { drawText, textWidth } from './lib/font.mjs';
import { composeCard, POS_COLOR, CARD } from './lib/card.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const REPO = path.resolve(ROOT, '../..');
const DIST = path.join(ROOT, 'dist');

const AVATAR_SIZES = [64, 32, 16];
const SPRITE_SIZES = [64, 32, 16, 8];

// 등급 → 프레임 색·별 개수 (레퍼 골드 시스템 기반)
const GRADE = {
  LEGEND: { frame: '#e4991c', stars: 6 },
  DIA:    { frame: '#5bc8e8', stars: 5 },
  GOLD:   { frame: '#d9a01e', stars: 4 },
  SILVER: { frame: '#b8c0c8', stars: 3 },
  BRONZE: { frame: '#a2703c', stars: 2 },
};

// 선수별 변주 팔레트 — id 해시로 고른다.
const HAIR = ['#2b1b12', '#5a3a1e', '#8a5a2a', '#c9a33c', '#e0d8cf', '#7a2f2f', '#33415c', '#4a2b53'];
const SKIN = ['#f2c9a0', '#e0a878', '#c2854f', '#8d5a33', '#5e3b22'];

/** FNV-1a — 문자열 → 32bit. 난수 대신 쓰는 결정론적 해시. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const variant = (p) => {
  const h = hash(p.id + '|' + p.name);
  return {
    hair: hex2rgb(HAIR[h % HAIR.length]),
    skin: hex2rgb(SKIN[(h >>> 3) % SKIN.length]),
    kit: hex2rgb(POS_COLOR[p.position] || POS_COLOR.MF),
    tall: (h >>> 7) % 3,      // 체형 변주
    hairStyle: (h >>> 11) % 3,
  };
};

const initials = (name) =>
  name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';

/** 얼굴 플레이스홀더(정사각). 실루엣 + 선수별 색 + (64px 에 한해) 이니셜. */
function drawPortrait(p, S) {
  const v = variant(p);
  const o = img(S, S, [...hex2rgb('#111a1c'), 255]);
  const u = S / 16; // 16 그리드 기준 단위
  const px = (x, y, w, h, c) =>
    fillRect(o, Math.round(x * u), Math.round(y * u), Math.max(1, Math.round(w * u)),
             Math.max(1, Math.round(h * u)), [...c, 255]);

  px(4, 11, 8, 5, v.kit);                       // 어깨(키트색)
  px(4, 3, 8, 8, v.skin);                       // 얼굴
  if (v.hairStyle === 0) px(4, 2, 8, 3, v.hair);            // 짧은 머리
  else if (v.hairStyle === 1) { px(4, 2, 8, 3, v.hair); px(3, 3, 1, 5, v.hair); px(12, 3, 1, 5, v.hair); }
  else { px(4, 1, 8, 4, v.hair); px(3, 2, 10, 2, v.hair); } // 볼륨 머리
  if (S >= 32) { px(6, 7, 1, 1, [20, 20, 20]); px(9, 7, 1, 1, [20, 20, 20]); } // 눈

  if (S >= 64) { // 이니셜은 64px 에서만(작은 크기에선 색으로 구분)
    const t = initials(p.name), sc = 2;
    const x0 = Math.round((S - textWidth(t, sc)) / 2), y0 = S - 5 * sc - 2;
    blendRect(o, x0 - 2, y0 - 1, textWidth(t, sc) + 4, 5 * sc + 2, [10, 12, 14, 210]);
    drawText(t, x0, y0, sc, (x, y) => setPx(o, x, y, [...hex2rgb('#e0d8cf'), 255]));
  }
  return o;
}

/** 전신 플레이스홀더(정사각 셀, 바닥 정렬). */
function drawBody(p, S) {
  const v = variant(p);
  const o = img(S, S);
  const u = S / 16;
  const px = (x, y, w, h, c) =>
    fillRect(o, Math.round(x * u), Math.round(y * u), Math.max(1, Math.round(w * u)),
             Math.max(1, Math.round(h * u)), [...c, 255]);
  const legTop = 10 + v.tall * 0;
  px(6, 1, 4, 3, v.hair);                 // 머리(머리카락)
  px(6, 3, 4, 2, v.skin);                 // 얼굴
  px(5, 5, 6, 5, v.kit);                  // 상체(키트)
  px(4, 5, 1, 4, v.skin); px(11, 5, 1, 4, v.skin); // 팔
  px(5, legTop, 2, 4, shade(v.kit, 0.45)); // 다리
  px(9, legTop, 2, 4, shade(v.kit, 0.45));
  px(10, 13, 3, 3, [245, 245, 245]);      // 공
  px(11, 14, 1, 1, [30, 30, 30]);
  return o;
}

/** 타일들을 격자 아틀라스로 묶는다. */
function atlas(tiles, size) {
  const cols = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / cols);
  const sheet = img(cols * size, rows * size);
  tiles.forEach((t, i) => blit(sheet, t, (i % cols) * size, Math.floor(i / cols) * size));
  return { sheet, cols, rows };
}

const write = (file, im) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG(im));
};

// ── 실행 ───────────────────────────────────────────────────────────
const players = JSON.parse(
  fs.readFileSync(path.join(REPO, 'data/players/players.v2.json'), 'utf8'),
);
// 결정론: 입력 순서에 의존하지 않도록 id 로 정렬
players.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

fs.rmSync(DIST, { recursive: true, force: true });

const manifest = {
  version: 1,
  source: 'default-placeholder',
  note: 'hero 원화 입고 전 임시 에셋. ingest.mjs 산출물이 들어오면 대체된다.',
  playerCount: players.length,
  atlases: {},
  players: {},
};

for (const size of AVATAR_SIZES) {
  const { sheet, cols, rows } = atlas(players.map((p) => drawPortrait(p, size)), size);
  write(path.join(DIST, `avatars-${size}.png`), sheet);
  manifest.atlases[`avatars-${size}`] = { file: `avatars-${size}.png`, tile: size, cols, rows };
}
for (const size of SPRITE_SIZES) {
  const { sheet, cols, rows } = atlas(players.map((p) => drawBody(p, size)), size);
  write(path.join(DIST, `sprites-${size}.png`), sheet);
  manifest.atlases[`sprites-${size}`] = { file: `sprites-${size}.png`, tile: size, cols, rows };
}

// 등급별 카드 프레임 템플릿 — web 이 아바타/스프라이트를 얹어 카드를 만든다.
for (const [grade, g] of Object.entries(GRADE)) {
  const frame = hex2rgb(g.frame);
  const card = composeCard(img(96, 157), { position: 'MF', stars: g.stars, signature: frame, frame });
  write(path.join(DIST, `frame-${grade}.png`), card);
  manifest.atlases[`frame-${grade}`] = { file: `frame-${grade}.png`, w: CARD.w, h: CARD.h, stars: g.stars };
}

const cols = manifest.atlases['avatars-64'].cols;
players.forEach((p, i) => {
  manifest.players[p.id] = {
    index: i, col: i % cols, row: Math.floor(i / cols),
    position: p.position, grade: p.grade, initials: initials(p.name),
  };
});

fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`✓ ${players.length}명 디폴트 에셋 → design/characters/dist/`);
console.log(`  아바타 ${AVATAR_SIZES.join('/')} · 스프라이트 ${SPRITE_SIZES.join('/')} · 프레임 ${Object.keys(GRADE).length}종 + manifest.json`);
