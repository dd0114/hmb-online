#!/usr/bin/env node
// P2 파일럿 입력 생성 (#104) — 레퍼 3장에서 캐릭터 2~3종을 크롭해 incoming/ 에 넣는다.
// ⚠️ 파일럿 전용. 실제 운영에서는 hero 가 SPEC.md 규격대로 직접 incoming/ 에 드롭한다.
// 좌표는 추론이 아니라 크롭→육안 확인으로 확정했다(§2 인지갭 규칙).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from './lib/png.mjs';
import { crop, nearest } from './lib/img.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const REFS = path.join(ROOT, 'refs');
const IN = path.join(ROOT, 'incoming');

// ref-1 (1536×1024) 1단계 얼굴 격자: 90px 셀, x = 133 + 90i, row0 y=75 / row1 y=222
const face = (col, row) => ({ ref: 'ref-1.png', x: 133 + 90 * col, y: row ? 222 : 75, w: 90, h: 90, scale: 6 });
// ref-3-dot (1536×1024) 원본 row: y 164..365 (행 갭 스캔으로 실측).
// 세로 거터를 밝기 프로파일로 실측 → 격자가 균일하지 않아 공식 대신 경계 테이블을 쓴다.
const R3_COL_X = [137, 255, 373, 496, 620, 747, 862, 980, 1085, 1197, 1305, 1417, 1529];
const body = (col) => ({
  ref: 'ref-3-dot.png',
  x: R3_COL_X[col] + 3, y: 166,
  w: R3_COL_X[col + 1] - R3_COL_X[col] - 6, h: 197, scale: 6,
});

const PILOT = [
  { id: 'ragna', portrait: face(0, 0), full: body(0),
    meta: { name: '라그나', title: '불꽃의 스트라이커', position: 'FW', stars: 6,
            desc: '차원을 가르는 강슛, 필드 전체에 볼을 지핀다.' } },
  { id: 'aura', portrait: face(3, 0), full: body(3),
    meta: { name: '아우라', title: '성스러운 골키퍼', position: 'GK', stars: 5,
            desc: '신의 가호로 팀의 골문을 지키며 위기 앞에서 더욱 빛난다.' } },
  { id: 'penguin-king', portrait: face(3, 1), full: body(9),
    meta: { name: '펭킹킹', title: '빙하의 수호자', position: 'GK', stars: 5,
            desc: '차가운 빙벽으로 슈팅을 막아내며 팀을 지키는 왕.' } },
];

const cache = new Map();
const ref = (f) => {
  if (!cache.has(f)) cache.set(f, decodePNG(fs.readFileSync(path.join(REFS, f))));
  return cache.get(f);
};

fs.mkdirSync(IN, { recursive: true });
for (const c of PILOT) {
  for (const variant of ['portrait', 'full']) {
    const r = c[variant];
    const out = nearest(crop(ref(r.ref), r.x, r.y, r.w, r.h), r.w * r.scale, r.h * r.scale);
    fs.writeFileSync(path.join(IN, `${c.id}__${variant}.png`), encodePNG(out));
    console.log(`✓ ${c.id}__${variant}.png  ${out.width}×${out.height}  ← ${r.ref}(${r.x},${r.y},${r.w}×${r.h})`);
  }
  fs.writeFileSync(path.join(IN, `${c.id}.json`), JSON.stringify({ id: c.id, ...c.meta }, null, 2) + '\n');
}
console.log('\n다음: node design/characters/pipeline/ingest.mjs && node design/characters/pipeline/sheet.mjs');
