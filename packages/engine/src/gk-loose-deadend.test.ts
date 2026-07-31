import { describe, it, expect } from "vitest";
import type { MatchLog } from "@hmb/shared";
import { defaultEngineConfig } from "./config";
import { runFirstHalf, resumeSecondHalf, type CarryState } from "./match";
import { makeTacticalInput, makeSelectData } from "./fixtures";
import { resolveShot, restartGoalKick } from "./contest";
import { createRng } from "./rng";
import { kickBall } from "./ball";
import { attackGoal, createPitch } from "./pitch";
import { playerKey } from "./simstate";
import type { SetPiece, SimPlayer, SimState } from "./simstate";
import { toFixed } from "./fixedmath";

/**
 * 루즈볼 데드엔드 계약 (#239 — "골에어리어 앞 루즈볼 미회수로 하프 정지").
 *
 * 데드엔드란 **공이 살아 있지도 죽어 있지도 않은 상태**다: 소유자 없음 + 세트피스 없음 +
 * 정지 없음 + 비행 없음. 그러면 `match.stepTick` 의 어느 분기에도 안 걸리고
 * `decideOffBall` 의 루즈볼 분기(`flight.kind === "loose"`)도 false 라 **아무도 주우러 가지
 * 않는다** → 그 하프가 통째로 죽는다(라이브 실측: #231 에서 1384틱 공 정지·이벤트 0건).
 *
 * 확인된 진입로는 GK 부재(퇴장)다:
 *   ① `contest.resolveShot` 의 GK 캐치 경로에서 `gkSaver === null` 이면 공을 골에어리어에
 *      놓고 owner/setPiece/stoppage 를 **아무것도 세우지 않았다**.
 *   ② 그 자리를 골킥으로 재시작해도 `placeRestart` 가 goal_kick taker 를 **GK 로만** 찾아
 *      taker=null → 공이 스팟에 무소유로 놓이고 setPiece 는 살아 있다(#176 keepSetPiece) →
 *      찰 사람이 없어 역시 영구 정지. 즉 ①만 고치면 데드엔드가 한 칸 옮겨갈 뿐이다.
 *
 * 계약은 **임계값이 아니라 구조 불변식**이다 — "슛 해소는 어느 분기로 끝나든 공을 살려 둔다",
 * 그리고 하프 단위로는 **대조군(정상 GK) 대비 관계식**으로 건다(절대 틱 수를 새로 정하지 않는다).
 */

const cfg = defaultEngineConfig;
const select = makeSelectData();
const pitch = createPitch(cfg);

/** 퇴장과 **같은 절차**(contest.sendOff)로 GK 를 제거한다. */
function sendOffGk(state: SimState, side: SimPlayer["side"]): SimPlayer {
  const gk = state.players.find((p) => p.side === side && p.isGK);
  if (!gk) throw new Error("no gk");
  state.players.splice(state.players.indexOf(gk), 1);
  state.byId.delete(playerKey(gk.side, gk.id));
  if (state.ball.owner === gk.id && state.ball.ownerSide === gk.side) {
    state.ball.owner = null;
    state.ball.ownerSide = null;
    state.ball.flight = null;
  }
  return gk;
}

/** 공이 살아 있는가 = 누가 들고 있거나 / 날고 있거나 / 재시작 절차가 걸려 있다. */
function ballIsAlive(state: SimState): boolean {
  return (
    state.ball.owner != null ||
    state.ball.flight != null ||
    state.setPiece != null ||
    state.stoppage > 0
  );
}

const SEED = "4815162342";

describe("#239 GK 부재 — 슛 해소가 데드엔드를 만들지 않는다", () => {
  it("어느 rng 분기로 끝나든 공은 살아 있다(GK 캐치 경로 포함)", () => {
    const base = runFirstHalf(SEED, makeTacticalInput("H", SEED), makeTacticalInput("A", SEED), select, cfg);
    const proto = structuredClone(base.state) as SimState;
    sendOffGk(proto, "away");
    // 인플레이 슛 도착 상황으로 정규화(정지/세트피스 없음) — 클론 전에 한 번만.
    proto.setPiece = null;
    proto.stoppage = 0;

    const goal = attackGoal(pitch, "home");
    let gkCatchBranch = 0;
    const dead: number[] = [];
    for (let i = 0; i < 200; i++) {
      const state = structuredClone(proto) as SimState;
      const shooter = state.players.find((p) => p.side === "home" && !p.isGK)!;
      state.ball.owner = null;
      state.ball.ownerSide = null;
      state.ball.posFx = { x: goal.x, y: goal.y };
      state.ball.flight = kickBall(
        shooter.posFx.x,
        shooter.posFx.y,
        goal.x,
        goal.y,
        toFixed(20, cfg.fixedScale),
        { kind: "shot", delivery: "ground", target: shooter.id, fromSide: "home", xg: 0.15 },
      );
      const rng = createRng(`deadend-${i}`);
      const evs = resolveShot(state, rng, cfg, pitch, state.tick, 45);
      // GK 캐치 분기 = save 이벤트가 났는데 코너 굴절이 아니다.
      const saved = evs.some((e) => e.type === "save");
      const sp: SetPiece | null = state.setPiece;
      const corner = sp?.restart?.kind === "corner";
      if (saved && !corner) gkCatchBranch++;
      if (!ballIsAlive(state)) dead.push(i);
    }
    // 이 시나리오가 실제로 GK 캐치 분기를 밟는지 먼저 확인한다(안 밟으면 계약이 무의미하다).
    expect(gkCatchBranch).toBeGreaterThan(0);
    expect(dead).toEqual([]);
  });

  it("GK 없는 팀의 골킥도 찰 사람이 배정된다(taker 부재 = 또 다른 데드엔드)", () => {
    const base = runFirstHalf(SEED, makeTacticalInput("H", SEED), makeTacticalInput("A", SEED), select, cfg);
    const state = structuredClone(base.state) as SimState;
    sendOffGk(state, "away");
    const ev = restartGoalKick(state, pitch, cfg, "away", state.tick, 45);
    // taker 가 없으면 공은 스팟에 무소유로 놓이고 setPiece 만 살아 있다 = 찰 사람 없는 영구 정지.
    expect(ev.playerId).toBeTruthy();
    expect(state.ball.owner).toBeTruthy();
    expect(state.ball.ownerSide).toBe("away");
  });
});

describe("#239 GK 부재 하프 — 공이 영구 정지하지 않는다(대조군 관계식)", () => {
  /** 무소유 연속 구간의 최장 길이(틱). 정지·세트피스 중에도 소유자가 없을 수 있으므로 상한이 아니라 **비교량**이다. */
  function longestUnownedRun(log: MatchLog, fromTick: number): number {
    let best = 0;
    let cur = 0;
    for (const sn of log.tickSnapshots) {
      if (sn.tick < fromTick) continue;
      if (sn.ballOwner == null) {
        cur++;
        if (cur > best) best = cur;
      } else cur = 0;
    }
    return best;
  }

  const SEEDS = ["4815162342", "9999999999", "1234567890", "2718281828", "1414213562", "1618033988"];

  it("GK 퇴장 후반의 최장 무소유 구간이 대조군(정상 GK)을 넘지 않는다", () => {
    const half = Math.floor(Math.round((cfg.matchMinutes * 60 * 1000) / cfg.msPerTick) / 2);
    let ctlMax = 0;
    let varMax = 0;
    const rows: string[] = [];
    for (const seed of SEEDS) {
      const home = makeTacticalInput("H", seed);
      const away = makeTacticalInput("A", seed);
      const run = (removeGk: boolean): number => {
        const carry: CarryState = runFirstHalf(seed, home, away, select, cfg);
        if (removeGk) sendOffGk(carry.state, "away");
        return longestUnownedRun(resumeSecondHalf(carry, home, away), half);
      };
      const c = run(false);
      const v = run(true);
      rows.push(`${seed} ctl=${c} gkOut=${v}`);
      if (c > ctlMax) ctlMax = c;
      if (v > varMax) varMax = v;
    }
    // eslint-disable-next-line no-console
    console.log(`[#239] longest unowned run (2nd half): ${rows.join(" | ")}`);
    expect(varMax).toBeLessThanOrEqual(ctlMax);
  });
});
