import { describe, it, expect } from "vitest";
import type { MatchLog, TeamSide } from "@hmb/shared";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { setPassAimObserver, setDecisionObserver } from "../action";
import type { SimState } from "../simstate";
import { REALISM_SEEDS, aggregateRealism } from "./harness";
import { BENCH, benchVerdict } from "./bench";
import { trapOn } from "./trap";

/**
 * **E407 ⑦ — 오프사이드 룰 검증 프로브**(분석 전용, 판정 아님).
 *
 * 하는 일: 라이브 로그에서 **패스가 플레이된 순간**(= `checkOffside` 가 불리는 그 틱)의 좌표를
 * 스냅샷으로 재구성해 Law 11 로 **독립 재판정**하고, 엔진의 `offside` 이벤트와 대조한다.
 *
 * ⚠️ 판정 시점 정합의 근거(구조 사실): `match.ts:stepTick` 은
 *   ① 오프더볼 목표 결정 → ② **볼 소유자 행동 결정 + `checkOffside`**(라인 588~613)
 *   → ③ `act: 선수 이동`(라인 790) 순이다. 즉 판정 시점의 선수 좌표 = **직전 틱 스냅샷**
 *   (`simulateRange` 가 `stepTick` **후** 스냅샷을 찍으므로 snapshot(T-1) = tick T 시작 좌표).
 *   `realism/trap.ts:measureRefereeLineMismatch` 가 쓰는 것과 같은 관용구다.
 *
 * 관측자 두 개(옵트인·읽기 전용)를 쓴다:
 *  - `setPassAimObserver` — 모든 **패스 결정**(passerId·receiverId·tick). 깃발이 오른 패스도 포함
 *    (`chain.ts` 에서 액션을 만들 때 흘리고, 깃발은 그 **뒤** `match.ts` 가 든다).
 *  - `setDecisionObserver` — 모든 볼 소유자 결정의 **종류**. 재시작 직후 첫 행동이 패스인지
 *    (= 그 패스가 스로인/골킥/코너의 **직접 수령**인지) 가르는 데 쓴다.
 */

/**
 * ⚠️ **env 가드** — 이 파일은 분석 전용 프로브라 `npm test` 에서는 **돌지 않는다**
 * (`HMB_E407OFFSIDE` 없으면 skip). 다시드 시뮬이 표준 게이트에 딸려가면 T1 이 느려지고
 * 게이트 수치가 흔들린다(#376 부하 사고). `e407-goal-probe.test.ts` 의 `HMB_E407GOAL` 과 같은 처방.
 *
 * 실행:
 *   HMB_E407OFFSIDE=1 node tools/run-gate.mjs --label e407-offside -- \
 *     npx vitest run packages/engine/src/realism/e407-offside-probe.test.ts
 */
const PROBE_ENV = (process as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const RUN_PROBE = !!PROBE_ENV.HMB_E407OFFSIDE;

const CFG = defaultEngineConfig;
const W = CFG.pitch.width;
const TOL = CFG.rules.offside.toleranceM;
const select = makeSelectData();

const RESTART_KINDS = new Set(["throw_in", "goal_kick", "corner", "free_kick", "penalty", "kickoff"]);

interface PassSample {
  tick: number;
  side: TeamSide;
  passerId: string;
  receiverId: string;
  gen: string;
}
interface DecisionSample {
  tick: number;
  side: TeamSide;
  ownerId: string;
  kind: string;
}

interface Verdict {
  tick: number;
  side: TeamSide;
  passerId: string;
  receiverId: string;
  /** 재판정 결과 — Law 11 기하(엔진이 구현한 형태 그대로). */
  geoOffside: boolean;
  /** 엔진이 실제로 깃발을 들었나. */
  flagged: boolean;
  recM: number;
  ownerM: number;
  lineM: number;
  /** 이 패스가 재시작(스로인/골킥/코너/프리킥) 직접 수령인가. */
  restartKind: string | null;
}

function progM(side: TeamSide, x: number): number {
  return side === "home" ? x : W - x;
}

interface SeedReport {
  seed: string;
  offsideEvents: number;
  passDecisions: number;
  verdicts: Verdict[];
  /** 스냅샷 부재로 재판정 불가한 패스(하프 첫 틱 등). */
  unadjudicable: number;
  /** 소유 중 상대 오프사이드 라인 앞에 서 있는 우리 선수 평균(공격팀 기준, 상시). */
  offsidePosOccupancy: number;
}

function runSeed(config: EngineConfig, seed: string, patch?: (t: ReturnType<typeof makeTacticalInput>, s: TeamSide) => ReturnType<typeof makeTacticalInput>): SeedReport {
  const passes: PassSample[] = [];
  const decisions: DecisionSample[] = [];
  setPassAimObserver((s) => {
    passes.push({ tick: s.tick, side: s.side as TeamSide, passerId: s.passerId, receiverId: s.receiverId, gen: String(s.gen) });
  });
  setDecisionObserver((st, owner, kind) => {
    decisions.push({ tick: (st as SimState).tick, side: owner.side, ownerId: owner.id, kind: String(kind) });
  });
  let log: MatchLog;
  try {
    const h0 = makeTacticalInput("H", seed);
    const a0 = makeTacticalInput("A", seed);
    log = runMatch(seed, patch ? patch(h0, "home") : h0, patch ? patch(a0, "away") : a0, select, config);
  } finally {
    setPassAimObserver(null);
    setDecisionObserver(null);
  }

  const byTick = new Map<number, MatchLog["tickSnapshots"][number]>();
  for (const sn of log.tickSnapshots) byTick.set(sn.tick, sn);

  // 깃발이 오른 (tick, receiverId, team) 집합.
  const flags = new Set<string>();
  let offsideEvents = 0;
  for (const e of log.events) {
    if (e.type !== "offside") continue;
    offsideEvents++;
    flags.add(`${e.tick}|${e.team}|${e.playerId}`);
  }

  // 재시작 이벤트: tick → {kind, side, takerId}
  const restarts: { tick: number; kind: string; side: TeamSide; takerId: string | undefined }[] = [];
  for (const e of log.events) {
    const kind = e.type === "kickoff" && e.detail ? e.detail : e.type;
    if (!RESTART_KINDS.has(kind) && !RESTART_KINDS.has(e.type)) continue;
    if (!e.team) continue;
    // ⚠️ 스로인/골킥/코너는 `type:"kickoff"` + `detail` 로 실려 온다(`contest.ts:restartThrowIn` 등).
    // `e.type` 을 우선하면 전부 "kickoff" 로 뭉개진다 — detail 이 있으면 그쪽이 실제 종류다.
    restarts.push({ tick: e.tick, kind, side: e.team, takerId: e.playerId ?? undefined });
  }
  restarts.sort((a, b) => a.tick - b.tick);

  // 재시작 **직접 수령** 판정: 재시작 R 이후 **첫 볼소유자 결정**이 그 taker 의 pass 면
  // 그 패스가 곧 재시작 배달이다(중간에 드리블/홀드가 끼면 인플레이가 된 뒤의 패스라 제외).
  decisions.sort((a, b) => a.tick - b.tick);
  const restartDelivery = new Map<string, string>(); // `${tick}|${side}|${passerId}` → kind
  for (const r of restarts) {
    if (!r.takerId) continue;
    const first = decisions.find((d) => d.tick > r.tick);
    if (!first) continue;
    if (first.side !== r.side || first.ownerId !== r.takerId) continue;
    if (first.kind !== "pass") continue;
    restartDelivery.set(`${first.tick}|${first.side}|${first.ownerId}`, r.kind);
  }

  const verdicts: Verdict[] = [];
  let unadjudicable = 0;
  for (const p of passes) {
    const sn = byTick.get(p.tick - 1);
    if (!sn) { unadjudicable++; continue; }
    const rec = sn.players.find((q) => q.playerId === p.receiverId && q.team === p.side);
    const own = sn.players.find((q) => q.playerId === p.passerId && q.team === p.side);
    if (!rec || !own) { unadjudicable++; continue; }
    const defProgs = sn.players.filter((q) => q.team !== p.side).map((q) => progM(p.side, q.pos.x)).sort((a, b) => b - a);
    if (defProgs.length < 2) { unadjudicable++; continue; }
    const lineM = defProgs[1]!;
    const recM = progM(p.side, rec.pos.x);
    const ownerM = progM(p.side, own.pos.x);
    const geoOffside = recM >= W / 2 && recM > ownerM && recM > lineM + TOL;
    verdicts.push({
      tick: p.tick,
      side: p.side,
      passerId: p.passerId,
      receiverId: p.receiverId,
      geoOffside,
      flagged: flags.has(`${p.tick}|${p.side}|${p.receiverId}`),
      recM, ownerM, lineM,
      restartKind: restartDelivery.get(`${p.tick}|${p.side}|${p.passerId}`) ?? null,
    });
  }

  // 오프사이드 **위치** 점유(상시): 소유팀 관점에서 라인 앞에 서 있는 동료 수(GK 제외 불가 —
  // 스냅샷엔 GK 라벨이 없어 id 로 판별: H0/A0).
  let occSum = 0;
  let occN = 0;
  for (const sn of log.tickSnapshots) {
    const owner = sn.ballOwner;
    if (owner == null) continue;
    const or = sn.players.find((q) => q.playerId === owner);
    if (!or) continue;
    const side = or.team as TeamSide;
    const defProgs = sn.players.filter((q) => q.team !== side).map((q) => progM(side, q.pos.x)).sort((a, b) => b - a);
    if (defProgs.length < 2) continue;
    const lineM = defProgs[1]!;
    let n = 0;
    for (const q of sn.players) {
      if (q.team !== side) continue;
      if (q.playerId === owner) continue;
      if (q.playerId === "H0" || q.playerId === "A0") continue;
      const pm = progM(side, q.pos.x);
      if (pm >= W / 2 && pm > lineM + TOL) n++;
    }
    occSum += n;
    occN++;
  }

  return {
    seed,
    offsideEvents,
    passDecisions: passes.length,
    verdicts,
    unadjudicable,
    offsidePosOccupancy: occN ? occSum / occN : 0,
  };
}

function summarize(reports: SeedReport[], label: string): string {
  const n = reports.length;
  const all = reports.flatMap((r) => r.verdicts);
  const geo = all.filter((v) => v.geoOffside);
  const flagged = all.filter((v) => v.flagged);
  const fp = all.filter((v) => v.flagged && !v.geoOffside);
  const missed = all.filter((v) => v.geoOffside && !v.flagged);
  const restartGeo = geo.filter((v) => v.restartKind !== null);
  const restartFlagged = flagged.filter((v) => v.restartKind !== null);
  const offsideEvents = reports.reduce((s, r) => s + r.offsideEvents, 0);
  const passes = reports.reduce((s, r) => s + r.passDecisions, 0);
  const unadj = reports.reduce((s, r) => s + r.unadjudicable, 0);
  const occ = reports.reduce((s, r) => s + r.offsidePosOccupancy, 0) / n;

  const byKind = new Map<string, { all: number; geo: number; flag: number }>();
  for (const v of all) {
    if (!v.restartKind) continue;
    const e = byKind.get(v.restartKind) ?? { all: 0, geo: 0, flag: 0 };
    e.all++;
    if (v.geoOffside) e.geo++;
    if (v.flagged) e.flag++;
    byKind.set(v.restartKind, e);
  }

  const lines: string[] = [];
  lines.push(`### ${label} (시드 ${n} · 팀-경기 ${n * 2})`);
  lines.push(`패스 결정 총 ${passes} (재판정 불가 ${unadj}) · 재판정 표본 ${all.length}`);
  lines.push(`오프사이드 이벤트 ${offsideEvents} = 팀-경기당 ${(offsideEvents / (n * 2)).toFixed(3)} (벤치 1–3)`);
  lines.push(`기하 오프사이드 패스 ${geo.length} = 팀-경기당 ${(geo.length / (n * 2)).toFixed(2)}`);
  lines.push(`깃발 ${flagged.length} / 기하 ${geo.length} = 실효 콜율 ${geo.length ? ((flagged.length / geo.length) * 100).toFixed(2) : "-"}% (config callProb ${CFG.rules.offside.callProb})`);
  lines.push(`**오심(FP: 깃발 O · 기하 X)** ${fp.length}`);
  lines.push(`**누락(FN: 기하 O · 깃발 X)** ${missed.length} = 팀-경기당 ${(missed.length / (n * 2)).toFixed(2)}`);
  lines.push(`재시작 직접수령 패스 중 기하 오프사이드 ${restartGeo.length} · 그중 깃발 ${restartFlagged.length}`);
  for (const [k, v] of [...byKind.entries()].sort()) lines.push(`  - ${k}: 배달표본 ${v.all} · 기하 ${v.geo} · 깃발 ${v.flag}`);
  lines.push(`오프사이드 **위치** 상시 점유(소유 틱 평균, GK 제외) ${occ.toFixed(3)}명`);
  if (fp.length) {
    lines.push(`FP 사례(최대 10):`);
    for (const v of fp.slice(0, 10)) lines.push(`  t${v.tick} ${v.side} ${v.passerId}→${v.receiverId} rec ${v.recM.toFixed(2)} owner ${v.ownerM.toFixed(2)} line ${v.lineM.toFixed(2)}`);
  }
  lines.push(`FN 사례(최대 12 — 손검증용 좌표):`);
  for (const v of missed.slice(0, 12)) {
    lines.push(`  seed? t${v.tick} ${v.side} ${v.passerId}→${v.receiverId} rec ${v.recM.toFixed(2)}m owner ${v.ownerM.toFixed(2)}m line ${v.lineM.toFixed(2)}m (초과 ${(v.recM - v.lineM - TOL).toFixed(2)}m)`);
  }
  return lines.join("\n");
}

describe.skipIf(!RUN_PROBE)("E407 ⑦ 오프사이드 라이브 검증", () => {
  it("출하 config(0.40.0) · REALISM_SEEDS 20 — 독립 재판정 대조", () => {
    const reports = REALISM_SEEDS.map((s) => runSeed(CFG, s));
    const out = summarize(reports, "출하(트랩 off)");
    // 시드별 원자료도 남긴다(손검증 재현용).
    const per = reports.map((r) => {
      const g = r.verdicts.filter((v) => v.geoOffside).length;
      const f = r.verdicts.filter((v) => v.flagged).length;
      return `  ${r.seed}: 깃발 ${f} · 기하 ${g} · 패스 ${r.passDecisions} · 점유 ${r.offsidePosOccupancy.toFixed(2)}`;
    });
    // 첫 시드의 FN 사례를 좌표째 남긴다(손검증 대상).
    const s0 = reports[0]!;
    const s0fn = s0.verdicts.filter((v) => v.geoOffside && !v.flagged).slice(0, 8)
      .map((v) => `  [${s0.seed}] t${v.tick} ${v.side} ${v.passerId}→${v.receiverId} rec ${v.recM.toFixed(2)} owner ${v.ownerM.toFixed(2)} line ${v.lineM.toFixed(2)}`);
    const s0flag = s0.verdicts.filter((v) => v.flagged)
      .map((v) => `  [${s0.seed}] FLAG t${v.tick} ${v.side} ${v.passerId}→${v.receiverId} rec ${v.recM.toFixed(2)} owner ${v.ownerM.toFixed(2)} line ${v.lineM.toFixed(2)} geo=${v.geoOffside}`);
    console.log("\n" + out + "\n시드별:\n" + per.join("\n") + "\n첫시드 FN 표본:\n" + s0fn.join("\n") + "\n첫시드 깃발 전량:\n" + s0flag.join("\n"));
    expect(reports.length).toBe(20);
  }, 900_000);

  it("트랩 ON(양팀) — 콜 배수·기하 변화", () => {
    const reports = REALISM_SEEDS.slice(0, 8).map((s) => runSeed(CFG, s, trapOn("both")));
    console.log("\n" + summarize(reports, "트랩 ON(양팀, 8시드)"));
    expect(reports.length).toBe(8);
  }, 900_000);

  it("벤치 대조 — 출하 20시드 팀-경기 평균(aggregateRealism, 단일 출처)", () => {
    const agg = aggregateRealism(CFG, REALISM_SEEDS);
    const b = BENCH.find((x) => x.key === "offsides")!;
    console.log(
      `\n[bench] ${CFG.version} offsides = ${agg.mean.offsides} ±${agg.sd.offsides} (밴드 ${b.lo}–${b.hi}) → ${benchVerdict(agg.mean.offsides, b)}` +
      `\n[bench] 참고: fouls ${agg.mean.fouls} · corners ${agg.mean.corners} · shots ${agg.mean.shots} · goals ${agg.mean.goals}`,
    );
    expect(agg.teamMatches).toBe(40);
  }, 900_000);

  it("귀속 아블레이션 — 기하 오프사이드 빈도가 무엇에 매여 있나(8시드)", () => {
    const arms: [string, EngineConfig][] = [
      ["출하", CFG],
      ["defLine off(0.38 이전 라인)", { ...CFG, movement: { ...CFG.movement, defLine: { ...CFG.movement.defLine, enabled: false } } }],
      ["chain.mode=weighted(구 코어)", { ...CFG, chain: { ...CFG.chain, mode: "weighted" as const } }],
      ["throughPass off", { ...CFG, chain: { ...CFG.chain, throughPass: { ...CFG.chain.throughPass, enabled: false } } }],
      ["callProb 0.04", { ...CFG, rules: { ...CFG.rules, offside: { ...CFG.rules.offside, callProb: 0.04 } } }],
      ["callProb 0.06", { ...CFG, rules: { ...CFG.rules, offside: { ...CFG.rules.offside, callProb: 0.06 } } }],
    ];
    const lines: string[] = [];
    for (const [label, c] of arms) {
      const reports = REALISM_SEEDS.slice(0, 8).map((s) => runSeed(c, s));
      const all = reports.flatMap((r) => r.verdicts);
      const geo = all.filter((v) => v.geoOffside).length;
      const flag = reports.reduce((s, r) => s + r.offsideEvents, 0);
      const occ = reports.reduce((s, r) => s + r.offsidePosOccupancy, 0) / reports.length;
      lines.push(
        `${label}: 깃발/팀-경기 ${(flag / 16).toFixed(3)} · 기하/팀-경기 ${(geo / 16).toFixed(2)} · 패스/팀-경기 ${(all.length / 16).toFixed(1)} · 라인앞 상시점유 ${occ.toFixed(3)}`,
      );
    }
    console.log("\n### 아블레이션(8시드)\n" + lines.join("\n"));
    expect(lines.length).toBe(6);
  }, 1_800_000);

  it("callProb=1 반사실 — 기하 판정만 남겼을 때의 콜 빈도(설계 상한)", () => {
    const c: EngineConfig = {
      ...CFG,
      rules: { ...CFG.rules, offside: { ...CFG.rules.offside, callProb: 1, trapCallMult: 1 } },
    };
    const reports = REALISM_SEEDS.slice(0, 8).map((s) => runSeed(c, s));
    console.log("\n" + summarize(reports, "callProb=1(8시드)"));
    expect(reports.length).toBe(8);
  }, 900_000);
});

/**
 * **손검증용 원자료 덤프** — 위 프로브의 헬퍼를 쓰지 않고 스냅샷 행을 그대로 찍는다.
 * (자기 헬퍼로 자기 헬퍼를 검증하면 동어반복이므로, 여기서는 좌표 원본만 낸다.)
 */
describe.skipIf(!RUN_PROBE)("E407 ⑦ 손검증 — 원자료 덤프", () => {
  it("seed 4815162342 의 깃발 틱 · FN 틱 raw 스냅샷", () => {
    const seed = "4815162342";
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, CFG);
    const byTick = new Map<number, MatchLog["tickSnapshots"][number]>();
    for (const sn of log.tickSnapshots) byTick.set(sn.tick, sn);
    const dump = (t: number, note: string): string => {
      const sn = byTick.get(t);
      if (!sn) return `t${t}: 스냅샷 없음`;
      const row = (team: string) =>
        sn.players.filter((p) => p.team === team)
          .map((p) => `${p.playerId}=${p.pos.x.toFixed(2)}`)
          .join(" ");
      return `--- t${t} (${note}) ball=(${sn.ball.x.toFixed(2)},${sn.ball.y.toFixed(2)}) owner=${sn.ballOwner}\n  home x: ${row("home")}\n  away x: ${row("away")}`;
    };
    const evs = log.events.filter((e) => e.type === "offside").map((e) => `offside t${e.tick} team=${e.team} player=${e.playerId}`);
    console.log(
      "\n=== 손검증 raw (피치 길이 " + CFG.pitch.width + "m, home 은 +x 공격 · away 는 -x 공격) ===\n" +
      evs.join("\n") + "\n" +
      [dump(1627, "깃발 t1628 의 판정 시점"), dump(1628, "이벤트 틱(재시작 배치 섞임)"),
       dump(59, "FN t60 판정 시점"), dump(946, "FN t947 판정 시점"), dump(995, "FN t996 판정 시점")].join("\n"),
    );
    expect(evs.length).toBeGreaterThan(0);
  }, 300_000);
});

/** 파생 — 오프사이드 라인이 **패스 후보 생성**을 얼마나 자르는가(스루패스 생성 게이트). */
describe.skipIf(!RUN_PROBE)("E407 ⑦ 파생 — 스루패스 생성 게이트에서 오프사이드가 자르는 양", () => {
  it("measureThrough 게이트 분해(8시드)", async () => {
    const { measureThrough } = await import("./through");
    const r = measureThrough(CFG, REALISM_SEEDS.slice(0, 8));
    const g = r.gates;
    const tot = g.mates || 1;
    console.log(
      `\n[through gates 8시드] 심사쌍 ${g.mates}\n` +
      `  이미 오프사이드라 제외 ${g.offside} (${((g.offside / tot) * 100).toFixed(2)}%)\n` +
      `  전진 중 아님 ${g.notRunning} · 라인 뒤 아님 ${g.notBehind} · 전진이득 없음 ${g.noForward}\n` +
      `  러너 늦음 ${g.runnerLate} · 경주 패배 ${g.lostRace} · **생성 ${g.generated}** · 채택 ${r.pickedThrough}\n` +
      `  라인 앞 공격수(경기당 틱합 기준) ${r.behindLineAttackers.toFixed(1)}`,
    );
    expect(g.mates).toBeGreaterThan(0);
  }, 600_000);
});

/** 파생 — "공보다 뒤"를 **소유자 좌표**로 대신 쓰는 근사의 오차(공↔소유자 x 거리). */
describe.skipIf(!RUN_PROBE)("E407 ⑦ 파생 — 소유자 좌표 ≈ 공 좌표 근사의 오차", () => {
  it("소유 틱의 |ball.x − owner.x| 분포(8시드)", () => {
    const d: number[] = [];
    for (const seed of REALISM_SEEDS.slice(0, 8)) {
      const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, CFG);
      for (const sn of log.tickSnapshots) {
        if (sn.ballOwner == null) continue;
        const o = sn.players.find((p) => p.playerId === sn.ballOwner);
        if (!o) continue;
        d.push(Math.abs(sn.ball.x - o.pos.x));
      }
    }
    d.sort((a, b) => a - b);
    const q = (f: number) => d[Math.min(d.length - 1, Math.floor(d.length * f))]!;
    console.log(`\n[owner≈ball 근사 오차, n=${d.length}] p50 ${q(0.5).toFixed(2)}m · p90 ${q(0.9).toFixed(2)}m · p99 ${q(0.99).toFixed(2)}m · max ${d[d.length - 1]!.toFixed(2)}m`);
    expect(d.length).toBeGreaterThan(1000);
  }, 600_000);
});
