import { describe, it } from "vitest";
import type { MatchLog, TeamSide, TickSnapshot } from "@hmb/shared";
import { runMatch } from "../match";
import { defaultEngineConfig } from "../config";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";

/**
 * E407 ⑧ 데드볼 배치 개편 — **분석 전용 프로브**(구현 아님, 계약 아님).
 *
 * hero: "코너킥 때 선수들이 너무 의무적으로 움직이고 수비도 다 들어와 어색. 그에 비해 골대 가까운
 * 프리킥은 기대가치가 더 높은데 공수 아무도 안 들어옴."
 *
 * 측정은 전부 **MatchLog 스냅샷**에서만 한다(엔진 내부 재계산 없음 = 구현과 같은 실수를 공유하지 않는다).
 * 창 정의는 `corner-rest-defence.test.ts` 의 관용구를 그대로 쓴다(스팟 근처에 공이 있는 마지막 틱 = 차는 틱).
 */

/**
 * ⚠️ **env 가드** — 이 파일은 분석 전용 프로브라 `npm test` 에서는 **돌지 않는다**
 * (`HMB_E407DEADBALL` 없으면 skip). 다시드 시뮬이 표준 게이트에 딸려가면 T1 이 느려지고
 * 게이트 수치가 흔들린다(#376 부하 사고). `e407-goal-probe.test.ts` 의 `HMB_E407GOAL` 과 같은 처방.
 *
 * 실행:
 *   HMB_E407DEADBALL=1 node tools/run-gate.mjs --label e407-deadball -- \
 *     npx vitest run packages/engine/src/realism/e407-deadball-probe.test.ts
 */
const PROBE_ENV = (process as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const RUN_PROBE = !!PROBE_ENV.HMB_E407DEADBALL;

const CFG = defaultEngineConfig;
const W = CFG.pitch.width;
const H = CFG.pitch.height;
const BOX_DEPTH = CFG.rules.penalty.boxDepthM;
const BOX_HALFW = CFG.rules.penalty.boxHalfWidthM;
const SEEDS = REALISM_SEEDS;
/** 세트피스 결과 귀속 창(틱). 차고 나서 이 안에, 그리고 다음 재시작 전이면 그 세트피스의 결과로 센다. */
const OUTCOME_TICKS = 15;
/** 순간 재배치(포메이션 리셋) 제외 임계(m/tick) — deadball-motion.ts 와 같은 기준. */
const TELEPORT_M = 7.5;

type Kind = "corner" | "free_kick";

interface Piece {
  seed: string;
  kind: Kind;
  detail: string | undefined;
  side: TeamSide;
  spot: { x: number; y: number };
  distGoal: number;
  eventTick: number;
  kickTick: number;
  windowTicks: number;
  /** 차는 틱, 공격팀 아웃필더 중 (상대) 박스 안 인원. */
  attInBox: number;
  /** 차는 틱, 수비팀 아웃필더 중 자기 박스 안 인원. */
  defInBox: number;
  /** 차는 틱, 골 25m 안 인원(박스보다 넓은 참여 지표). */
  att25: number;
  def25: number;
  /** 정지 창 동안 아웃필더가 걸은 경로 길이 합(m, taker 제외). */
  travelAtt: number;
  travelDef: number;
  /** 정지 창 변위 가중 정렬도(팀별) = |Σd|/Σ|d|. 1 = 전원이 같은 방향으로 행진. */
  syncAtt: number;
  syncDef: number;
  /** 이 세트피스에서 나온 슛/골(귀속 창 안, 공격팀). */
  shots: number;
  goals: number;
  /** 정규화(공격 프레임) 선수 위치 — 반복성 측정용. key = 슬롯 번호. */
  posByslot: Map<number, { x: number; y: number; side: "att" | "def" }>;
  cornerGroup: string;
}

const gkIds = new Set(["H0", "A0"]);
const slotOf = (id: string): number => Number(id.slice(1));

function goalOf(side: TeamSide): { x: number; y: number } {
  return { x: side === "home" ? W : 0, y: H / 2 };
}

/** 공격 프레임 정규화: 홈은 그대로, 어웨이는 x·y 미러(pitch.ts slotToReal 과 같은 규약). */
function norm(side: TeamSide, p: { x: number; y: number }): { x: number; y: number } {
  return side === "home" ? { x: p.x, y: p.y } : { x: W - p.x, y: H - p.y };
}

function inBox(g: { x: number; y: number }, p: { x: number; y: number }): boolean {
  return Math.abs(p.x - g.x) <= BOX_DEPTH && Math.abs(p.y - g.y) <= BOX_HALFW;
}

function collect(seed: string): Piece[] {
  const log: MatchLog = runMatch(
    seed,
    makeTacticalInput("H", seed),
    makeTacticalInput("A", seed),
    makeSelectData(),
    CFG,
  );
  const byTick = new Map<number, TickSnapshot>(log.tickSnapshots.map((s) => [s.tick, s]));
  const restartTicks = log.events
    .filter((e) => e.type === "kickoff" || e.type === "free_kick" || e.type === "penalty")
    .map((e) => e.tick)
    .sort((a, b) => a - b);

  const out: Piece[] = [];
  for (const e of log.events) {
    const isCorner = e.type === "kickoff" && e.detail === "corner";
    const isFk = e.type === "free_kick";
    if (!isCorner && !isFk) continue;
    if (!e.team) continue;
    const side = e.team;
    const s0 = byTick.get(e.tick);
    if (!s0) continue;
    const spot = { x: s0.ball.x, y: s0.ball.y };

    // 차는 틱 = 공이 스팟 근처에 있는 마지막 틱.
    let kickTick = -1;
    for (let t = e.tick; t <= e.tick + 45; t++) {
      const s = byTick.get(t);
      if (!s) break;
      if (Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y) <= 1.0) kickTick = t;
      else if (kickTick >= 0) break;
    }
    if (kickTick < 0) continue;
    const sk = byTick.get(kickTick);
    if (!sk) continue;

    const g = goalOf(side);
    const defSide: TeamSide = side === "home" ? "away" : "home";
    let attInBox = 0;
    let defInBox = 0;
    let att25 = 0;
    let def25 = 0;
    const posByslot = new Map<number, { x: number; y: number; side: "att" | "def" }>();
    for (const p of sk.players) {
      if (gkIds.has(p.playerId)) continue;
      const d = Math.hypot(p.pos.x - g.x, p.pos.y - g.y);
      if (p.team === side) {
        if (inBox(g, p.pos)) attInBox++;
        if (d <= 25) att25++;
      } else {
        if (inBox(g, p.pos)) defInBox++;
        if (d <= 25) def25++;
      }
      const n = norm(side, p.pos);
      posByslot.set(p.team === side ? slotOf(p.playerId) : 100 + slotOf(p.playerId), {
        x: n.x,
        y: n.y,
        side: p.team === side ? "att" : "def",
      });
    }

    // 정지 창 이동량·동조성.
    const taker = e.playerId;
    let travelAtt = 0;
    let travelDef = 0;
    const sumA = { x: 0, y: 0, abs: 0 };
    const sumD = { x: 0, y: 0, abs: 0 };
    for (let t = e.tick + 1; t <= kickTick; t++) {
      const cur = byTick.get(t);
      const prv = byTick.get(t - 1);
      if (!cur || !prv) break;
      const prevPos = new Map(prv.players.map((p) => [`${p.team}:${p.playerId}`, p.pos]));
      for (const p of cur.players) {
        if (gkIds.has(p.playerId)) continue;
        if (p.playerId === taker && p.team === side) continue;
        const b = prevPos.get(`${p.team}:${p.playerId}`);
        if (!b) continue;
        const dx = p.pos.x - b.x;
        const dy = p.pos.y - b.y;
        const step = Math.hypot(dx, dy);
        if (step > TELEPORT_M) continue;
        if (p.team === side) {
          travelAtt += step;
          sumA.x += dx;
          sumA.y += dy;
          sumA.abs += step;
        } else {
          travelDef += step;
          sumD.x += dx;
          sumD.y += dy;
          sumD.abs += step;
        }
      }
    }

    // 결과 귀속: 차는 틱 이후 OUTCOME_TICKS 안 + 다음 재시작 이전.
    const nextRestart = restartTicks.find((t) => t > kickTick) ?? Infinity;
    const limit = Math.min(kickTick + OUTCOME_TICKS, nextRestart);
    let shots = 0;
    let goals = 0;
    for (const ev of log.events) {
      if (ev.tick <= kickTick || ev.tick > limit) continue;
      if (ev.team !== side) continue;
      if (ev.type === "shot" && ev.detail !== "saved" && ev.detail !== "off_target") shots++;
      if (ev.type === "goal") goals++;
    }

    const nSpot = norm(side, spot);
    out.push({
      seed,
      kind: isCorner ? "corner" : "free_kick",
      detail: e.detail,
      side,
      spot,
      distGoal: Math.hypot(spot.x - g.x, spot.y - g.y),
      eventTick: e.tick,
      kickTick,
      windowTicks: kickTick - e.tick,
      attInBox,
      defInBox,
      att25,
      def25,
      travelAtt,
      travelDef,
      syncAtt: sumA.abs > 0 ? Math.hypot(sumA.x, sumA.y) / sumA.abs : 0,
      syncDef: sumD.abs > 0 ? Math.hypot(sumD.x, sumD.y) / sumD.abs : 0,
      shots,
      goals,
      posByslot,
      cornerGroup: isCorner ? (nSpot.y < H / 2 ? "left" : "right") : "-",
    });
    void defSide;
  }
  return out;
}

const avg = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const f2 = (v: number): string => v.toFixed(2);

/** 그룹 안에서 슬롯별 위치 산포(RMS, m) — 작을수록 "매번 똑같은 자리" = 의무적. */
function repeatability(pieces: Piece[]): { rms: number; n: number; perSlot: [number, number][] } {
  const bySlot = new Map<number, { x: number; y: number }[]>();
  for (const p of pieces) {
    for (const [slot, pos] of p.posByslot) {
      const arr = bySlot.get(slot) ?? [];
      arr.push(pos);
      bySlot.set(slot, arr);
    }
  }
  const perSlot: [number, number][] = [];
  for (const [slot, arr] of [...bySlot].sort((a, b) => a[0] - b[0])) {
    if (arr.length < 3) continue;
    const cx = avg(arr.map((a) => a.x));
    const cy = avg(arr.map((a) => a.y));
    const rms = Math.sqrt(avg(arr.map((a) => (a.x - cx) ** 2 + (a.y - cy) ** 2)));
    perSlot.push([slot, rms]);
  }
  return { rms: avg(perSlot.map((p) => p[1])), n: pieces.length, perSlot };
}

describe.skipIf(!RUN_PROBE)("E407-8 deadball placement probe", () => {
  it("코너 vs 프리킥 비대칭 계측", () => {
    const all: Piece[] = [];
    for (const s of SEEDS) all.push(...collect(s));

    const corners = all.filter((p) => p.kind === "corner");
    const fks = all.filter((p) => p.kind === "free_kick");
    const near = fks.filter((p) => p.distGoal <= 30);
    const mid = fks.filter((p) => p.distGoal > 30 && p.distGoal <= 45);
    const far = fks.filter((p) => p.distGoal > 45);

    const L: string[] = [];
    L.push(`=== E407-8 데드볼 배치 프로브 · ${SEEDS.length}시드 · engine ${CFG.version} ===`);
    L.push(
      `표본: 코너 ${corners.length} (경기당 ${f2(corners.length / SEEDS.length)}) · ` +
        `프리킥 ${fks.length} (경기당 ${f2(fks.length / SEEDS.length)}) ` +
        `[근거리≤30m ${near.length} · 30~45m ${mid.length} · >45m ${far.length}]`,
    );

    const row = (label: string, ps: Piece[]): string =>
      `${label.padEnd(22)} n=${String(ps.length).padStart(4)} | ` +
      `박스 공 ${f2(avg(ps.map((p) => p.attInBox)))} / 수 ${f2(avg(ps.map((p) => p.defInBox)))} | ` +
      `25m 공 ${f2(avg(ps.map((p) => p.att25)))} / 수 ${f2(avg(ps.map((p) => p.def25)))} | ` +
      `정지 ${f2(avg(ps.map((p) => p.windowTicks)))}틱 | ` +
      `이동 공 ${f2(avg(ps.map((p) => p.travelAtt)))}m / 수 ${f2(avg(ps.map((p) => p.travelDef)))}m | ` +
      `동조 공 ${f2(avg(ps.map((p) => p.syncAtt)))} / 수 ${f2(avg(ps.map((p) => p.syncDef)))} | ` +
      `슛 ${f2(avg(ps.map((p) => p.shots)))} 골 ${(avg(ps.map((p) => p.goals)) * 100).toFixed(2)}%`;

    L.push("--- 상황별 (차는 틱 기준, 아웃필더 10명 중) ---");
    L.push(row("코너", corners));
    L.push(row("FK ≤20m", fks.filter((p) => p.distGoal <= 20)));
    L.push(row("FK 20~25m", fks.filter((p) => p.distGoal > 20 && p.distGoal <= 25)));
    L.push(row("FK 25~30m", fks.filter((p) => p.distGoal > 25 && p.distGoal <= 30)));
    L.push(row("FK 30~35m", fks.filter((p) => p.distGoal > 30 && p.distGoal <= 35)));
    L.push(row("FK 35~45m", fks.filter((p) => p.distGoal > 35 && p.distGoal <= 45)));
    L.push(row("FK >45m", far));

    // 프리킥 거리 분포(개편 임팩트 추정용)
    L.push("--- 프리킥 거리 분포 (공격 골대까지 m) ---");
    const buckets = [10, 15, 20, 25, 30, 35, 40, 45, 55, 70, 999];
    let lo = 0;
    for (const hi of buckets) {
      const n = fks.filter((p) => p.distGoal > lo && p.distGoal <= hi).length;
      L.push(`  ${String(lo).padStart(3)}~${String(hi).padStart(3)}m : ${String(n).padStart(4)} (${((n / fks.length) * 100).toFixed(1)}%) · 경기당 ${f2(n / SEEDS.length)}`);
      lo = hi;
    }

    // 기대가치
    const ev = (label: string, ps: Piece[]): string => {
      const sh = ps.reduce((s, p) => s + p.shots, 0);
      const go = ps.reduce((s, p) => s + p.goals, 0);
      return `${label.padEnd(16)} n=${String(ps.length).padStart(4)} · 슛/건 ${f2(sh / Math.max(1, ps.length))} · 골/건 ${((go / Math.max(1, ps.length)) * 100).toFixed(2)}% · 경기당 ${f2(ps.length / SEEDS.length)}건 → 골 ${f2(go / SEEDS.length)}`;
    };
    L.push("--- 기대가치 (차고 나서 15틱 안 · 다음 재시작 전) ---");
    L.push(ev("코너", corners));
    L.push(ev("FK ≤25m", fks.filter((p) => p.distGoal <= 25)));
    L.push(ev("FK 25~30m", fks.filter((p) => p.distGoal > 25 && p.distGoal <= 30)));
    L.push(ev("FK 30~35m", fks.filter((p) => p.distGoal > 30 && p.distGoal <= 35)));
    L.push(ev("FK >35m", fks.filter((p) => p.distGoal > 35)));

    // "너무 의무적" = 매번 같은 자리 (코너 4그룹: 공격 프레임 좌/우)
    L.push("--- 배치 반복성 (같은 코너 그룹 안에서 슬롯별 위치 RMS, m — 작을수록 매번 같은 자리) ---");
    for (const grp of ["left", "right"]) {
      const ps = corners.filter((p) => p.cornerGroup === grp);
      const r = repeatability(ps);
      L.push(`  코너 ${grp.padEnd(5)} n=${r.n} · 평균 RMS ${f2(r.rms)}m`);
      L.push(
        `    슬롯별 RMS: ${r.perSlot
          .map(([s, v]) => `${s < 100 ? "A" : "D"}${s % 100}=${v.toFixed(1)}`)
          .join(" ")}`,
      );
      // 평균 위치(공격 프레임): 골라인까지 거리 · 중앙에서 좌우 오프셋.
      const cen = new Map<number, { dx: number[]; dy: number[] }>();
      for (const p of ps) {
        for (const [slot, pos] of p.posByslot) {
          const c = cen.get(slot) ?? { dx: [], dy: [] };
          c.dx.push(W - pos.x); // 공격 프레임에서 골라인은 x=W.
          c.dy.push(pos.y - H / 2);
          cen.set(slot, c);
        }
      }
      L.push(
        `    평균(골라인까지m, 중앙±m): ${[...cen]
          .sort((a, b) => a[0] - b[0])
          .map(([s, c]) => `${s < 100 ? "A" : "D"}${s % 100}=${avg(c.dx).toFixed(0)}/${avg(c.dy).toFixed(0)}`)
          .join(" ")}`,
      );
    }
    // 대조군: 근거리 프리킥은 스팟이 매번 달라 RMS 가 크게 나온다(비교용 참고치).
    const rn = repeatability(near);
    L.push(`  FK ≤30m (참고, 스팟 가변) n=${rn.n} · 평균 RMS ${f2(rn.rms)}m`);

    // eslint-disable-next-line no-console
    console.log(L.join("\n"));
  }, 600_000);

  /**
   * 2차: ①귀속 창 민감도(코너 슛 0.02 가 창 아티팩트인지) ②코너 크로스 첫 터치 승자
   * ③근거리 FK 골이 **직접 슛**인지 ④차는 틱 도착·동결 상태 ⑤파울 대비 프리킥 수.
   */
  it("귀속 창 민감도 · 첫 터치 · 직접 FK · 도착 상태", () => {
    const L: string[] = [];
    let corners = 0;
    let nearFk = 0;
    const win: Record<string, { cSh: number; cGo: number; fSh: number; fGo: number }> = {};
    for (const w of ["15cut", "30cut", "30nocut", "60nocut"]) win[w] = { cSh: 0, cGo: 0, fSh: 0, fGo: 0 };
    let firstTouchAtt = 0;
    let firstTouchDef = 0;
    let firstTouchNone = 0;
    let directGoal = 0;
    let nearGoalAll = 0;
    let frozenAtKick = 0;
    let outfieldAtKick = 0;
    let lastStepSum = 0;
    let fouls = 0;
    let fkEvents = 0;
    let offsideEvents = 0;
    let cornerFarMoved = 0; // 정지 창 동안 15m 이상 이동한 아웃필더 수(코너)

    for (const seed of SEEDS) {
      const log: MatchLog = runMatch(
        seed,
        makeTacticalInput("H", seed),
        makeTacticalInput("A", seed),
        makeSelectData(),
        CFG,
      );
      fouls += log.events.filter((e) => e.type === "foul").length;
      fkEvents += log.events.filter((e) => e.type === "free_kick").length;
      offsideEvents += log.events.filter((e) => e.type === "offside").length;
      const byTick = new Map<number, TickSnapshot>(log.tickSnapshots.map((s) => [s.tick, s]));
      const restartTicks = log.events
        .filter((e) => e.type === "kickoff" || e.type === "free_kick" || e.type === "penalty")
        .map((e) => e.tick)
        .sort((a, b) => a - b);

      for (const e of log.events) {
        const isCorner = e.type === "kickoff" && e.detail === "corner";
        const isFk = e.type === "free_kick";
        if ((!isCorner && !isFk) || !e.team) continue;
        const side = e.team;
        const s0 = byTick.get(e.tick);
        if (!s0) continue;
        const spot = { x: s0.ball.x, y: s0.ball.y };
        const g = goalOf(side);
        const dist = Math.hypot(spot.x - g.x, spot.y - g.y);
        if (isFk && dist > 25) continue;
        let kickTick = -1;
        for (let t = e.tick; t <= e.tick + 45; t++) {
          const s = byTick.get(t);
          if (!s) break;
          if (Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y) <= 1.0) kickTick = t;
          else if (kickTick >= 0) break;
        }
        if (kickTick < 0) continue;
        if (isCorner) corners++;
        else nearFk++;

        const nextRestart = restartTicks.find((t) => t > kickTick) ?? Infinity;
        for (const [label, span, cut] of [
          ["15cut", 15, true],
          ["30cut", 30, true],
          ["30nocut", 30, false],
          ["60nocut", 60, false],
        ] as [string, number, boolean][]) {
          const limit = cut ? Math.min(kickTick + span, nextRestart) : kickTick + span;
          let sh = 0;
          let go = 0;
          for (const ev of log.events) {
            if (ev.tick <= kickTick || ev.tick > limit || ev.team !== side) continue;
            if (ev.type === "shot" && ev.detail !== "saved" && ev.detail !== "off_target") sh++;
            if (ev.type === "goal") go++;
          }
          if (isCorner) {
            win[label]!.cSh += sh;
            win[label]!.cGo += go;
          } else {
            win[label]!.fSh += sh;
            win[label]!.fGo += go;
          }
        }

        // 차는 틱 도착 상태(아웃필더 마지막 1틱 변위).
        const sk = byTick.get(kickTick);
        const sprev = byTick.get(kickTick - 1);
        if (sk && sprev) {
          const pp = new Map(sprev.players.map((p) => [`${p.team}:${p.playerId}`, p.pos]));
          for (const p of sk.players) {
            if (gkIds.has(p.playerId)) continue;
            const b = pp.get(`${p.team}:${p.playerId}`);
            if (!b) continue;
            const st = Math.hypot(p.pos.x - b.x, p.pos.y - b.y);
            if (st > TELEPORT_M) continue;
            outfieldAtKick++;
            lastStepSum += st;
            if (st < 0.1) frozenAtKick++;
          }
        }

        if (isCorner) {
          // 크로스 이후 **최초로 공을 소유한** 선수의 팀. ⚠️ 다음 재시작 전까지만 본다 —
          // 골이 나면 킥오프 taker(=실점팀)가 소유자가 되어 "수비 첫터치"로 잘못 잡힌다.
          let touched = false;
          for (let t = kickTick + 1; t <= Math.min(kickTick + 12, nextRestart - 1); t++) {
            const s = byTick.get(t);
            if (!s) break;
            if (s.ballOwner) {
              const owner = s.players.find((p) => p.playerId === s.ballOwner);
              if (owner) {
                if (owner.team === side) firstTouchAtt++;
                else firstTouchDef++;
                touched = true;
              }
              break;
            }
          }
          if (!touched) firstTouchNone++;
          // 정지 창 동안 15m 이상 이동한 아웃필더 수.
          const s1 = byTick.get(e.tick);
          if (s1 && sk) {
            const p0 = new Map(s1.players.map((p) => [`${p.team}:${p.playerId}`, p.pos]));
            for (const p of sk.players) {
              if (gkIds.has(p.playerId)) continue;
              const b = p0.get(`${p.team}:${p.playerId}`);
              if (b && Math.hypot(p.pos.x - b.x, p.pos.y - b.y) >= 15) cornerFarMoved++;
            }
          }
        } else {
          // 근거리 FK 골: taker 가 3틱 안에 넣었나(= 직접 프리킥).
          const gEv = log.events.find(
            (ev) => ev.type === "goal" && ev.team === side && ev.tick > kickTick && ev.tick <= kickTick + 15,
          );
          if (gEv) {
            nearGoalAll++;
            if (gEv.tick <= kickTick + 4) directGoal++;
          }
        }
      }
    }

    L.push(`=== E407-8 2차 프로브 · ${SEEDS.length}시드 ===`);
    L.push(`표본: 코너 ${corners} · 근거리 FK(≤25m) ${nearFk}`);
    L.push("--- 귀속 창 민감도 (건당 슛 / 건당 골%) ---");
    for (const [k, v] of Object.entries(win)) {
      L.push(
        `  ${k.padEnd(9)} 코너 슛 ${f2(v.cSh / Math.max(1, corners))} 골 ${((v.cGo / Math.max(1, corners)) * 100).toFixed(2)}% | ` +
          `근FK 슛 ${f2(v.fSh / Math.max(1, nearFk))} 골 ${((v.fGo / Math.max(1, nearFk)) * 100).toFixed(2)}%`,
      );
    }
    const ft = firstTouchAtt + firstTouchDef + firstTouchNone;
    L.push(
      `--- 코너 크로스 첫 터치: 공격 ${firstTouchAtt} (${((firstTouchAtt / ft) * 100).toFixed(1)}%) · ` +
        `수비 ${firstTouchDef} (${((firstTouchDef / ft) * 100).toFixed(1)}%) · 무주공 ${firstTouchNone}`,
    );
    L.push(
      `--- 근거리 FK 골 ${nearGoalAll}건 중 직접(≤4틱) ${directGoal} (${((directGoal / Math.max(1, nearGoalAll)) * 100).toFixed(1)}%)`,
    );
    L.push(
      `--- 차는 틱 상태: 아웃필더 표본 ${outfieldAtKick} · 마지막 1틱 평균 변위 ${(lastStepSum / Math.max(1, outfieldAtKick)).toFixed(3)}m · ` +
        `사실상 정지(<0.1m) ${((frozenAtKick / Math.max(1, outfieldAtKick)) * 100).toFixed(1)}%`,
    );
    L.push(
      `--- 코너 정지 창 15m 이상 이동한 아웃필더: 코너당 ${f2(cornerFarMoved / Math.max(1, corners))}명 / 20명`,
    );
    L.push(
      `--- 이벤트 빈도(경기당): 파울 ${f2(fouls / SEEDS.length)} · 오프사이드 ${f2(offsideEvents / SEEDS.length)} · free_kick ${f2(fkEvents / SEEDS.length)}`,
    );
    // eslint-disable-next-line no-console
    console.log(L.join("\n"));
  }, 600_000);

  /**
   * 3차: **기존 노브로 어디까지 되는가**(config-only 아블레이션). 개편 옵션의 비용을 가르는 근거 —
   * 기존 노브로 해결되면 코드 변경이 필요 없고, 안 되면 구조가 문제라는 뜻이다.
   */
  it("config-only 아블레이션", async () => {
    const { pointConfig } = await import("./harness");
    const arms: [string, Record<string, number>][] = [
      ["ship", {}],
      ["코너 아웃렛 1~2", { "setPiece.corner.leaveHighMin": 1, "setPiece.corner.leaveHighMax": 2 }],
      ["코너 올인(잔류0)", { "setPiece.corner.stayBackMin": 0, "setPiece.corner.stayBackMax": 0 }],
      ["FK shapeReach↑", { "rules.deadBall.shapeReachX": 0.7, "rules.deadBall.shapeReachY": 0.6 }],
      ["FK backup 5/14m", { "setPiece.freeKick.backupCount": 5, "setPiece.freeKick.backupRadiusM": 14 }],
    ];
    const L: string[] = ["=== E407-8 config-only 아블레이션 (20시드) ==="];
    for (const [label, pt] of arms) {
      const cfg = Object.keys(pt).length ? pointConfig(CFG, pt) : CFG;
      let cN = 0, cAtt = 0, cDef = 0, cFtAtt = 0, cFt = 0, cGoal = 0, cShot = 0;
      let fN = 0, fAtt = 0, fDef = 0, fGoal = 0, fShot = 0;
      for (const seed of SEEDS) {
        const log: MatchLog = runMatch(
          seed,
          makeTacticalInput("H", seed),
          makeTacticalInput("A", seed),
          makeSelectData(),
          cfg,
        );
        const byTick = new Map<number, TickSnapshot>(log.tickSnapshots.map((s) => [s.tick, s]));
        for (const e of log.events) {
          const isCorner = e.type === "kickoff" && e.detail === "corner";
          const isFk = e.type === "free_kick";
          if ((!isCorner && !isFk) || !e.team) continue;
          const side = e.team;
          const s0 = byTick.get(e.tick);
          if (!s0) continue;
          const spot = { x: s0.ball.x, y: s0.ball.y };
          const g = goalOf(side);
          if (isFk && Math.hypot(spot.x - g.x, spot.y - g.y) > 25) continue;
          let kt = -1;
          for (let t = e.tick; t <= e.tick + 45; t++) {
            const s = byTick.get(t);
            if (!s) break;
            if (Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y) <= 1.0) kt = t;
            else if (kt >= 0) break;
          }
          const sk = kt >= 0 ? byTick.get(kt) : undefined;
          if (!sk) continue;
          let a = 0;
          let d = 0;
          for (const p of sk.players) {
            if (gkIds.has(p.playerId) || !inBox(g, p.pos)) continue;
            if (p.team === side) a++;
            else d++;
          }
          let sh = 0;
          let go = 0;
          for (const ev of log.events) {
            if (ev.tick <= kt || ev.tick > kt + 30 || ev.team !== side) continue;
            if (ev.type === "shot" && ev.detail !== "saved" && ev.detail !== "off_target") sh++;
            if (ev.type === "goal") go++;
          }
          if (isCorner) {
            cN++; cAtt += a; cDef += d; cShot += sh; cGoal += go;
            for (let t = kt + 1; t <= kt + 12; t++) {
              const s = byTick.get(t);
              if (!s) break;
              if (s.ballOwner) {
                const o = s.players.find((p) => p.playerId === s.ballOwner);
                if (o) { cFt++; if (o.team === side) cFtAtt++; }
                break;
              }
            }
          } else {
            fN++; fAtt += a; fDef += d; fShot += sh; fGoal += go;
          }
        }
      }
      L.push(
        `${label.padEnd(16)} | 코너 n=${cN} 박스 공${f2(cAtt / Math.max(1, cN))}/수${f2(cDef / Math.max(1, cN))} ` +
          `첫터치공${((cFtAtt / Math.max(1, cFt)) * 100).toFixed(1)}% 슛${f2(cShot / Math.max(1, cN))} 골${((cGoal / Math.max(1, cN)) * 100).toFixed(2)}% ` +
          `|| 근FK n=${fN} 박스 공${f2(fAtt / Math.max(1, fN))}/수${f2(fDef / Math.max(1, fN))} ` +
          `슛${f2(fShot / Math.max(1, fN))} 골${((fGoal / Math.max(1, fN)) * 100).toFixed(2)}%`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(L.join("\n"));
  }, 900_000);

  /**
   * 4차: 대표 장면의 **텍스트 피치맵**(스냅샷 좌표를 그대로 찍는다 — 추론 없음).
   * 공격 프레임(오른쪽이 공격 골라인), 세로 = 피치 폭. A=공격 D=수비 G=GK o=공.
   */
  it("대표 장면 피치맵", () => {
    const seed = SEEDS[0]!;
    const log: MatchLog = runMatch(
      seed,
      makeTacticalInput("H", seed),
      makeTacticalInput("A", seed),
      makeSelectData(),
      CFG,
    );
    const byTick = new Map<number, TickSnapshot>(log.tickSnapshots.map((s) => [s.tick, s]));
    const draw = (title: string, sk: TickSnapshot, side: TeamSide): string => {
      const COLS = 62;
      const ROWS = 21;
      const grid: string[][] = Array.from({ length: ROWS }, () => Array(COLS).fill("·"));
      const put = (p: { x: number; y: number }, ch: string): void => {
        const n = norm(side, p);
        const c = Math.max(0, Math.min(COLS - 1, Math.round((n.x / W) * (COLS - 1))));
        const r = Math.max(0, Math.min(ROWS - 1, Math.round((n.y / H) * (ROWS - 1))));
        grid[r]![c] = grid[r]![c] === "·" ? ch : "*";
      };
      for (const p of sk.players) {
        if (gkIds.has(p.playerId)) put(p.pos, "G");
        else put(p.pos, p.team === side ? "A" : "D");
      }
      put(sk.ball, "o");
      return `${title}\n  +${"-".repeat(COLS)}+\n${grid.map((r) => "  |" + r.join("") + "|").join("\n")}\n  +${"-".repeat(COLS)}+  (오른쪽 = 공격 골라인, A=공격 D=수비 G=GK o=공, *=겹침)`;
    };
    const out: string[] = [];
    let gotCorner = false;
    let gotFk = false;
    for (const e of log.events) {
      const isCorner = e.type === "kickoff" && e.detail === "corner";
      const isFk = e.type === "free_kick";
      if ((!isCorner && !isFk) || !e.team) continue;
      const side = e.team;
      const s0 = byTick.get(e.tick);
      if (!s0) continue;
      const spot = { x: s0.ball.x, y: s0.ball.y };
      const g = goalOf(side);
      const dist = Math.hypot(spot.x - g.x, spot.y - g.y);
      if (isFk && (dist > 25 || gotFk)) continue;
      if (isCorner && gotCorner) continue;
      let kt = -1;
      for (let t = e.tick; t <= e.tick + 45; t++) {
        const s = byTick.get(t);
        if (!s) break;
        if (Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y) <= 1.0) kt = t;
        else if (kt >= 0) break;
      }
      const sk = kt >= 0 ? byTick.get(kt) : undefined;
      if (!sk) continue;
      if (isCorner) { gotCorner = true; out.push(draw(`[코너 · seed ${seed} · tick ${kt}]`, sk, side)); }
      else { gotFk = true; out.push(draw(`[근거리 FK ${dist.toFixed(1)}m · seed ${seed} · tick ${kt}]`, sk, side)); }
      if (gotCorner && gotFk) break;
    }
    // eslint-disable-next-line no-console
    console.log(out.join("\n\n"));
  }, 600_000);

  /** 교차검증: 팀-경기 기준 파울/코너 수 (프로브의 이벤트 카운트가 표준 집계와 맞는가). */
  it("표준 집계 교차검증", async () => {
    const { aggregateRealism } = await import("./harness");
    const r = aggregateRealism(CFG, SEEDS);
    // eslint-disable-next-line no-console
    console.log(
      `=== 표준 집계(팀-경기 ${r.teamMatches}) 파울 ${r.mean.fouls} · 코너 ${r.mean.corners} · ` +
        `오프사이드 ${r.mean.offsides} · 슛 ${r.mean.shots} · 골 ${r.mean.goals} · 경기당 골 ${r.goalsPerMatch}`,
    );
  }, 600_000);
});
