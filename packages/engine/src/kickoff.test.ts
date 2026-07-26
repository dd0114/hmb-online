import { describe, it, expect } from "vitest";
import { runMatch } from "./match";
import { defaultEngineConfig } from "./config";
import { demoSeed, demoHome, demoAway, demoSelect } from "./fixtures";
import type { MatchLog, TickSnapshot } from "@hmb/shared";

/**
 * AC-kickoff: 골 후(그리고 후반 시작) 정식 킥오프.
 *  1) 각 goal 이벤트 후 60틱 내에 kickoff MatchEvent(detail 없음 = 골 후 재시작)가 존재.
 *  2) 골 후 킥오프 포메이션이 경기시작(t0)과 슬롯 일치 — 테이커(센터 이동)를 제외한 전 선수가
 *     t0 배치와 동일(허용오차 TOL_M).
 *  3) 골 후 공은 센터(피치 중앙) + 실점팀 소유.
 */

const config = defaultEngineConfig;
// 포지션은 스냅샷에서 소수 2자리로 반올림되므로(cm), 슬롯 일치 허용오차는 넉넉히 0.1m.
const TOL_M = 0.1;
const CENTER = { x: config.pitch.width / 2, y: config.pitch.height / 2 }; // (52.5, 34)
const GOAL_STOPPAGE = config.setPiece.goalStoppageTicks; // 25
/**
 * 경기 종료 전에 재개될 수 있는 골만 대상으로 한다. 90분 막판(종료 GOAL_STOPPAGE 틱 이내)에 터진
 * 골은 킥오프 전에 경기가 끝나므로 "골 뒤 킥오프" 계약의 반례가 아니다(실제 축구도 동일).
 * (#181 로 타임라인이 바뀌며 t=5398 골이 나와 드러난 케이스.)
 */
function restartableGoals(log: MatchLog): { tick: number; team?: string }[] {
  const total = log.tickSnapshots[log.tickSnapshots.length - 1]!.tick;
  return log.events.filter((e) => e.type === "goal" && e.tick + GOAL_STOPPAGE <= total);
}

function runDemo(): MatchLog {
  return runMatch(demoSeed, demoHome, demoAway, demoSelect, config);
}

function snapByTick(log: MatchLog): Map<number, TickSnapshot> {
  const m = new Map<number, TickSnapshot>();
  for (const s of log.tickSnapshots) m.set(s.tick, s);
  return m;
}

/** 골 후 재시작 킥오프 이벤트: type=kickoff 이면서 detail 없음(코너/골킥/스로인/후반 아님). */
function isRestartKickoff(e: { type: string; detail?: string }): boolean {
  return e.type === "kickoff" && (e.detail === undefined || e.detail === null);
}

describe("goal restart kickoff (AC-kickoff)", () => {
  it("emits a kickoff event within 60 ticks after every goal", () => {
    const log = runDemo();
    const goals = restartableGoals(log);
    expect(goals.length).toBeGreaterThan(0);

    for (const g of goals) {
      const ko = log.events.find(
        (e) => isRestartKickoff(e) && e.tick > g.tick && e.tick <= g.tick + 60,
      );
      expect(ko, `goal@${g.tick} (${g.team}) 후 60틱 내 킥오프 이벤트 없음`).toBeDefined();
      // 정식 킥오프 정지 시간과 일치(goalStoppageTicks).
      expect(ko!.tick).toBe(g.tick + GOAL_STOPPAGE);
      // 실점팀(=골 넣은 팀의 반대)이 킥오프.
      const conceding = g.team === "home" ? "away" : "home";
      expect(ko!.team).toBe(conceding);
    }
  });

  it("resets formation to the kickoff (t0) slots after every goal", () => {
    const log = runDemo();
    const byTick = snapByTick(log);
    const t0 = byTick.get(0)!;
    const t0Taker = t0.ballOwner; // 전반 킥오프 테이커(센터).
    const t0Pos = new Map(t0.players.map((p) => [p.playerId, p.pos]));

    const goals = restartableGoals(log);
    expect(goals.length).toBeGreaterThan(0);

    for (const g of goals) {
      const koTick = g.tick + GOAL_STOPPAGE;
      const snap = byTick.get(koTick)!;
      expect(snap, `킥오프 틱 ${koTick} 스냅샷 없음`).toBeDefined();
      const koTaker = snap.ballOwner; // 이번 킥오프 테이커(센터).

      // 테이커 2명(전반 t0 테이커 + 이번 테이커)을 제외한 전 선수가 t0 슬롯과 일치.
      let matched = 0;
      let compared = 0;
      for (const p of snap.players) {
        if (p.playerId === t0Taker || p.playerId === koTaker) continue;
        const base = t0Pos.get(p.playerId)!;
        compared++;
        const dx = Math.abs(p.pos.x - base.x);
        const dy = Math.abs(p.pos.y - base.y);
        if (dx <= TOL_M && dy <= TOL_M) matched++;
        else {
          throw new Error(
            `goal@${g.tick} 킥오프@${koTick}: ${p.playerId} 포메이션 미복귀 ` +
              `pos=(${p.pos.x},${p.pos.y}) t0=(${base.x},${base.y})`,
          );
        }
      }
      expect(matched).toBe(compared);
      expect(compared).toBeGreaterThan(15); // 22명 - 최대 2 테이커.
    }
  });

  it("places the ball at center with the conceding team in possession after every goal", () => {
    const log = runDemo();
    const byTick = snapByTick(log);
    const goals = restartableGoals(log);
    expect(goals.length).toBeGreaterThan(0);

    for (const g of goals) {
      const koTick = g.tick + GOAL_STOPPAGE;
      const snap = byTick.get(koTick)!;
      // 공은 센터.
      expect(Math.abs(snap.ball.x - CENTER.x)).toBeLessThanOrEqual(TOL_M);
      expect(Math.abs(snap.ball.y - CENTER.y)).toBeLessThanOrEqual(TOL_M);
      // 소유자는 실점팀 소속.
      const conceding = g.team === "home" ? "away" : "home";
      expect(snap.ballOwner).not.toBeNull();
      const owner = snap.players.find((p) => p.playerId === snap.ballOwner)!;
      expect(owner.team).toBe(conceding);
    }
  });

  it("restarts the second half with an away kickoff + formation reset", () => {
    const log = runDemo();
    const total = log.tickSnapshots.length; // 5400
    const half = Math.floor(total / 2); // 2700

    // 후반 시작 킥오프 이벤트(detail 없음, team away, tick=half).
    const ko = log.events.find((e) => isRestartKickoff(e) && e.tick === half);
    expect(ko, "후반 시작 킥오프 이벤트 없음").toBeDefined();
    expect(ko!.team).toBe("away");

    const byTick = snapByTick(log);
    const snap = byTick.get(half)!;
    // 공 센터 + 어웨이 소유.
    expect(Math.abs(snap.ball.x - CENTER.x)).toBeLessThanOrEqual(TOL_M);
    expect(Math.abs(snap.ball.y - CENTER.y)).toBeLessThanOrEqual(TOL_M);
    const owner = snap.players.find((p) => p.playerId === snap.ballOwner)!;
    expect(owner.team).toBe("away");

    // 포메이션 리셋: 테이커 2명 제외 전 선수가 t0 슬롯 일치.
    const t0 = byTick.get(0)!;
    const t0Taker = t0.ballOwner;
    const koTaker = snap.ballOwner;
    const t0Pos = new Map(t0.players.map((p) => [p.playerId, p.pos]));
    for (const p of snap.players) {
      if (p.playerId === t0Taker || p.playerId === koTaker) continue;
      const base = t0Pos.get(p.playerId)!;
      expect(Math.abs(p.pos.x - base.x)).toBeLessThanOrEqual(TOL_M);
      expect(Math.abs(p.pos.y - base.y)).toBeLessThanOrEqual(TOL_M);
    }
  });
});
