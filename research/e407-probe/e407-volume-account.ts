/**
 * #407 Phase 2-A — **볼륨 회계**(어느 상류 단계가 배로 늘었나). 분석 전용, 프로덕션 무수정.
 *
 * 팀당 슛 17.27(밴드 7.2–8.4)을 만드는 상류를 소유 사슬 단위로 분해한다:
 *   소유 시퀀스 수 · 시퀀스 길이 · 시퀀스당 패스 · 파이널서드 진입 · 박스 진입 · 진입당 슛 ·
 *   슛의 xG 분포(임계 0.197 아래 꼬리 비중) · 슛 거리 · 박스 안 슛 비중.
 *
 * 반사실 지점(0.33.0 근사)은 `git checkout` 없이 **config 값 diff 를 그대로 되돌려** 만든다
 * (0.33.0 → 0.40.0 의 기본값 diff 는 9건뿐이고 전부 재현 가능 — 리포트 §A-2 참조).
 *
 * 실행:
 *   node tools/run-gate.mjs --label e407-account -- npx tsx research/e407-probe/e407-volume-account.ts
 * 환경변수: HMB_SEEDS=20|60 (기본 20)
 */
import type { MatchLog, TeamSide } from "@hmb/shared";
import { defaultEngineConfig, type EngineConfig } from "../../packages/engine/src/config";
import { applyConfigOverrides } from "../../packages/engine/src/realism/config-override";
import { REALISM_SEEDS, GUARD_SEEDS } from "../../packages/engine/src/realism/harness";
import { runMatch } from "../../packages/engine/src/match";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures";
import { computeMatchStats, ownerSideOfSnapshot } from "../../packages/engine/dev-viewer/match-stats";

const N = Number(process.env.HMB_SEEDS || 20);
const SEEDS = N > 20 ? GUARD_SEEDS.slice(0, N) : REALISM_SEEDS.slice(0, N);
const GK_IDS = new Set(["H0", "A0"]);
const DEFENDER_IDS = new Set(["H1", "H2", "H3", "H4", "A1", "A2", "A3", "A4"]);
const select = makeSelectData();

/* ── 0.33.0 → 0.40.0 기본값 diff(9건) = 반사실 사다리의 rung ─────────────────────────── */
export const STEP_OVERRIDES: { ver: string; what: string; ov: Record<string, unknown> }[] = [
  {
    ver: "0.31-33",
    what: "M1 데드볼 룰정합+유동 재시작",
    ov: { "rules.restart.gate.enabled": true, "rules.restart.mustKick": true, "setPiece.kickoff.compress": true },
  },
  {
    ver: "0.32.0a",
    what: "M2 배선(슬라이더·duty·press.trigger)",
    ov: { "chain.passDirectnessEnabled": true, "duty.enabled": true, "press.trigger.enabled": true },
  },
  { ver: "0.32.0b", what: "M2 피로 회복항", ov: { "fatigue.recoveryEnabled": true } },
  { ver: "0.34.0", what: "shootXgThreshold 0.197→0.07 (#370 되돌림)", ov: { "contest.shootXgThreshold": 0.07 } },
  { ver: "0.35.0", what: "M3-A 예고 패스 passPlan", ov: { "movement.passPlan.enabled": true } },
  { ver: "0.36.0", what: "M3-C 스루패스 throughPass", ov: { "chain.throughPass.enabled": true } },
  { ver: "0.37.0", what: "M3-B 수비 레인 예측 laneRead", ov: { "vision.laneRead.enabled": true } },
  { ver: "0.38.0", what: "S3-A 압박 유닛 press.unit", ov: { "press.unit.enabled": true } },
  {
    ver: "0.39.0",
    what: "S3-B 공유 수비라인 + 레스트디펜스 + lineDiscipline 0.5→0.65",
    ov: {
      "movement.defLine.enabled": true,
      "movement.restDefence.enabled": true,
      "movement.lineDiscipline": 0.65,
    },
  },
  {
    ver: "0.40.0",
    what: "S3-C 오프사이드 트랩(물리) + rules.offside.trapBiasM 2.5→0",
    ov: { "movement.defLine.trap.enabled": true, "rules.offside.trapBiasM": 0 },
  },
];

/** 0.33.0 근사 = 위 9건을 전부 되돌린 지점. */
export const CF_0330: Record<string, unknown> = {
  "rules.restart.gate.enabled": false,
  "rules.restart.mustKick": false,
  "setPiece.kickoff.compress": false,
  "chain.passDirectnessEnabled": false,
  "duty.enabled": false,
  "press.trigger.enabled": false,
  "fatigue.recoveryEnabled": false,
  "contest.shootXgThreshold": 0.197,
  "movement.passPlan.enabled": false,
  "chain.throughPass.enabled": false,
  "vision.laneRead.enabled": false,
  "press.unit.enabled": false,
  "movement.defLine.enabled": false,
  "movement.restDefence.enabled": false,
  "movement.lineDiscipline": 0.5,
  "movement.defLine.trap.enabled": false,
  "rules.offside.trapBiasM": 2.5,
};

/* ── 회계 ──────────────────────────────────────────────────────────────────────────── */
export interface Acct {
  shots: number;
  goals: number;
  onTarget: number;
  xgPerShot: number;
  /** 슛→골 전환(%) — 팀-경기별 비율의 평균(aggregateRealism 과 같은 정의). */
  shotConvPct: number;
  /** 유효슛 비율(%). */
  onTargetPct: number;
  /** 소유 시퀀스 수(= 상대에게 넘어간 횟수 ≈ 턴오버). */
  seqs: number;
  /** 시퀀스당 평균 틱. */
  seqTicks: number;
  /** 시퀀스당 평균 완결 패스. */
  passPerSeq: number;
  /** 파이널서드 진입 횟수(시퀀스 내 재진입 포함). */
  f3Entries: number;
  /** 박스 진입 횟수. */
  boxEntries: number;
  /** 파이널서드에 한 번이라도 든 시퀀스 비율(%). */
  f3SeqPct: number;
  /** 슛이 난 시퀀스 비율(%). */
  shotSeqPct: number;
  /** 파이널서드 진입 1회당 슛. */
  shotsPerF3: number;
  /** 박스 진입 1회당 슛. */
  shotsPerBox: number;
  /** 소유 틱(공 주인이 이 팀인 틱). */
  ownTicks: number;
  /** 슛 100회당 소유 틱 = "슛 한 번 내는 데 드는 소유 시간". */
  ticksPerShot: number;
  /** 슛 xg < 0.197 비중(%) — 구 임계가 걷어내던 꼬리. */
  lowXgShotPct: number;
  /** 슛 평균 거리(m). */
  shotDistM: number;
  /** 박스 안에서 나온 슛 비중(%). */
  inBoxShotPct: number;
  // 구조 지표(부작용 감시)
  passSuccessPct: number;
  widthM: number;
  corners: number;
  throwIns: number;
  fouls: number;
  distanceKm: number;
}

const F3 = 0.66;

function acctOf(log: MatchLog, cfg: EngineConfig): Record<TeamSide, Acct> {
  const W = cfg.pitch.width;
  const H = cfg.pitch.height;
  const boxDepth = cfg.rules.penalty.boxDepthM;
  const boxHalf = cfg.rules.penalty.boxHalfWidthM;
  const prog = (side: TeamSide, x: number) => (side === "home" ? x / W : 1 - x / W);
  const inBox = (side: TeamSide, x: number, y: number) => {
    const gx = side === "home" ? W : 0;
    return Math.abs(x - gx) <= boxDepth && Math.abs(y - H / 2) <= boxHalf;
  };

  const stats = computeMatchStats(log, GK_IDS, {
    defenderIds: DEFENDER_IDS,
    pitchWidthM: cfg.pitch.width,
    finalThirdLine: cfg.setPiece.finalThirdLine,
  });

  const sides: TeamSide[] = ["home", "away"];
  const z = () => ({ seqs: 0, seqTickSum: 0, f3: 0, box: 0, f3Seqs: 0, shotSeqs: 0, own: 0 });
  const acc: Record<TeamSide, ReturnType<typeof z>> = { home: z(), away: z() };

  // 이벤트를 틱 → 팀별로 인덱싱
  const passAt = new Map<number, Record<TeamSide, number>>();
  const shotAt = new Map<number, Record<TeamSide, number>>();
  const shotSamples: Record<TeamSide, { xg: number; dist: number; inBox: boolean }[]> = { home: [], away: [] };
  const ballAt = new Map<number, { x: number; y: number }>();
  for (const sn of log.tickSnapshots) ballAt.set(sn.tick, sn.ball);
  for (const e of log.events) {
    if (!e.team) continue;
    if (e.type === "pass") {
      const r = passAt.get(e.tick) ?? { home: 0, away: 0 };
      r[e.team] += 1;
      passAt.set(e.tick, r);
    }
    if (e.type === "shot" && e.detail !== "saved" && e.detail !== "off_target") {
      const r = shotAt.get(e.tick) ?? { home: 0, away: 0 };
      r[e.team] += 1;
      shotAt.set(e.tick, r);
      const b = ballAt.get(e.tick);
      if (b) {
        const gx = e.team === "home" ? W : 0;
        shotSamples[e.team].push({
          xg: e.xg ?? 0,
          dist: Math.hypot(b.x - gx, b.y - H / 2),
          inBox: inBox(e.team, b.x, b.y),
        });
      }
    }
  }

  // 소유 시퀀스 주행
  let cur: TeamSide | null = null;
  let seqStart = 0;
  let seqF3 = false;
  let seqShot = false;
  let prevInF3 = false;
  let prevInBox = false;
  const closeSeq = (endTick: number) => {
    if (cur === null) return;
    acc[cur].seqs += 1;
    acc[cur].seqTickSum += endTick - seqStart + 1;
    if (seqF3) acc[cur].f3Seqs += 1;
    if (seqShot) acc[cur].shotSeqs += 1;
  };

  for (const sn of log.tickSnapshots) {
    const side = ownerSideOfSnapshot(sn);
    if (side !== null && side !== cur) {
      closeSeq(sn.tick - 1);
      cur = side;
      seqStart = sn.tick;
      seqF3 = false;
      seqShot = false;
      prevInF3 = false;
      prevInBox = false;
    }
    if (side !== null) acc[side].own += 1;
    if (cur === null) continue;
    const p = prog(cur, sn.ball.x);
    const nowF3 = p >= F3;
    const nowBox = inBox(cur, sn.ball.x, sn.ball.y);
    if (nowF3 && !prevInF3) {
      acc[cur].f3 += 1;
      seqF3 = true;
    }
    if (nowBox && !prevInBox) acc[cur].box += 1;
    prevInF3 = nowF3;
    prevInBox = nowBox;
    if ((shotAt.get(sn.tick)?.[cur] ?? 0) > 0) seqShot = true;
  }
  closeSeq(log.tickSnapshots[log.tickSnapshots.length - 1]!.tick);

  const passTot: Record<TeamSide, number> = { home: 0, away: 0 };
  for (const r of passAt.values()) {
    passTot.home += r.home;
    passTot.away += r.away;
  }

  const out = {} as Record<TeamSide, Acct>;
  for (const s of sides) {
    const a = acc[s];
    const t = s === "home" ? stats.home : stats.away;
    const ss = shotSamples[s];
    const n = ss.length || 1;
    out[s] = {
      shots: t.shots,
      goals: t.goals,
      onTarget: t.onTarget,
      xgPerShot: ss.reduce((x, v) => x + v.xg, 0) / n,
      shotConvPct: t.shots > 0 ? (t.goals / t.shots) * 100 : 0,
      onTargetPct: t.shots > 0 ? (t.onTarget / t.shots) * 100 : 0,
      seqs: a.seqs,
      seqTicks: a.seqs ? a.seqTickSum / a.seqs : 0,
      passPerSeq: a.seqs ? passTot[s] / a.seqs : 0,
      f3Entries: a.f3,
      boxEntries: a.box,
      f3SeqPct: a.seqs ? (a.f3Seqs / a.seqs) * 100 : 0,
      shotSeqPct: a.seqs ? (a.shotSeqs / a.seqs) * 100 : 0,
      shotsPerF3: a.f3 ? t.shots / a.f3 : 0,
      shotsPerBox: a.box ? t.shots / a.box : 0,
      ownTicks: a.own,
      ticksPerShot: t.shots ? a.own / t.shots : 0,
      lowXgShotPct: (ss.filter((v) => v.xg < 0.197).length / n) * 100,
      shotDistM: ss.reduce((x, v) => x + v.dist, 0) / n,
      inBoxShotPct: (ss.filter((v) => v.inBox).length / n) * 100,
      passSuccessPct: t.passSuccessPct,
      widthM: t.avgWidthM,
      corners: t.corners,
      throwIns: t.throwIns,
      fouls: t.fouls,
      distanceKm: t.avgDistanceKm,
    };
  }
  return out;
}

export function runPoint(ov: Record<string, unknown>, seeds: string[] = SEEDS): Acct {
  const cfg = Object.keys(ov).length ? applyConfigOverrides(defaultEngineConfig, ov) : defaultEngineConfig;
  const rows: Acct[] = [];
  for (const seed of seeds) {
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
    const a = acctOf(log, cfg);
    rows.push(a.home, a.away);
  }
  const keys = Object.keys(rows[0]!) as (keyof Acct)[];
  const m = {} as Acct;
  for (const k of keys) m[k] = rows.reduce((s, r) => s + r[k], 0) / rows.length;
  return m;
}

/* ── 출력 ──────────────────────────────────────────────────────────────────────────── */
const COLS: { k: keyof Acct; w: number; d: number; label: string }[] = [
  { k: "shots", w: 6, d: 2, label: "슛" },
  { k: "goals", w: 6, d: 2, label: "골" },
  { k: "onTarget", w: 6, d: 2, label: "유효" },
  { k: "xgPerShot", w: 6, d: 3, label: "xG/슛" },
  { k: "seqs", w: 7, d: 1, label: "시퀀스" },
  { k: "seqTicks", w: 6, d: 2, label: "틱/시퀀스" },
  { k: "passPerSeq", w: 6, d: 2, label: "패스/시퀀스" },
  { k: "f3Entries", w: 7, d: 1, label: "F3진입" },
  { k: "boxEntries", w: 6, d: 1, label: "박스진입" },
  { k: "shotsPerF3", w: 6, d: 3, label: "슛/F3" },
  { k: "shotsPerBox", w: 6, d: 3, label: "슛/박스" },
  { k: "shotSeqPct", w: 6, d: 1, label: "슛시퀀스%" },
  { k: "ticksPerShot", w: 6, d: 1, label: "소유틱/슛" },
  { k: "lowXgShotPct", w: 6, d: 1, label: "xG<.197%" },
  { k: "shotDistM", w: 6, d: 1, label: "슛거리m" },
  { k: "inBoxShotPct", w: 6, d: 1, label: "박스슛%" },
  { k: "passSuccessPct", w: 6, d: 1, label: "패스%" },
  { k: "widthM", w: 6, d: 1, label: "폭m" },
  { k: "corners", w: 5, d: 2, label: "코너" },
  { k: "throwIns", w: 6, d: 2, label: "스로인" },
  { k: "fouls", w: 5, d: 2, label: "파울" },
];

function row(label: string, m: Acct): string {
  return (
    label.padEnd(34) +
    COLS.map((c) => m[c.k].toFixed(c.d).padStart(c.w + 1)).join(" ")
  );
}

function main(): void {
  console.log(`# e407 볼륨 회계 — 시드 ${SEEDS.length} (팀-경기 ${SEEDS.length * 2}), engine@${defaultEngineConfig.version}`);
  console.log("".padEnd(34) + COLS.map((c) => c.label.padStart(c.w + 1)).join(" "));

  const points: { label: string; ov: Record<string, unknown> }[] = [
    { label: "CF base = 0.30.0 근사(전부 되돌림)", ov: { ...CF_0330 } },
  ];
  const cum: Record<string, unknown> = { ...CF_0330 };
  for (const s of STEP_OVERRIDES) {
    Object.assign(cum, s.ov);
    points.push({ label: `+${s.ver} ${s.what.slice(0, 22)}`, ov: { ...cum } });
  }
  points.push({ label: "출하 0.40.0 (오버라이드 0)", ov: {} });

  for (const p of points) console.log(row(p.label, runPoint(p.ov)));
}

if ((process.argv[1] ?? "").endsWith("e407-volume-account.ts")) main();
