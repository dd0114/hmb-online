#!/usr/bin/env node
// 라이브 TacticalInput 감사 (#324) — 배포 후 "정말 고쳐졌나"를 같은 자로 다시 재는 도구.
//
// 왜 도구로 남기나: #324 의 두 결함은 성격이 다르다.
//   D1(겹침)   — 산출 게이트(`minSpotSeparation`)가 **막는다**. 기계 백스톱이 있다.
//   D2(좌우)   — "지시가 없으면 기준 좌표를 유지하라"는 **프롬프트 문장뿐**이다. 모델이 무시해도
//                게이트가 잡지 않는다(잡게 만들면 "감독 지시 해석의 자유도" 원칙을 깬다 —
//                `gates.ts` 머리말 참조: 값의 '방향'은 강제하지 않는다).
// 그래서 D2 의 검증 수단은 **배포 후 라이브 재측정**이고, 그 재측정이 매번 손으로 짜는 일회용
// 스크립트라면 다음 사람은 같은 결론에 도달하지 못한다. 자를 리포에 둔다.
//
// 사용 (⚠️ 라이브 원본이 아니라 **사본**을 넘긴다):
//   docker cp hmb-java:/var/lib/hmb/hmb.db /tmp/hmb-copy.db
//   node tools/live-input-audit.mjs /tmp/hmb-copy.db
//
// 읽기 전용 — 쓰기 쿼리를 하지 않는다. sqlite3 CLI 를 통해 JSON 을 뽑는다(의존성 추가 없음).

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** 실행 인자(직접 실행일 때만 채워진다 — 테스트가 상수만 import 할 땐 undefined). */
const dbPath = process.argv[2];

/**
 * sqlite3 로 한 컬럼을 줄 단위로 뽑는다(값에 개행이 없다는 전제 — JSON 은 컴팩트 저장).
 *
 * `-readonly` 를 **먼저** 시도한다. WAL 이 딸린 사본은 readonly 로 못 여는데(-shm 을 만들 수 없다),
 * 그때만 읽기/쓰기로 떨어지고 **경고를 찍는다** — 그 경로로 라이브 볼륨을 직접 가리키면 안 되기 때문.
 */
let warnedRw = false;
function query(sql) {
  const run = (args, quiet) =>
    execFileSync("sqlite3", args, {
      encoding: "utf8",
      maxBuffer: 1 << 30,
      stdio: quiet ? ["ignore", "pipe", "ignore"] : "pipe",
    })
      .split("\n")
      .filter((l) => l.length > 0);
  try {
    return run(["-readonly", dbPath, sql], true);
  } catch {
    if (!warnedRw) {
      warnedRw = true;
      console.warn(
        "⚠️  readonly 로 열 수 없어(WAL 동반 사본) 읽기/쓰기로 엽니다 — **사본인지 확인하세요**.\n" +
          "    라이브 볼륨을 직접 가리키지 마십시오.",
      );
    }
    return run([dbPath, sql]);
  }
}

/**
 * shared `FORMATION_ROWS` 의 사본. 이 파일은 빌드 없이 `node` 로 도는 도구라 TS 를 import 할 수 없어
 * 값을 복제한다 — 그래서 **드리프트 락을 따로 건다**(`tools/live-input-audit.test.ts`).
 * 락이 없으면 shared 를 바꿨을 때 이 도구만 조용히 낡아, 배포 후 재측정이 틀린 자로 재게 된다.
 */
export const ROWS = {
  "4-3-3": [[8, 9, 10], [5, 6, 7], [1, 2, 3, 4], [0]],
  "4-4-2": [[9, 10], [5, 6, 7, 8], [1, 2, 3, 4], [0]],
  "4-2-3-1": [[10], [7, 8, 9], [5, 6], [1, 2, 3, 4], [0]],
  "5-3-2": [[9, 10], [6, 7, 8], [1, 2, 3, 4, 5], [0]],
};

export const MIN_SEPARATION = 0.02; // gates.ts SANITY_GATE_CONFIG 와 같은 값.

// ── 여기부터는 **직접 실행할 때만** 돈다(위 상수는 락 테스트가 import 한다). ──
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!invokedDirectly) {
  // 테스트가 상수만 읽고 끝낼 수 있게.
} else {

if (!dbPath) {
  console.error("사용법: node tools/live-input-audit.mjs <hmb.db 사본 경로>");
  process.exit(2);
}

const rows = query(
  "SELECT h.match_id || '|' || h.half || '|' || m.engine_version || '|' || " +
    "replace(h.home_input_json, char(10), '') || '|' || replace(h.away_input_json, char(10), '') " +
    "FROM match_halves h JOIN matches m ON m.id = h.match_id",
);

let n = 0;
const overlapped = [];
const rowOrder = { ok: 0, scrambled: 0, unknown: 0 };
const mirror = { asc: 0, desc: 0 };

for (const line of rows) {
  const [matchId, half, engine, homeJson, awayJson] = line.split("|");
  for (const [side, json] of [["home", homeJson], ["away", awayJson]]) {
    let ti;
    try {
      ti = JSON.parse(json);
    } catch {
      continue;
    }
    n++;
    const tag = `${matchId.slice(-6)}/h${half}/${side} ${engine}`;
    const ps = ti.players.map((p) => [p.playerId, p.basePosition.x, p.basePosition.y]);

    // ① 겹침 — 게이트가 막아야 하는 것.
    let worst = Infinity;
    let pair = null;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const d = Math.hypot(ps[i][1] - ps[j][1], ps[i][2] - ps[j][2]);
        if (d < worst) {
          worst = d;
          pair = `${ps[i][0]}~${ps[j][0]}`;
        }
      }
    }
    if (worst < MIN_SEPARATION) overlapped.push(`${tag}  ${pair} 간격 ${worst.toFixed(3)}`);

    // ② 좌우 순서 — 게이트가 없는 축. 행 안에서 slotIndex↑ 면 y↑ 여야 한다.
    const layout = ROWS[ti.team?.formation];
    if (!layout) {
      rowOrder.unknown++;
      continue;
    }
    // 인풋은 slotIndex 를 싣지 않는다 — 로스터 순서가 곧 슬롯 순서다(서버가 그렇게 만든다).
    const yBySlot = ps.map((p) => p[2]);
    let scrambled = false;
    for (const row of layout) {
      if (row.length < 2) continue;
      const ys = row.map((i) => yBySlot[i]);
      if (ys.some((v) => v === undefined)) continue;
      const asc = ys.every((v, k) => k === 0 || ys[k - 1] < v);
      const desc = ys.every((v, k) => k === 0 || ys[k - 1] > v);
      if (asc) mirror.asc++;
      else if (desc) mirror.desc++;
      if (!asc) scrambled = true; // 규약은 **오름차순 하나**다. desc = 좌우가 통째로 뒤집힘.
    }
    if (scrambled) rowOrder.scrambled++;
    else rowOrder.ok++;
  }
}

const pct = (x) => `${((100 * x) / Math.max(1, n)).toFixed(1)}%`;
console.log(`\n라이브 TacticalInput ${n}개 감사 (${dbPath})\n`);
console.log(`[D1] 겹침(간격 < ${MIN_SEPARATION}): ${overlapped.length}건 ${pct(overlapped.length)}`);
for (const o of overlapped.slice(0, 20)) console.log(`       ${o}`);
if (overlapped.length > 20) console.log(`       … 외 ${overlapped.length - 20}건`);
console.log(`\n[D2] 보드 좌우 반영: 정상 ${rowOrder.ok} · 어긋남 ${rowOrder.scrambled} · 판정불가 ${rowOrder.unknown}`);
console.log(`       행 방향 분포 — 오름차순(규약) ${mirror.asc} / 내림차순(좌우 반전) ${mirror.desc}`);
console.log(`\n판정 기준: D1 은 0건이어야 한다(게이트가 막는다). D2 는 내림차순이 0 에 수렴해야 한다 —`);
console.log(`asc 와 desc 가 비슷하면 좌우가 여전히 생성마다 뒤집히고 있다는 뜻이다(고치기 전 13:13).\n`);
process.exit(overlapped.length > 0 ? 1 : 0);

}
