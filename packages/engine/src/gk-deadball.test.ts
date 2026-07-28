import { describe, it, expect } from "vitest";
import type { MatchLog, MatchEvent } from "@hmb/shared";
import { runMatch } from "./match";
import { defaultEngineConfig, type EngineConfig } from "./config";
import { makeTacticalInput, makeSelectData, demoSeed, demoHome, demoAway, demoSelect } from "./fixtures";
import { showcaseConfig } from "../dev-viewer/generate-demo";
import { REALISM_SEEDS } from "./realism/harness";

/**
 * #230 — **데드볼 정지 중 골키퍼가 자기 골문을 버리고 전진한다**(hero 오픈베타 실관전 제보).
 *
 * 증상: 상대 골킥마다 이쪽 골키퍼가 하프라인 근처까지 걸어 나온다("골킥을 가로채러 나온다").
 * 라이브 실측(유저 별희 3경기 6하프, engine@0.21.0, 재현 해시 일치): 골킥 68회 전부에서
 * 상대 GK 가 자기 골라인에서 **33~36m** 까지 이탈. 골키퍼가 자기 페널티 에어리어(16.5m)의
 * 두 배를 나가 있는 그림이라 관전 인상이 "규칙이 없는 경기"가 된다.
 *
 * 원인: 정지 중 규칙기반 배치 `deadBallShapeTarget`(#185/#174)이 **골키퍼에게도** 팀 형태
 * 당김(`shapeReachX`)을 적용한다. 골키퍼의 기본 위치는 자기 골라인이고 상대 골킥 스팟은
 * 피치 반대편이라, 당김 비율 0.35 × 약 95m = **33m** 가 그대로 전진량이 된다(실측과 일치).
 * 필드 플레이어에게 이 당김은 옳다(공 쪽으로 팀 형태가 이동) — 골키퍼만 예외가 없었다.
 *
 * 왜 #176(데드볼 접근 금지) 계약이 못 잡았나: 그 계약은 구현과 **같은 이유로** 상대 GK 를
 * 스캔에서 제외한다(`p.playerId === oppGk` continue). Law 13/14 의 "수비 GK 는 골문을 비우고
 * 물러나지 않는다" 예외를 계약에도 그대로 옮겨 적은 것이라, 골키퍼가 반대 방향으로 **너무 많이
 * 나가는** 경우는 계약의 사각지대였다. 이 파일이 그 사각지대를 덮는다.
 *
 * 계약(튜닝값이 아니라 축구의 사실): **정지 중 골키퍼는 자기 페널티 에어리어를 벗어나지 않는다.**
 * 거리는 config 가 아니라 경기규칙 상수(박스 깊이)로 직접 잡는다 — config 를 읽으면 노브를
 * 낮추는 것만으로 계약이 통과해버린다.
 */

/** 페널티 에어리어 깊이(m). IFAB 상수 — 밸런싱 노브가 아니라 규칙이므로 테스트가 직접 들고 있다. */
const BOX_DEPTH_M = 16.5;
/**
 * 허용 여유(m). 정지 중 대기 동작(`idleAmpM`)이 배치에 ±1m 미만의 느린 오프셋을 주므로
 * 경계에 걸치지 않게 흡수한다. 버그 실측치(33~36m)와는 자릿수가 달라 계약을 무디게 하지 않는다.
 */
const TOL_M = 1.5;
/** 정지 창 탐색 상한(틱). walkStoppage 동적 연장 포함(#176 과 동일). */
const MAX_WINDOW = 45;

/** 재시작 이벤트 → 종류. 세트피스가 아니면 null. (#176 과 동일 규칙) */
function restartKind(e: MatchEvent): string | null {
  if (e.type === "free_kick") return "free_kick";
  if (e.type === "penalty") return "penalty";
  if (e.type === "kickoff") return e.detail ?? "kickoff";
  return null;
}

interface Excursion {
  kind: string;
  tick: number;
  gk: string;
  /** 자기 골라인에서의 거리(m). */
  distM: number;
  /** 그 창에서 허용된 상한(m). */
  allowedM: number;
}

/**
 * 한 경기에서 "정지 중 골키퍼가 자기 박스를 벗어난" 사례 전수 스캔.
 *
 * 창 정의는 #176 과 같다 — 재시작 선언 ~ 공이 인플레이 되기 직전(소유가 비거나 공이 스팟을
 * 떠나거나 새 재시작이 선언될 때까지). 인플레이 된 뒤의 골키퍼 전진(스위퍼 키퍼)은 정상 축구다.
 */
function scanGkExcursions(log: MatchLog, config: EngineConfig): { worst: Excursion[]; windows: number } {
  const byTick = new Map(log.tickSnapshots.map((s) => [s.tick, s]));
  const worst: Excursion[] = [];
  let windows = 0;
  // 하프/종료 휘슬은 데드볼을 도중에 잘라낸다 → 그 창은 규칙이 성립하지 않는다(#176 과 동일).
  const whistles = log.events.filter((w) => w.type === "half_whistle" || w.type === "full_whistle").map((w) => w.tick);
  const restartTicks = log.events.filter((w) => restartKind(w) != null).map((w) => w.tick);
  // 골키퍼는 슬롯 0(#176 계약이 쓰는 것과 같은 규약).
  const GKS = [
    { id: "H0", goalX: 0 },
    { id: "A0", goalX: config.pitch.width },
  ];

  for (const e of log.events) {
    const kind = restartKind(e);
    if (!kind || !e.team) continue;
    const s0 = byTick.get(e.tick);
    if (!s0) continue;
    if (whistles.some((w) => w >= e.tick && w <= e.tick + MAX_WINDOW)) continue;
    const spot = { x: s0.ball.x, y: s0.ball.y };
    windows++;

    for (const gk of GKS) {
      // 자기 팀이 차는 세트피스에서 골키퍼가 taker 면(골킥) 스팟으로 걸어가는 것이 정상이다.
      if (s0.ballOwner === gk.id) continue;
      const p0 = s0.players.find((p) => p.playerId === gk.id);
      if (!p0) continue;
      // 정지가 시작될 때 이미 나가 있었다면(직전 오픈플레이에서 스위퍼로 나와 있던 경우)
      // 그 지점까지는 허용하고 **거기서 더 나가는 것**만 위반으로 본다.
      const startDist = Math.abs(p0.pos.x - gk.goalX);
      const allowed = Math.max(BOX_DEPTH_M, startDist) + TOL_M;
      let peak: Excursion | null = null;

      for (let t = e.tick; t <= e.tick + MAX_WINDOW; t++) {
        const s = byTick.get(t);
        if (!s) break;
        if (t > e.tick && (s.ballOwner == null || Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y) > 0.3)) break;
        if (t > e.tick && restartTicks.includes(t)) break;
        if (s.ballOwner === gk.id) break; // 창 도중 taker 가 됐다면(재선언) 정상.
        const p = s.players.find((q) => q.playerId === gk.id);
        if (!p) break;
        const dist = Math.abs(p.pos.x - gk.goalX);
        if (dist > allowed && (!peak || dist > peak.distM)) {
          peak = { kind, tick: t, gk: gk.id, distM: +dist.toFixed(1), allowedM: +allowed.toFixed(1) };
        }
      }
      if (peak) worst.push(peak);
    }
  }
  return { worst, windows };
}

interface Case {
  name: string;
  log: MatchLog;
  config: EngineConfig;
}

function buildCases(): Case[] {
  const select = makeSelectData();
  const cases: Case[] = REALISM_SEEDS.map((seed) => ({
    name: `real:${seed}`,
    log: runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, defaultEngineConfig),
    config: defaultEngineConfig,
  }));
  cases.push({
    name: "showcase",
    log: runMatch(demoSeed, demoHome, demoAway, demoSelect, showcaseConfig as EngineConfig),
    config: showcaseConfig as EngineConfig,
  });
  return cases;
}

const cases = buildCases();
const scans = cases.map((c) => ({ c, s: scanGkExcursions(c.log, c.config) }));

describe("데드볼 중 골키퍼 이탈 금지 (#230)", () => {
  it("스캔 표본이 충분하다(계약이 빈 집합을 통과하지 않게)", () => {
    const windows = scans.reduce((n, x) => n + x.s.windows, 0);
    expect(windows).toBeGreaterThan(200);
  });

  it("정지 중 골키퍼가 자기 페널티 에어리어를 벗어나지 않는다", () => {
    const v: string[] = [];
    for (const { c, s } of scans) for (const x of s.worst) v.push(`[${c.name}] ${JSON.stringify(x)}`);
    expect(v.slice(0, 20), `${v.length}건\n${v.slice(0, 20).join("\n")}`).toEqual([]);
  });

  it("골킥에서 **상대** 골키퍼가 스팟 쪽으로 끌려오지 않는다(원 증상 직격)", () => {
    const v: string[] = [];
    for (const { c, s } of scans) {
      for (const x of s.worst.filter((w) => w.kind === "goal_kick")) v.push(`[${c.name}] ${JSON.stringify(x)}`);
    }
    expect(v.slice(0, 20), `${v.length}건\n${v.slice(0, 20).join("\n")}`).toEqual([]);
  });
});
