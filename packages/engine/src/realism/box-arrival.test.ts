import { describe, it, expect } from "vitest";
import type { MatchLog, TeamSide, TickSnapshot } from "@hmb/shared";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { runMatch } from "../match";
import { applyBoxArrival } from "../teamplan";
import { buildById, type SimPlayer, type SimState } from "../simstate";
import { createPitch } from "../pitch";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { reconstructTransfers } from "./deepen";
import { computeMatchStats } from "../../dev-viewer/match-stats";
import { REALISM_SEEDS } from "./harness";
import { LADDER, LADDER_TAG } from "./gate";

/**
 * #407 **N2 조건부 박스 도착런** 계약 (engine@0.43.0, QA 상시 트랙 #25 산하).
 * 구현 노트 = `issues/2026-08-03-engine-box-arrival-runs.md`.
 *
 * ## 무엇을 박제하나
 * Phase 2-B(`research/e407-volume-diversity.md` §7-2)가 확정한 **세 개의 벽** 중 **벽 1**.
 *
 * `decision.ts:decideOffBall` 의 인포제션 폭 항은 `widthDir` 이 **자기 base 부호 기준 바깥**이라
 * 언제나 밖으로만 민다 — **안으로 미는 항이 한 줄도 없다**. 그래서 박스 안 수신을 ST 가 86%
 * 독점하고(팀-경기당 ST 4.45 vs 나머지 합 0.72), "먼 슛을 살려도 그 먼 슛을 쏘는 것도 ST"
 * 라는 N1 단독 실패(0.41.0)로 이어졌다. N2 는 그 빠진 항을 **조건부로** 만든다.
 *
 * ## ⚠️ 출하 기본은 `boxArrival.enabled=false` 다 (측정 결과)
 * 기제는 설계대로 작동한다 — 60시드 짝 대조에서 비ST 박스수신 0.72 → **1.04~1.22** ·
 * 박스ST% 86.1 → **80.4** · HHI 0.904 → **0.895** 를 **팀 폭 45.9(밴드) · 스로인 11.8(생존)**
 * 로 얻는다(전역 우회는 같은 효과에 폭 37.1 · 스로인 1.09). 그러나 **파울이 5.09 → 4.10~4.70
 * 으로 악화**하고(hero AC 의 하드 제약) 1대1·패스·전환이 따라 내려가며, 정작 노린
 * **비ST 슛은 0.85 → 0.87 로 평평**하다. 그래서 켤 수 없다 — 상세는 `config.ts` 주석과 노트 §3.
 * 아래 효과 계약들이 **`enabled:true` 를 명시적으로 켜서** 기제를 검정하는 이유가 이것이다
 * (`shot-distance-decay.test.ts` 의 N1 과 같은 처방: 노브가 살아 있다는 것과 그 값이 출하값이라는
 * 것은 다른 문제이고, 여기가 지키는 것은 전자다).
 *
 * ## ⚠️ 이 파일의 절반은 **"전역이 아님"을 지키는 계약**이다
 * 같은 효과를 전역으로 내는 길이 이미 측정돼 있고(`movement.attackWidthReach` 0.10→−0.10 →
 * 비ST 박스수신 0.54→**7.60**), 그 길은 **팀 폭 46.8→37.1 · 스로인 10.15→1.09** 로 경기를
 * 부순다(60시드, Phase 2-B §7-1). 그래서 여기서는
 *  ⓐ 게이트(발화 문턱 · 자기팀 소유 · 박스 밖 · 와이드 출신)가 **실재하는가**를 직접 호출로 재고,
 *  ⓑ 전역 팔이 폭 밴드를 **실제로 깨는 것**을 같은 자로 확인해 조건부 팔이 살아 있음을 대조한다.
 * ⓑ 가 없으면 "폭이 밴드 안" 계약은 자기 자신에 대해 참일 뿐 아무것도 안 문다.
 *
 * ## 규율
 * 게이트 계약은 **직접 호출**(합성 상태 · 0 매치), 효과 계약은 **소시드(≤12)** 다.
 * 밴드 판정(60시드)은 `research/e407-probe/e407-diversity.ts` 가 맡는다.
 */

const cfg = defaultEngineConfig;
const select = makeSelectData();

/** config 를 깊은 복사해 부분 수정(`shot-distance-decay.test.ts` 와 같은 관용구). */
function tweak(mutate: (c: EngineConfig) => void): EngineConfig {
  const c = JSON.parse(JSON.stringify(cfg)) as EngineConfig;
  mutate(c);
  return c;
}

/** 기제를 켠 config — 출하 기본이 off 라 게이트·효과 계약은 이걸 쓴다. */
const ON = tweak((c) => { c.movement.boxArrival.enabled = true; });

const SEEDS8 = REALISM_SEEDS.slice(0, 8);
const SEEDS12 = REALISM_SEEDS.slice(0, 12);

/* ------------------------------------------------------------------ *
 * A. 게이트 — 조건 밖에서는 **한 바이트도 안 쓴다** (직접 호출)
 *
 * 왜 매치가 아니라 직접 호출인가: "조건 밖에서 no-op"은 **부재**에 대한 주장이라,
 * 매치 집계로는 "차이가 작다"밖에 말할 수 없다. 여기서는 목표 좌표를 바이트로 비교한다.
 * ------------------------------------------------------------------ */

const pitch = createPitch(cfg);
const SCALE = cfg.fixedScale;
const M = (m: number): number => Math.round(m * SCALE);

/**
 * `applyBoxArrival` 이 실제로 읽는 필드만 갖춘 합성 선수.
 * (side · isGK · id · idHash · posFx · targetFx · baseFx · runOrder — 그 외는 안 읽는다.
 *  이 목록이 곧 이 함수의 입력 계약이고, 필드가 늘면 여기서 컴파일이 깨져 드러난다.)
 */
function synthPlayer(
  id: string,
  side: TeamSide,
  xM: number,
  yM: number,
  baseYM: number,
  isGK = false,
): SimPlayer {
  const pos = { x: M(xM), y: M(yM) };
  return {
    id,
    side,
    role: "OUT",
    duty: "support",
    behavior: {} as SimPlayer["behavior"],
    mentalModifier: 0,
    attrs: {} as SimPlayer["attrs"],
    baseFx: { x: pos.x, y: M(baseYM) },
    posFx: { ...pos },
    // 목표 = 지금 자리(= "decideOffBall 이 아무것도 안 했다"). 이 함수의 순수한 기여만 보인다.
    targetFx: { ...pos },
    fatigue: 0,
    isGK,
    idHash: id.charCodeAt(1),
    dribbleStreak: 0,
    yellowCards: 0,
    seen: {},
    runOrder: null,
  } as SimPlayer;
}

/**
 * 합성 상태 — 홈이 상대 골(x=105) 쪽으로 공격하고, `ballXM` 자리에서 `ownerId` 가 공을 잡고 있다.
 * 러너 후보는 y=8(왼쪽 터치라인 근처, base y 8)에 세운다 = "박스 밖 · 전진 · 와이드" 그림.
 */
function synthState(ballXM: number, owned: boolean): { state: SimState; runner: SimPlayer } {
  const owner = synthPlayer("H9", "home", ballXM, 34, 34);
  const runner = synthPlayer("H8", "home", ballXM, 8, 8);
  const players = [owner, runner];
  const state = {
    players,
    byId: buildById(players),
    ball: {
      posFx: { x: M(ballXM), y: M(34) },
      owner: owned ? "H9" : null,
      ownerSide: owned ? ("home" as TeamSide) : null,
      flight: null,
    },
    score: { home: 0, away: 0 },
    possession: "home" as TeamSide,
    tick: 10,
    seedHash: 1,
    teams: {} as SimState["teams"],
    stoppage: 0,
    setPiece: null,
    possessionSince: 0,
    lastTurnover: null,
    plan: { home: { lineX: 0, blockDepth: 0 }, away: { lineX: 0, blockDepth: 0 } },
    phase: { home: "open", away: "open" },
    intents: [],
  } as unknown as SimState;
  return { state, runner };
}

/** 파이널서드 안쪽 x(m). `setPiece.finalThirdLine` 0.66 × 105 = 69.3m 이므로 여유 있게. */
const F3_X = 85;
/** 파이널서드 **밖** x(m). */
const MID_X = 55;

describe("#407 N2 게이트 — 조건 밖에서는 런을 한 건도 발행하지 않는다", () => {
  it("파이널서드 + 자기팀 소유 + 박스 밖 → 박스 안 도착 슬롯으로 런 오더가 발행된다", () => {
    const { state, runner } = synthState(F3_X, true);
    applyBoxArrival(state, ON, pitch);
    const ba = ON.movement.boxArrival;
    const ro = runner.runOrder;
    expect(ro, "런 오더가 발행돼야 한다").toBeTruthy();
    // 도착 슬롯은 골라인에서 `arrivalDepthM`, 횡편차는 `arrivalHalfWidthM` 로 클램프된 지점이다.
    expect(ro!.xFx).toBe(pitch.wFx - M(ba.arrivalDepthM));
    expect(ro!.yFx).toBe(Math.round(pitch.hFx / 2) - M(ba.arrivalHalfWidthM));
    // ⚠️ **지속**이 이 설계의 전부다 — 게이트는 패스 비행마다 닫히는데 박스까지 ~10틱이 걸린다.
    expect(ro!.untilTick, "런이 여러 틱 유지된다").toBe(state.tick + ba.holdTicks);
    // 목표 자체는 **이 함수가 안 건드린다**(소비는 `applyRunOrders` 의 pull 루프 몫).
    expect(runner.targetFx, "발행만 하고 당기지는 않는다").toEqual({ x: M(F3_X), y: M(8) });
  });

  it("공이 발화 문턱 밖이면 no-op (전역화 방지의 1차 게이트)", () => {
    const { state, runner } = synthState(MID_X, true);
    applyBoxArrival(state, ON, pitch);
    expect(runner.runOrder).toBeNull();
  });

  it("소유자가 없으면(루즈볼) no-op — `possession` 만 보면 뜬 공에도 뛰어든다", () => {
    const { state, runner } = synthState(F3_X, false);
    applyBoxArrival(state, ON, pitch);
    expect(runner.runOrder).toBeNull();
  });

  it("이미 박스 안인 선수는 후보가 아니다 (ST 를 역할 이름 없이 제외하는 줄)", () => {
    const { state } = synthState(F3_X, true);
    // 박스 안(골에서 10m · 중앙)에 한 명 더 세운다 — 골에 가장 가까우므로 정렬 1위지만 제외돼야 한다.
    const inBox = synthPlayer("H7", "home", 95, 34, 8);
    state.players.push(inBox);
    state.byId = buildById(state.players);
    applyBoxArrival(state, ON, pitch);
    expect(inBox.runOrder, "박스 안 선수는 도착런 대상이 아니다").toBeNull();
  });

  it("이미 런 중인 선수에게는 새 런을 안 건다 (두 당김이 겹치면 어느 쪽도 완주 못 한다)", () => {
    const { state, runner } = synthState(F3_X, true);
    const keep = { xFx: M(90), yFx: M(20), untilTick: state.tick + 3, fromId: "H9" };
    runner.runOrder = { ...keep };
    applyBoxArrival(state, ON, pitch);
    expect(runner.runOrder).toEqual(keep);
  });

  it("`maxRunners` 정원은 **이미 뛰고 있는 박스 러너까지** 세어 지킨다", () => {
    const { state, runner } = synthState(F3_X, true);
    const extra = ["H5", "H6", "H7"].map((id, i) => synthPlayer(id, "home", 80 - i, 8 + i * 4, 8));
    state.players.push(...extra);
    state.byId = buildById(state.players);
    // 한 명은 이미 박스 안 지점으로 뛰는 중 → 정원 2 면 새로 걸리는 것은 **1명뿐**이어야 한다.
    runner.runOrder = { xFx: pitch.wFx - M(9), yFx: Math.round(pitch.hFx / 2), untilTick: state.tick + 5, fromId: "H9" };
    applyBoxArrival(state, ON, pitch);
    const fresh = extra.filter((p) => p.runOrder != null);
    expect(fresh.length, `새로 걸린 러너 ${fresh.map((p) => p.id).join(",") || "없음"}`).toBe(1);
  });

  it("중앙 출신은 후보가 아니다 — **밖에 서 있던 사람만** 안으로 들어온다", () => {
    // ⚠️ 이 줄이 없으면 기제가 자기 발등을 찍는다(20시드 실측): 이미 중앙인 미드필더가 골에
    // 더 가까워 먼저 뽑히고, 그러면 **박스 앞 슈팅 자리에 있던 유일한 비ST 슈터를 박스 안으로
    // 치워** 비ST 슛이 0.82 → 0.43 으로 되레 줄었다. 4-3-3 base 횡편차: LW/RW·LB/RB 20.4m ·
    // LCM/RCM 12.2m · CB 6.8m · CM/ST 0 → 출하 문턱 16m 은 윙어·풀백만 통과시킨다.
    const { state } = synthState(F3_X, true);
    const central = synthPlayer("H6", "home", 88, 30, 34); // base 가 중앙(횡편차 0)
    state.players.push(central);
    state.byId = buildById(state.players);
    applyBoxArrival(state, ON, pitch);
    expect(central.runOrder, "중앙 출신은 도착런 대상이 아니다").toBeNull();
  });

  it("노브 6종이 각각 no-op 팔을 갖는다 (레지스트리와 짝)", () => {
    for (const [label, mutate] of [
      ["enabled=false", (c: EngineConfig) => { c.movement.boxArrival.enabled = false; }],
      ["maxRunners=0", (c: EngineConfig) => { c.movement.boxArrival.maxRunners = 0; }],
      ["holdTicks=0", (c: EngineConfig) => { c.movement.boxArrival.holdTicks = 0; }],
      ["minRunnerProgress=2", (c: EngineConfig) => { c.movement.boxArrival.minRunnerProgress = 2; }],
      ["triggerProgress=2", (c: EngineConfig) => { c.movement.boxArrival.triggerProgress = 2; }],
      ["minBaseLatM=40", (c: EngineConfig) => { c.movement.boxArrival.minBaseLatM = 40; }],
    ] as const) {
      const { state, runner } = synthState(F3_X, true);
      applyBoxArrival(state, tweak((c) => { c.movement.boxArrival.enabled = true; mutate(c); }), pitch);
      expect(runner.runOrder, label).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ *
 * B. 효과 — 박스가 실제로 채워진다 (**크기 인지 지표**로만 판정)
 *
 * ⚠️ 비중형 지표(박스ST%)만 보면 속는다: `forwardRunReach` 를 내리면 박스ST% 가 90.2→62.1 로
 * "개선"되지만 박스 안 수신 **총량**이 5.47→1.63 이다(박스가 빈 것). Phase 2-B §6-1 이 그
 * 인공물을 잡아 만든 규율이 "**크기 인지 지표 병기**"이고, 여기서는 아예 크기 지표로만 문다.
 * ------------------------------------------------------------------ */

const GK_IDS = new Set(["H0", "A0"]);
const DEFENDER_IDS = new Set(["H1", "H2", "H3", "H4", "A1", "A2", "A3", "A4"]);
/** `research/e407-probe/e407-diversity.ts` 와 **같은 자** — 역할은 id 숫자 인덱스로 읽는다. */
const ROLES = ["GK", "LB", "LCB", "RCB", "RB", "LCM", "CM", "RCM", "LW", "ST", "RW"];
const roleOf = (id: string): string => ROLES[Number(id.slice(1))] ?? "?";

interface Shape {
  /** 팀-경기당 **비ST** 박스 안 수신(크기 인지 — 이 웨이브의 존재 이유). */
  nonStBoxRecv: number;
  /** 팀-경기당 박스 안 수신 총량(분모 붕괴 감시용 — 비중 함정의 방어선). */
  boxRecv: number;
  /** 팀-경기당 **비ST** 슛. */
  nonStShots: number;
  /** 팀-경기당 슛. */
  shots: number;
  /** 박스 안 슛 비중(%) — 축 A. */
  inBoxPct: number;
  /** 와이드 레인(횡편차 > 20.4m) 슛의 수 — N3. */
  wideShots: number;
  /** 팀 평균 폭(m) — 전역화 감시 축. */
  widthM: number;
  /** 팀-경기당 스로인 — 전역화 감시 축 2(전역 팔은 여기가 1.09 로 붕괴했다). */
  throwIns: number;
  /**
   * **박스 인구** — 게이트가 열린 틱(자기팀 소유 + 공이 파이널서드)당 상대 박스 안에 있는
   * 공격팀 **비ST 아웃필더 수**. 이 기제가 **직접** 통제하는 양이고, 박스 수신(결과)과 달리
   * 배급(패스 선택)이 개입하지 않는다 — 그래서 노브의 단조성은 여기서만 깨끗하다.
   * ⚠️ 창은 **출하 `finalThirdLine` 고정**이다(팔마다 `triggerProgress` 가 달라도 같은 자).
   */
  nonStBoxPop: number;
}

function shape(config: EngineConfig, seeds: string[]): Shape {
  const W = config.pitch.width;
  const H = config.pitch.height;
  const boxDepth = config.rules.penalty.boxDepthM;
  const boxHalf = config.rules.penalty.boxHalfWidthM;
  const laneWide = H / 5 * 1.5; // 와이드 문턱 20.4m(프로브와 같은 자)
  let shots = 0;
  let nonStShots = 0;
  let inBox = 0;
  let wide = 0;
  let boxRecv = 0;
  let nonStBoxRecv = 0;
  let widthSum = 0;
  let throwIns = 0;
  let gateTicks = 0;
  let nonStBoxPop = 0;
  const f3 = cfg.setPiece.finalThirdLine; // 출하값 고정 — 팔 간 비교 가능성.
  for (const s of seeds) {
    const log: MatchLog = runMatch(
      s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, config,
    );
    const byTick = new Map<number, TickSnapshot>();
    for (const sn of log.tickSnapshots) byTick.set(sn.tick, sn);
    for (const e of log.events) {
      if (e.type !== "shot" || e.detail === "saved" || e.detail === "off_target") continue;
      const sn = byTick.get(e.tick);
      if (!sn || !e.team || !e.playerId) continue;
      shots += 1;
      if (roleOf(e.playerId) !== "ST") nonStShots += 1;
      const gx = e.team === "home" ? W : 0;
      const lat = Math.abs(sn.ball.y - H / 2);
      if (Math.abs(sn.ball.x - gx) <= boxDepth && lat <= boxHalf) inBox += 1;
      if (lat > laneWide) wide += 1;
    }
    for (const t of reconstructTransfers(log, W)) {
      if (!t.completed) continue;
      const prog = t.fromSide === "home" ? t.recvX : W - t.recvX;
      if (prog < W - boxDepth || Math.abs(t.recvY - H / 2) > boxHalf) continue;
      boxRecv += 1;
      if (roleOf(t.toId) !== "ST") nonStBoxRecv += 1;
    }
    for (const sn of log.tickSnapshots) {
      const ownerId = sn.ballOwner;
      if (!ownerId) continue;
      const side = ownerId.startsWith("H") ? "home" : "away";
      const gx = side === "home" ? W : 0;
      if ((side === "home" ? sn.ball.x : W - sn.ball.x) / W < f3) continue;
      gateTicks += 1;
      for (const p of sn.players) {
        if (p.team !== side) continue;
        const r = roleOf(p.playerId);
        if (r === "GK" || r === "ST") continue;
        if (Math.abs(p.pos.x - gx) <= boxDepth && Math.abs(p.pos.y - H / 2) <= boxHalf) nonStBoxPop += 1;
      }
    }
    const st = computeMatchStats(log, GK_IDS, {
      defenderIds: DEFENDER_IDS,
      pitchWidthM: W,
      finalThirdLine: config.setPiece.finalThirdLine,
    });
    for (const t of [st.home, st.away]) {
      widthSum += t.avgWidthM;
      throwIns += t.throwIns;
    }
  }
  const tm = seeds.length * 2;
  return {
    nonStBoxRecv: +(nonStBoxRecv / tm).toFixed(2),
    boxRecv: +(boxRecv / tm).toFixed(2),
    nonStShots: +(nonStShots / tm).toFixed(2),
    shots: +(shots / tm).toFixed(2),
    inBoxPct: shots ? +((inBox / shots) * 100).toFixed(1) : 0,
    wideShots: wide,
    widthM: +(widthSum / tm).toFixed(1),
    throwIns: +(throwIns / tm).toFixed(2),
    nonStBoxPop: +(nonStBoxPop / Math.max(1, gateTicks)).toFixed(3),
  };
}

/** 출하 기본 = N2 off = 0.42.0 배치. 여러 describe 가 공유한다(결정론이라 메모가 안전하다). */
let offArm: Shape | undefined;
const n2Off = (): Shape => (offArm ??= shape(cfg, SEEDS8));
/** 기제를 켠 팔(출하 노브값 그대로 · `enabled` 만 true). */
let onArmMemo: Shape | undefined;
const n2On = (): Shape => (onArmMemo ??= shape(ON, SEEDS8));

describe("#407 N2 — 켜면 박스가 실제로 채워진다 (비중이 아니라 크기로 판정)", () => {
  it("비ST 박스 안 수신이 늘어난다 — 분모를 비우는 방식이 아니다", () => {
    const off = n2Off();
    const on = n2On();
    // eslint-disable-next-line no-console
    console.log(
      `[#407 N2 박스] 비ST 박스수신 ${off.nonStBoxRecv}→${on.nonStBoxRecv} · 총량 ${off.boxRecv}→${on.boxRecv} · ` +
        `비ST 슛 ${off.nonStShots}→${on.nonStShots} · 슛 ${off.shots}→${on.shots}`,
    );
    expect(on.nonStBoxRecv, `비ST 박스수신 ${off.nonStBoxRecv} → ${on.nonStBoxRecv}`)
      .toBeGreaterThan(off.nonStBoxRecv * 1.3);
    // ⚠️ 분모 붕괴 방어선(Phase 2-B §6-1 의 인공물). 총량이 무너지면 위 단언은 의미가 없다 —
    // `forwardRunReach` 를 내려도 박스ST% 는 "개선"되지만 그건 박스가 빈 것이다.
    expect(on.boxRecv, `박스 수신 총량 ${off.boxRecv} → ${on.boxRecv}`).toBeGreaterThan(off.boxRecv * 0.9);
  }, 300_000);

  it("비ST 슛이 **퇴행하지 않는다** — 박스를 채우다 슈터를 치우면 안 된다", () => {
    // ⚠️ **"는다"가 아니라 "안 준다"인 이유**: n60 실측이 0.85 → 0.87 로 **평평**하기 때문이다.
    // 없는 성과를 계약에 적으면 다음 사람이 오스코핑한다. 목표(≥2.0)와의 거리는 노트 §3-1 에
    // 정량으로 남긴다 — 계약이 못 무는 것을 문서가 대신 숨기지 않는다.
    //
    // 이 줄이 무는 것은 **방향**이다: 이 기제는 원리적으로 "박스 앞 슈팅 자리에 있던 비ST 슈터를
    // 박스 안으로 치우는" 모드를 가질 수 있고(그러면 박스는 찼는데 슛은 줄어든다), 그 모드는
    // 여기서 red 가 된다.
    //
    // ⚠️ **`minBaseLatM` 대조를 계약으로 넣지 않았다** — 20시드 짝 대조(정렬키·나머지 노브 고정)
    // 에서 lat0 → lat16 은 비ST 슛 **0.73 → 0.90** · HHI 0.914 → 0.891 로 **실재하지만 작다**.
    // 8시드에서는 부호가 뒤집힌다(0.75 vs 0.88 — 표본 안). 재현되지 않는 크기의 mutant 를
    // 계약으로 박으면 그 계약이 플래키가 되고, 그건 임계를 나중에 완화할 구실이 된다.
    // 근거는 계약이 아니라 **노트 §2-3 의 20시드 짝 대조표**에 남긴다.
    const off = n2Off();
    const on = n2On();
    expect(on.nonStShots, `비ST 슛/tm ${off.nonStShots} → ${on.nonStShots}`)
      .toBeGreaterThan(off.nonStShots * 0.9);
  }, 300_000);
});

/* ------------------------------------------------------------------ *
 * C. 전역화 방지 — 폭·스로인이 살아 있다 (그리고 **전역 팔은 그걸 깬다**)
 *    이 웨이브의 설계 근거가 통째로 여기 있다.
 * ------------------------------------------------------------------ */
describe("#407 N2 — 조건부라서 팀 폭·스로인이 살아 있다 (전역 팔은 여기서 죽는다)", () => {
  it("켠 팔의 팀 폭이 밴드(40–50) 안이고 스로인이 붕괴하지 않는다", () => {
    const off = n2Off();
    const on = n2On();
    // eslint-disable-next-line no-console
    console.log(`[#407 N2 전역화 감시] 폭 ${off.widthM}→${on.widthM}m · 스로인 ${off.throwIns}→${on.throwIns}`);
    expect(on.widthM, `팀 폭 ${off.widthM} → ${on.widthM}m`).toBeGreaterThan(40);
    expect(on.widthM, `팀 폭 ${off.widthM} → ${on.widthM}m`).toBeLessThan(50);
    expect(on.throwIns, `스로인 ${off.throwIns} → ${on.throwIns}`).toBeGreaterThan(off.throwIns * 0.7);
  }, 300_000);

  it("⚠️ 대조 — 같은 효과를 **전역**으로 내면 폭 밴드가 깨진다 (이 자가 실제로 문다는 증거)", () => {
    // `movement.attackWidthReach` 0.10 → −0.10 = Phase 2-B 가 60시드로 기각한 전역 우회.
    // 60시드 실측: 비ST 박스수신 0.54→7.60 · **팀 폭 46.8→37.1 · 스로인 10.15→1.09**.
    // 이 팔이 red 가 아니면 위 "폭이 밴드 안" 단언은 아무것도 안 무는 동어반복이다.
    const global = shape(tweak((c) => { c.movement.attackWidthReach = -0.10; }), SEEDS8);
    // eslint-disable-next-line no-console
    console.log(`[#407 N2 전역 대조] 폭 ${global.widthM}m · 스로인 ${global.throwIns} · 비ST 박스수신 ${global.nonStBoxRecv}`);
    expect(global.widthM, `전역 팔 폭 ${global.widthM}m`).toBeLessThan(40);
    expect(global.throwIns, `전역 팔 스로인 ${global.throwIns}`).toBeLessThan(n2Off().throwIns * 0.5);
  }, 300_000);
});

/* ------------------------------------------------------------------ *
 * D. N3 — 와이드 슛의 봉인은 **산수**다 (그리고 이 웨이브가 못 풀었다)
 * ------------------------------------------------------------------ */
describe("#407 N3 — 오픈플레이 와이드 슛 0% 의 정체", () => {
  it("하드 게이트(N1 off)에서는 와이드 슛이 **정확히** 0 이다 (벽 2 = 튜닝이 아니라 산수)", () => {
    // 와이드 문턱 = 피치폭 68 ÷ 5 × 1.5 = 20.4m 이고 이는 **횡오프셋**이다. 골 중앙까지의
    // 유클리드 거리는 횡오프셋보다 항상 크거나 같으므로 와이드 슛은 `distToGoal ≥ 20.4`,
    // 그런데 `contest.shootRange` 는 19 다 ⇒ 확률이 정확히 0. 어떤 노브와도 무관하다.
    for (const [label, arm] of [["N2 off", n2Off()], ["N2 on", n2On()]] as const) {
      expect(arm.wideShots, `${label} 에서 와이드 슛 ${arm.wideShots}건`).toBe(0);
    }
  }, 300_000);

  /**
   * ⚠️ **여기 없는 계약**: "N1 을 켜면 와이드 슛이 난다". 60시드 실측이 **0.0%** 다.
   * 게이트를 `genMaxM` 24 로 넓혀도 나지 않는다 — 남는 구속은 거리가 아니라 **행동**이기
   * 때문이다: 와이드 선수가 골에서 12m 안(그 지점에서만 xG ≥ `shootXgThreshold`)까지 공을
   * 갖고 가는 일이 없다(캐리 방향 후보가 골 중앙 1개뿐 — ⑨ C2). 0.41.0 노트 §7-3 의 판단이
   * 60시드로 재확인됐다: **N3 는 ⑨ B3(캐리 방향 후보화)·B1(크로스) 없이는 실효가 0** 이다.
   */
});

/* ------------------------------------------------------------------ *
 * E. 사다리 — `holdTicks` 가 **단조 레버**인가 (HMB_LADDER)
 *
 * `gate.ts` 규칙: 엔진 config 노브를 만지는 웨이브는 `npm run test:ladder` 를 돌린다.
 * `holdTicks` 를 고른 이유는 이게 이 기제의 **핵심 노브**이기 때문이다 — 초판이 실패한 지점이
 * 정확히 "지시가 지속되지 않아 러너가 도착 못 함"이었다.
 * ------------------------------------------------------------------ */
describe.skipIf(!LADDER)(`#407 N2 사다리 — 정원이 박스 인구를 정한다 ${LADDER_TAG}`, () => {
  it("maxRunners 0(=off) → 1 → 2 에서 **박스 안 비ST 인구**가 단조 증가한다", () => {
    /**
     * ## ⚠️ 왜 박스 *수신* 이 아니라 박스 *인구* 인가 (자를 옮긴 근거는 관측이 아니라 **기제**다)
     *
     * 처음엔 수신으로 썼고 **실패했다**(12시드 `holdTicks` 0/12/24: 0.42 / 1.17 / **1.00**).
     * 자를 옮기는 것은 "재는 자를 편한 쪽으로 미는 것"과 종이 한 장 차이라, 근거는
     * "신호가 없더라"가 아니라 **왜 그 지표가 이 노브의 단조 반응을 원리적으로 못 보여주는가**
     * 여야 한다. 기제는 이것이다:
     *
     *   **박스 수신 = (박스로 들어오는 패스의 수) × (그중 이 러너가 받을 확률)** 인데,
     *   이 기제의 노브들은 **둘 중 어느 쪽도 통제하지 않는다.** 통제하는 것은 러너가 박스에
     *   **서 있는 시간·인원**뿐이다. 앞항은 사슬 EV 가 정하고 실측상 **5~6/팀-경기로 고정**이며
     *   (모든 팔에서), 뒷항은 도착 지점 xG 가 큰 쪽이 이기는 경쟁이라 **ST 가 구조적으로 이긴다**
     *   — 역할 덤프에서 **ST 의 박스 수신은 어떤 팔에서도 4.5~5.2 로 상수**다. 즉 수신은 이
     *   노브들의 **하류**에 있고 그 사이에 **상류 병목(사슬의 배급 결정)** 이 끼어 있어, 노브를
     *   더 밀어도 수신은 그 병목에 눌려 평평해진다(n60 h12 1.04 · h16 1.22 · h20 1.08).
     *   (대안 가설 "수비가 러너를 예측해 막는다"는 아블레이션으로 **배제**: `runReadFrac=0`
     *    에서도 수신이 안 오른다.)
     *
     *   반면 **인구는 이 노브의 정의 그 자체**다 — 러너가 박스에 서 있는 틱 수. 배급이 개입하지
     *   않으므로 병목이 없다. 노브가 죽으면 여기가 **먼저** 무너진다.
     *
     * ## ⚠️ 왜 `maxRunners` 이고 왜 rung 이 셋뿐인가 (간격 > SE 규율)
     * 두 노브 다 **포화한다**. 20시드 인구 실측:
     *   `holdTicks` 0 **0.471** → 8 **0.689** → 16 0.703 → 24 0.710  ← 8 위로는 간격 0.007~0.014
     *   `maxRunners` 0 **0.46** → 1 **0.60** → 2 **0.73** → 3 0.729 → 4 0.804 ← 2 위로 평평/역전
     * 8·16·24 나 2·3·4 를 rung 으로 쓰면 **SE 아래 간격에 계약을 거는 것**이고 그게 정확히
     * #429 로 이관된 칼날 계약들의 실패 양상이다. 그래서 **간격이 실재하는 구간(0/1/2)** 만 쓴다.
     * 포화 이유도 기제로 설명된다: `minBaseLatM` 16m 자격을 통과하는 선수가 LW·RW·LB·RB 넷뿐이고
     * 그중 동시에 전진해 있는 인원이 대개 2명이라 **정원 3 이상은 애초에 구속하지 않는다**.
     *
     * ## ⚠️ 결과 지표는 계약에서 빼지 않았다
     * 사다리를 인구로 옮긴 대가로 "정작 원하던 결과가 안 나와도 green" 이 되면 안 된다.
     * 위 describe B 가 비ST 박스**수신** 증가 + 분모 붕괴 방어선 + 비ST **슛** 비퇴행을 따로 문다.
     * 그리고 **수신이 목표(≥2.0)에 못 미치는 것은 숨기지 않는다** — 최대 1.22(n60)이고
     * 그것이 "N2 만으로는 부족하다"는 이 웨이브의 핵심 결론이다(노트 §3-5·§6).
     */
    const arm = (n: number): number =>
      shape(
        tweak((c) => { c.movement.boxArrival.enabled = n > 0; c.movement.boxArrival.maxRunners = Math.max(1, n); }),
        SEEDS12,
      ).nonStBoxPop;
    const v = [0, 1, 2].map(arm);
    // eslint-disable-next-line no-console
    console.log(`[#407 N2 사다리] maxRunners 0/1/2 → 박스 안 비ST 인구 ${v.join(" / ")}`);
    for (let i = 1; i < v.length; i++) {
      expect(v[i]!, `rung ${i - 1}→${i}: ${v[i - 1]} → ${v[i]} (전체 ${v.join("/")})`)
        .toBeGreaterThan(v[i - 1]!);
    }
  }, 900_000);
});

/* ------------------------------------------------------------------ *
 * F. 롤백 — 스위치를 끄면 0.42.0 과 bit-identical
 * ------------------------------------------------------------------ */
describe("#407 N2 롤백 — 출하 기본(스위치 off)은 0.42.0 과 비트 동일", () => {
  /**
   * 0.42.0(origin/main `3808282`) 에서 실측한 4시드 최종 스냅샷 해시.
   * 출하 기본이 `boxArrival.enabled=false` 라 이 계약은 **출하 config 그대로** 돈다 —
   * 즉 "이 웨이브의 코드가 출하 경로에서 한 줄도 안 돈다"를 매 실행 증명한다.
   */
  const GOLDEN_042 = ["7b731a91", "e816d215", "460ce36e", "ed78f19e"];
  it("출하 config(=boxArrival off) → 0.42.0 해시", () => {
    const got = REALISM_SEEDS.slice(0, 4).map(
      (s) =>
        runMatch(s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, cfg)
          .tickSnapshots.slice(-1)[0]!.hash,
    );
    expect(got).toEqual(GOLDEN_042);
  }, 120_000);
});
