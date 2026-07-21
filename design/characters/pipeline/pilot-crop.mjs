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

// ref-2 에서 읽은 12캐릭터 메타 + measurements 의 시그니처 실측색.
// face(col,row): ref-1 얼굴 격자 / body(col): ref-3 전신 격자 — 순서 동일.
// 배경 제거값 — 자동 선택하지 않는다(ingest.mjs clean() 주석 참조).
// 진단 스윕이 제안한 값을 **24장 전부 마젠타 렌더로 육안 확인**해 확정했다.
// 어두운 캐릭터(나츠트·바르크·벨라)는 제약을 통과한 후보가 없어 손으로 잡았다.
const BGTOL = {
  "ragna": {
    "portrait": {
      "localTol": 16,
      "globalTol": 30
    },
    "full": {
      "localTol": 6,
      "globalTol": 60
    }
  },
  "sail": {
    "portrait": {
      "localTol": 20,
      "globalTol": 30
    },
    "full": {
      "localTol": 12,
      "globalTol": 30
    }
  },
  "lupus": {
    "portrait": {
      "localTol": 11,
      "globalTol": 40
    },
    "full": {
      "localTol": 12,
      "globalTol": 30
    }
  },
  "aura": {
    "portrait": {
      "localTol": 11,
      "globalTol": 60
    },
    "full": {
      "localTol": 18,
      "globalTol": 255
    }
  },
  "natzt": {
    "portrait": {
      "localTol": 24,
      "globalTol": 30
    },
    "full": {
      "localTol": 6,
      "globalTol": 30
    }
  },
  "mio": {
    "portrait": {
      "localTol": 24,
      "globalTol": 60
    },
    "full": {
      "localTol": 12,
      "globalTol": 90
    }
  },
  "leo": {
    "portrait": {
      "localTol": 14,
      "globalTol": 60
    },
    "full": {
      "localTol": 9,
      "globalTol": 60
    }
  },
  "riya": {
    "portrait": {
      "localTol": 18,
      "globalTol": 60
    },
    "full": {
      "localTol": 9,
      "globalTol": 60
    }
  },
  "anubis": {
    "portrait": {
      "localTol": 18,
      "globalTol": 30
    },
    "full": {
      "localTol": 9,
      "globalTol": 40
    }
  },
  "penguin-king": {
    "portrait": {
      "localTol": 14,
      "globalTol": 30
    },
    "full": {
      "localTol": 11,
      "globalTol": 90
    }
  },
  "bark": {
    "portrait": {
      "localTol": 8,
      "globalTol": 40
    },
    "full": {
      "localTol": 6,
      "globalTol": 30
    }
  },
  "bella": {
    "portrait": {
      "localTol": 4,
      "globalTol": 30
    },
    "full": {
      "localTol": 6,
      "globalTol": 30
    }
  }
};

const C = (id, name, title, position, stars, sig, frame, fc, fr, bc) => ({
  id, portrait: face(fc, fr), full: body(bc),
  meta: { name, title, position, stars, signature: sig, ...(frame ? { frame } : {}), bgTol: BGTOL[id] },
});

const PILOT = [
  C('ragna', '라그나', '불꽃의 스트라이커', 'FW', 6, '#f7a051', '#c82813', 0, 0, 0),
  C('sail', '세일', '바람의 미드필더', 'MF', 5, '#66d8bd', '#50a1d3', 1, 0, 1),
  C('lupus', '루프스', '숲의 수호자', 'DF', 5, '#95d36d', '#aa8e3e', 2, 0, 2),
  C('aura', '아우라', '성스러운 골키퍼', 'GK', 5, '#eec830', '#f1bc47', 3, 0, 3),
  C('natzt', '나츠트', '암흑의 드리블러', 'FW', 5, '#a864c8', '#3a266b', 4, 0, 4),
  C('mio', '미오', '번개의 테크니션', 'MF', 5, '#45b4e5', '#1d4776', 5, 0, 5),
  C('leo', '레오', '사자의 수비수', 'DF', 5, '#d84515', null, 0, 1, 6),
  C('riya', '리야', '자연의 연주자', 'MF', 5, '#69cd68', null, 1, 1, 7),
  C('anubis', '아누비스', '사막의 침투자', 'FW', 5, '#8b6227', null, 2, 1, 8),
  C('penguin-king', '펭킹킹', '빙하의 수호자', 'GK', 5, '#326e8a', null, 3, 1, 9),
  C('bark', '바르크', '미노타우로스', 'DF', 5, '#b2823c', null, 4, 1, 10),
  C('bella', '벨라', '마도학자', 'MF', 5, '#983eb4', null, 5, 1, 11),
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
