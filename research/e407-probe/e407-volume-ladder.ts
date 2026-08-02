/**
 * #407 Phase 2-B — **볼륨 레버 사다리**. 분석 전용, 프로덕션 무수정.
 *
 * 볼륨을 내리는 후보 노브마다 3 rung 이상 사다리를 돌려 **단조성·기울기·부작용**을 동시에 잰다.
 * 5 밴드 지표(슛·골·유효슛·xG/슛·전환) + 구조 지표(패스%·폭·코너·스로인·파울·주행)를 같이 찍는다.
 *
 * 노이즈 규율: `harness.ts` GUARD_SEEDS 주석 — 팀당 슛 SD ≈ 4.2–5.1 → SE(Δ) ≈ 0.47 (60시드).
 * rung 간 참효과가 그 3배(≈1.4슛) 이상 되게 간격을 잡았다.
 *
 * **죽은 노브 대조군**(마지막 사다리): `decisionWeights.shootCentralBonus` 는 chain 코어에서
 * INERT 다(dead-knobs.test.ts). 기울기 0 이 "효과 없음"이 아니라 "배선 안 됨"인 경우를 구분하는
 * 음성 대조군으로 같이 돌린다 — 이 사다리는 **전 지표가 소수점까지 동일**해야 정상이다.
 *
 * 실행:
 *   node tools/run-gate.mjs --label e407-ladder -- npx tsx research/e407-probe/e407-volume-ladder.ts
 * 환경변수: HMB_SEEDS=60 (기본 60) · HMB_LADDERS=gv,tw,xg,range,adv,thr,dead (기본 전부)
 */
import { defaultEngineConfig } from "../../packages/engine/src/config";
import { runPoint, type Acct } from "./e407-volume-account";
import { REALISM_SEEDS, GUARD_SEEDS } from "../../packages/engine/src/realism/harness";

const N = Number(process.env.HMB_SEEDS || 60);
const SEEDS = N > 20 ? GUARD_SEEDS.slice(0, N) : REALISM_SEEDS.slice(0, N);

interface Ladder {
  id: string;
  path: string;
  note: string;
  rungs: number[];
}

const LADDERS: Ladder[] = [
  {
    id: "gv",
    path: "chain.goalValue",
    note: "슛 EV 배수(사슬). 출하 22. LIVE(dead-knobs)",
    rungs: [22, 17, 13, 10, 8],
  },
  {
    id: "tw",
    path: "chain.threatWeight",
    note: "위협 지점에 '서 있는' 가치. 올리면 r=tw/gv 가 올라 슛 대신 유지. 출하 18",
    rungs: [18, 24, 30, 36],
  },
  {
    id: "xg",
    path: "contest.xgBase",
    note: "xG 스케일. 내리면 슛 EV·임계통과·전환이 같이 내려간다. 출하 0.35",
    rungs: [0.35, 0.30, 0.26, 0.22],
  },
  {
    id: "range",
    path: "contest.shootRange",
    note: "슛 후보 생성 사거리(m, 기하 게이트 — 덱 무관). 출하 19",
    rungs: [19, 17, 15, 13],
  },
  {
    id: "adv",
    path: "chain.advanceWeight",
    note: "전진 항 가중(상태가치). 올리면 '더 밀고 가기'가 슛을 이긴다. 출하 1.0",
    rungs: [1.0, 3.0, 6.0, 10.0],
  },
  {
    id: "thr",
    path: "contest.shootXgThreshold",
    note: "⚠️ 절대 xG 컷 — #370 라이브 붕괴의 원인 부류. 참고용 기울기만",
    rungs: [0.07, 0.10, 0.13, 0.16],
  },
  // ── 경로 (a) 사슬 생성 빈도 / (c) 파이널서드 진입을 겨냥한 후보 ────────────────────────
  {
    id: "exp",
    path: "chain.advanceExponent",
    note: "(c) 전진 항 볼록도. 내리면 '앞으로 미는 이득'이 평평해져 리사이클↑·진입↓. 출하 3.0",
    rungs: [3.0, 2.2, 1.6, 1.2],
  },
  {
    id: "turn",
    path: "chain.turnoverWeight",
    note: "(a) 턴오버 손실 계수. 올리면 위험한 수(슛 포함)를 피해 사슬이 길어진다. 출하 0.5",
    rungs: [0.5, 1.0, 1.5, 2.0],
  },
  {
    id: "disc",
    path: "chain.discount",
    note: "(a) 깊이당 시간 할인. 올리면 '한 수 더' 비용이 싸져 사슬이 길어진다. 출하 0.85",
    rungs: [0.85, 0.9, 0.95, 0.99],
  },
  {
    id: "line",
    path: "movement.lineDiscipline",
    note: "(c) 수비 라인 세기. 올리면 라인이 촘촘해져 진입이 준다. 출하 0.65",
    rungs: [0.65, 0.8, 1.0],
  },
  {
    id: "pressR",
    path: "press.unit.rangeM",
    note: "(c) 압박 유닛 반경. 올리면 더 멀리서 붙는다. 출하 22",
    rungs: [22, 26, 30],
  },
  {
    id: "dead",
    path: "decisionWeights.shootCentralBonus",
    note: "음성 대조군 — INERT 여야 한다(전 지표 동일)",
    rungs: [1.35, 2.5, 4.0],
  },
];

const COLS: { k: keyof Acct; d: number; label: string; band?: [number, number] }[] = [
  { k: "shots", d: 2, label: "슛", band: [7.2, 8.4] },
  { k: "goals", d: 2, label: "팀골", band: [1.4, 1.85] },
  { k: "onTarget", d: 2, label: "유효", band: [2.9, 3.5] },
  { k: "xgPerShot", d: 3, label: "xG/슛", band: [0.18, 0.24] },
  { k: "shotConvPct", d: 1, label: "전환%", band: [17, 22] },
  { k: "passSuccessPct", d: 1, label: "패스%", band: [78, 85] },
  { k: "widthM", d: 1, label: "폭m", band: [40, 50] },
  // ⚠️ 카운트형 구조 지표의 BENCH 밴드는 **90분 값**이고 45분 재도출이 안 돼 있다(bench.ts).
  // 여기서는 #365 가 실측한 길이 비(스로인 ×0.496 = 사실상 선형)를 그대로 적용한 **길이보정 밴드**로
  // 판정한다. 비율형(패스%·폭)은 길이 무관이라 그대로 쓴다. — 리포트 §D 참조.
  { k: "corners", d: 2, label: "코너", band: [2.0, 3.0] },
  { k: "throwIns", d: 2, label: "스로인", band: [8.4, 9.4] },
  { k: "fouls", d: 2, label: "파울", band: [5.5, 6.0] },
  { k: "distanceKm", d: 2, label: "주행km", band: [5, 6] },
  { k: "shotsPerF3", d: 3, label: "슛/F3" },
  { k: "f3Entries", d: 1, label: "F3진입" },
];

function fmt(m: Acct): string {
  return COLS.map((c) => {
    const v = m[c.k];
    const s = v.toFixed(c.d);
    const flag = c.band ? (v < c.band[0] ? "-" : v > c.band[1] ? "+" : " ") : " ";
    return (s + flag).padStart(9);
  }).join("");
}

function main(): void {
  const only = (process.env.HMB_LADDERS || "").split(",").filter(Boolean);
  console.log(`# e407 볼륨 레버 사다리 — 시드 ${SEEDS.length}(팀-경기 ${SEEDS.length * 2}), engine@${defaultEngineConfig.version}`);
  console.log("  밴드 표기: '+' = 상한 초과 · '-' = 하한 미달 · ' ' = 밴드 안");
  const header = "rung".padEnd(28) + COLS.map((c) => c.label.padStart(9)).join("");
  for (const L of LADDERS) {
    if (only.length && !only.includes(L.id)) continue;
    console.log(`\n## [${L.id}] ${L.path} — ${L.note}`);
    console.log(header);
    const shots: number[] = [];
    for (const r of L.rungs) {
      const m = runPoint({ [L.path]: r }, SEEDS);
      shots.push(m.shots);
      console.log(`${L.path.split(".").pop()}=${r}`.padEnd(28) + fmt(m));
    }
    const d = shots.map((s, i) => (i === 0 ? 0 : s - shots[i - 1]!));
    console.log(
      `  Δ슛(rung 간): ${d.slice(1).map((x) => x.toFixed(2)).join(" → ")}  | 총효과 ${(shots[shots.length - 1]! - shots[0]!).toFixed(2)} · ${(shots[shots.length - 1]! / shots[0]!).toFixed(3)}배`,
    );
  }
}

main();
