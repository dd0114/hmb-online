import { describe, it, expect } from "vitest";
import { runMatch } from "./match";
import { defaultEngineConfig } from "./config";
import { demoSeed, demoHome, demoAway, demoSelect } from "./fixtures";
import type { MatchLog, TickSnapshot } from "@hmb/shared";

/**
 * #59 엔진 네이티브 데드볼: taker 를 스팟에 즉시 순간배치하지 않고 공(스팟)으로 걸어가게 한다.
 *  - taker(공 소유자)는 여러 틱에 걸쳐 공으로 이동 — 프레임간 이동이 걷기 속도(≤MAX_STEP)라
 *    순간배치(15~40m 점프)가 아니다. 그리고 공에 도달한다.
 *  - 공은 스팟에 정지 유지(no drift).
 * 뷰어 트릭 없이 이 데이터로 자연 무브먼트가 재생된다.
 *
 * ## 두 계약으로 분리한 이유 (#178 → #176)
 * 원래 하나의 `it` 에 [걷기·도달·공정지] 세 보장이 묶여 있었다. 지금 **공정지만** #176 버그로
 * 깨지는데, 통째로 `it.fails` 로 돌리면 걷기·도달 커버리지까지 같이 사라진다(회귀가 숨는다).
 * 그래서 스캔을 헬퍼로 뽑고 계약을 둘로 나눴다 — 걷기·도달은 계속 green 으로 지킨다.
 */
const config = defaultEngineConfig;
const STOP = config.setPiece.stoppageTicks;
const MAX_STEP = 8; // 걷기 상한(빠른 선수 maxPerTick=7). 순간배치/클램프면 10~40m.
const MAX_WIN = STOP + 18; // 동적 정지(도달까지 연장) 상한 초과 판정창.

function snapByTick(log: MatchLog): Map<number, TickSnapshot> {
  return new Map(log.tickSnapshots.map((s) => [s.tick, s]));
}

interface Scan {
  /** 판정 가능한 재시작 수. */
  checked: number;
  /** 단일틱 점프가 걷기 상한을 넘은 건(순간배치/클램프). */
  jumps: string[];
  /** taker 가 공에 도달하지 못한 건. */
  unreached: string[];
  /** 정지 중 공이 스팟에서 이탈한 건(#176 의존). */
  drifts: string[];
}

/** 데모 로그의 코너/스로인 재시작을 훑어 위반을 수집한다(단언 없음 — 계약별로 나눠 쓴다). */
function scanRestarts(): Scan {
  const log = runMatch(demoSeed, demoHome, demoAway, demoSelect, config);
  const byTick = snapByTick(log);
  const restarts = log.events.filter(
    (e) => e.type === "kickoff" && (e.detail === "corner" || e.detail === "throw_in"),
  );
  const out: Scan = { checked: 0, jumps: [], unreached: [], drifts: [] };

  for (const r of restarts) {
    const ci = r.tick;
    const c0 = byTick.get(ci);
    if (!c0 || !c0.ballOwner) continue;
    const spot = c0.ball;
    const takerId = c0.ballOwner;
    // ci-1(재시작 직전) 스냅샷 없으면 배치 점프 판정 불가 → 스킵.
    if (!byTick.get(ci - 1)) continue;
    out.checked++;
    let maxStep = 0;
    let reached = false;
    let ballLeft = false;
    let ranOut = false;
    let prevPos: { x: number; y: number } | null = null;
    const drifts: string[] = [];
    // ci-1 부터 본다: **배치 순간(ci-1→ci)의 순간이동/클램프 점프까지** 잡는다(클램프 제거 검증).
    // 정지는 동적(taker 도달까지 연장)이므로 공이 스팟을 떠나면(재시작 실행) 종료.
    for (let t = ci - 1; t <= ci + MAX_WIN; t++) {
      const s = byTick.get(t);
      if (!s) { ranOut = true; break; }
      const tk = s.players.find((p) => p.playerId === takerId);
      if (!tk) continue;
      const drift = Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y);
      if (t > ci && drift > 3) { ballLeft = true; break; } // 재시작 실행(크로스/스로인) → 정지 종료.
      if (prevPos && t >= ci) {
        maxStep = Math.max(maxStep, Math.hypot(tk.pos.x - prevPos.x, tk.pos.y - prevPos.y));
      }
      prevPos = { x: tk.pos.x, y: tk.pos.y };
      if (Math.hypot(tk.pos.x - spot.x, tk.pos.y - spot.y) <= config.contest.controlRange + 0.5) reached = true;
      // 공은 스팟에 정지 유지(taker 가 걸어오는 동안 공은 안 움직임).
      if (t >= ci && drift >= 1.5) {
        drifts.push(`restart@${ci} 공 드리프트 t${t} ${drift.toFixed(2)}m (${s.ball.x.toFixed(1)},${s.ball.y.toFixed(1)})`);
      }
    }
    // 경기 끝에 걸려 재시작 미완(공 안 떠남 + 스냅샷 소진 + 미도달) → 판정 불가, 제외.
    if (ranOut && !ballLeft && !reached) { out.checked--; continue; }
    out.drifts.push(...drifts);
    if (maxStep > MAX_STEP) {
      out.jumps.push(`restart@${ci} taker(${takerId}) 단일틱 점프 ${maxStep.toFixed(1)}m — 순간배치/클램프(걷기 아님)`);
    }
    if (!reached) out.unreached.push(`restart@${ci} taker 가 공(스팟)에 도달 못 함(정지 시간 부족?)`);
  }
  return out;
}

const scan = scanRestarts();

describe("deadball taker walk (#59)", () => {
  it("코너/스로인 taker 가 공으로 **걸어가** 도달한다(순간배치 아님)", () => {
    expect(scan.checked, "판정 가능한 코너/스로인 없음").toBeGreaterThan(0);
    expect(scan.jumps, scan.jumps.join(" | ")).toEqual([]);
    expect(scan.unreached, scan.unreached.join(" | ")).toEqual([]);
  });

  /**
   * ⚠️ **#176 은 아직 안 고쳐졌다 — 이 계약이 통과하는 건 "타임라인이 옮겨가 이 데모에 강탈
   * 사례가 없다"는 뜻일 뿐이다.**
   *
   * 데드볼 정지 동안 상대의 스팟 접근에 아무 제약이 없어, 정지가 끝나는 순간 상대가 스팟 위
   * taker 옆에 서 있다가 그대로 태클로 공을 뺏는 버그(#176). 접근 금지(9.15m / 골킥은 박스 밖)
   * 규칙은 **여전히 미구현**이다.
   *
   * #178 시절엔 쇼케이스 데모에 그 사례(`t2051 throw_in` → `t2064 tackle` → 공 1.67m 이탈)가
   * 들어 있어 `it.fails` 로 박아뒀는데, #181(공 도착/아웃 판정)로 매치 전개가 바뀌며 이 시드의
   * 데모에서는 강탈이 발생하지 않는다 → `it.fails` 를 그대로 두면 "예상된 실패가 통과함"으로
   * 스위트가 깨진다. 그래서 `it` 으로 되돌리되, **#176 이 해결됐다는 뜻이 아님**을 여기 남긴다.
   * 시드에 의존하지 않는 진짜 규칙 계약(접근 금지)은 **#176 스코프**에서 작성한다.
   */
  it("정지 중 공이 스팟에 머문다 — 이 시드 한정(#176 규칙 미구현, 위 주석)", () => {
    expect(scan.drifts, scan.drifts.join(" | ")).toEqual([]);
  });
});
