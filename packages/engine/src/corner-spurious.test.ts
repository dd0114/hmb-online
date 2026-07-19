import { describe, it, expect } from "vitest";
import type { MatchEvent, MatchLog, TeamSide, TickSnapshot } from "@hmb/shared";
import { runMatch } from "./match";
import { demoSeed, demoHome, demoAway, demoSelect } from "./fixtures";
import { showcaseConfig } from "../dev-viewer/generate-demo";
import { defaultEngineConfig } from "./config";
import { createPitch } from "./pitch";

/**
 * #110 (A) 스퓨리어스(반대편) 코너 회귀 계약.
 *
 * 근본 버그: resolveOut 골라인 코너 분기가 코너를 **공을 낸 팀(fromSide=클리어한 수비팀)** 에게
 * 주어(restartCorner(side=fromSide)) 반대편 골라인에 배치 → 수비팀이 자기 공격 코너를 얻는
 * 스퓨리어스 코너 + 공 순간이동. 실측: t1242 home 키퍼 캐치 → t1243 home 코너(x=105).
 *
 * 계약(수정 후 성립해야):
 *  - (C1) 캐치 무결성: 어떤 kickoff/corner 이벤트도, 직전 틱 공 소유자가 **그 코너 팀의 키퍼** 여선
 *         안 된다. (자기 골 앞에서 키퍼가 공을 쥔 팀이 한 틱 뒤 반대편 자기 공격 코너를 얻을 수 없다.)
 *  - (C2) 팀/기하 정합: kickoff/corner 는 그 코너 팀의 **공격 골라인**(home→x≈wFx, away→x≈0)
 *         코너 깃발에 놓여야 한다(반대편 골 배치 금지).
 */

type SnapMap = Map<number, TickSnapshot>;

function snapByTick(log: MatchLog): SnapMap {
  const m: SnapMap = new Map();
  for (const s of log.tickSnapshots) m.set(s.tick, s);
  return m;
}

/** save 이벤트의 playerId 로 각 팀 키퍼 id 를 수집(팀별). */
function goalkeeperIds(log: MatchLog): Map<TeamSide, Set<string>> {
  const gk = new Map<TeamSide, Set<string>>([
    ["home", new Set()],
    ["away", new Set()],
  ]);
  for (const e of log.events) {
    if (e.type === "save" && e.playerId) gk.get(e.team as TeamSide)!.add(e.playerId);
  }
  return gk;
}

function ownerSide(playerId: string | null): TeamSide | null {
  if (!playerId) return null;
  if (playerId.startsWith("H")) return "home";
  if (playerId.startsWith("A")) return "away";
  return null;
}

function corners(log: MatchLog): MatchEvent[] {
  return log.events.filter((e) => e.type === "kickoff" && e.detail === "corner");
}

describe("#110 스퓨리어스 반대편 코너 (엔진 데이터)", () => {
  it("showcase: 캐치 후 그 팀 코너로 순간이동하지 않는다 (C1)", () => {
    const log = runMatch(demoSeed, demoHome, demoAway, demoSelect, showcaseConfig);
    const snaps = snapByTick(log);
    const gk = goalkeeperIds(log);

    const violations: string[] = [];
    for (const c of corners(log)) {
      const prev = snaps.get(c.tick - 1);
      if (!prev) continue;
      const prevOwner = prev.ballOwner;
      const cornerTeam = c.team as TeamSide;
      // 직전 틱 공 소유자가 코너 팀의 키퍼면 = 자기 골 앞에서 소유 → 한 틱 뒤 자기 공격 코너 불가.
      if (prevOwner && gk.get(cornerTeam)!.has(prevOwner)) {
        violations.push(
          `t${c.tick} corner team=${cornerTeam} but t${c.tick - 1} ball owned by ${cornerTeam} GK ${prevOwner}`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("showcase: 모든 코너는 그 팀 공격 골라인 코너 깃발에 놓인다 (C2)", () => {
    const log = runMatch(demoSeed, demoHome, demoAway, demoSelect, showcaseConfig);
    const snaps = snapByTick(log);
    const pitch = createPitch(showcaseConfig);
    const wM = pitch.wFx / showcaseConfig.fixedScale; // 피치 길이(m)
    const tol = 1.0; // m

    const violations: string[] = [];
    for (const c of corners(log)) {
      const s = snaps.get(c.tick);
      if (!s) continue;
      const cornerTeam = c.team as TeamSide;
      // home 공격 골라인 = x≈wM, away = x≈0.
      const expectedX = cornerTeam === "home" ? wM : 0;
      if (Math.abs(s.ball.x - expectedX) > tol) {
        violations.push(
          `t${c.tick} corner team=${cornerTeam} ball.x=${s.ball.x} (expected ≈${expectedX})`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("real config(defaultEngineConfig)에서도 스퓨리어스 코너 없음 (C1+C2)", () => {
    const log = runMatch(demoSeed, demoHome, demoAway, demoSelect, defaultEngineConfig);
    const snaps = snapByTick(log);
    const gk = goalkeeperIds(log);
    const pitch = createPitch(defaultEngineConfig);
    const wM = pitch.wFx / defaultEngineConfig.fixedScale;

    const violations: string[] = [];
    for (const c of corners(log)) {
      const cornerTeam = c.team as TeamSide;
      const prev = snaps.get(c.tick - 1);
      if (prev?.ballOwner && gk.get(cornerTeam)!.has(prev.ballOwner)) {
        violations.push(`t${c.tick} C1: prev owned by ${cornerTeam} GK ${prev.ballOwner}`);
      }
      const s = snaps.get(c.tick);
      if (s) {
        const expectedX = cornerTeam === "home" ? wM : 0;
        if (Math.abs(s.ball.x - expectedX) > 1.0) {
          violations.push(`t${c.tick} C2: ball.x=${s.ball.x} expected ≈${expectedX}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// 참고: ownerSide 는 향후 팀 소유 교차검증용 헬퍼(현재 계약은 GK 집합으로 판정).
void ownerSide;
