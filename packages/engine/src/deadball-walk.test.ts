import { describe, it, expect } from "vitest";
import { runMatch } from "./match";
import { defaultEngineConfig } from "./config";
import { demoSeed, demoHome, demoAway, demoSelect, makeTacticalInput } from "./fixtures";
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
function scanRestarts(seed: string = demoSeed): Scan {
  const home = seed === demoSeed ? demoHome : makeTacticalInput("H", seed);
  const away = seed === demoSeed ? demoAway : makeTacticalInput("A", seed);
  const log = runMatch(seed, home, away, demoSelect, config);
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

/**
 * #176 드리프트 계약 전용 시드. 걷기/도달 계약(위 `scan`)은 쇼케이스 데모(demoSeed)를 그대로 쓰고,
 * **드리프트만** 별도 시드로 잰다.
 *
 * 이유: #182(코너 rest defence)로 매치 전개가 바뀌면서 demoSeed 에서는 강탈 타이밍이 더는
 * 안 잡힌다(drift 0). 그렇다고 `it.fails` 를 `it` 으로 뒤집으면 **버그가 고쳐졌다고 거짓 신호**를
 * 준다 — #176 은 아직 안 고쳐졌고, 스캔하면 여러 시드에서 그대로 재현된다:
 *   4815162367(4) · 4815162361(6) · 4815162347(3) · 4815162346(1) · 4815162365(1) · 4815162369(1)
 *   (#182 리베이스로 #181 공 도착/아웃 판정이 들어와 재스캔 — 구 4815162345 는 이제 drift 0)
 * 그래서 재현되는 시드로 **알려진버그 계약을 살려둔다**. #176 이 접근 금지를 넣으면 이 시드에서도
 * drift 0 이 되어 `it.fails` 가 통과로 뒤집히고, 그때 `it` 으로 되돌린다(안전장치 유지).
 */
const DRIFT_SEED = "4815162367";
const driftScan = scanRestarts(DRIFT_SEED);

describe("deadball taker walk (#59)", () => {
  it("코너/스로인 taker 가 공으로 **걸어가** 도달한다(순간배치 아님)", () => {
    expect(scan.checked, "판정 가능한 코너/스로인 없음").toBeGreaterThan(0);
    expect(scan.jumps, scan.jumps.join(" | ")).toEqual([]);
    expect(scan.unreached, scan.unreached.join(" | ")).toEqual([]);
  });

  /**
   * ⚠️ **알려진버그 계약 — #176 데드볼 taker 강탈. #176 머지 시 해제**(`it.fails` → `it`).
   *
   * 데드볼 정지 동안 상대의 스팟 접근에 아무 제약이 없어, 정지가 끝나는 순간 상대가 스팟 위
   * taker 옆에 서 있다가 그대로 태클로 공을 뺏는 버그. 접근 금지(9.15m / 골킥은 박스 밖)
   * 규칙은 **여전히 미구현**이다.
   *
   * ── 왜 전용 시드(DRIFT_SEED)를 쓰는가 ─────────────────────────────────────────────
   * #178 시절엔 쇼케이스 데모(demoSeed)에 그 사례(`t2051 throw_in` → `t2064 tackle` → 공 1.67m
   * 이탈)가 들어 있었다. 그런데 #181(공 도착/아웃 판정)과 #182(코너 rest defence)로 매치 전개가
   * 연달아 바뀌며 **그 시드에서는 강탈이 더는 발생하지 않는다**(drift 0).
   *
   * 이때 `it.fails` 를 `it` 으로 되돌리면 스위트는 녹색이 되지만 **"#176 이 고쳐졌다"는 거짓
   * 신호**가 된다 — 실제로는 안 고쳐졌고, 스캔하면 여러 시드에서 그대로 재현된다:
   *   4815162367(4) · 4815162361(6) · 4815162347(3) · 4815162346(1) · 4815162365(1) · 4815162369(1)
 *   (#182 리베이스로 #181 공 도착/아웃 판정이 들어와 재스캔 — 구 4815162345 는 이제 drift 0)
   * 그래서 **재현되는 시드로 알려진버그 계약을 살려둔다**(gameqa 결정). 걷기/도달 계약은
   * demoSeed 를 그대로 쓰고, 드리프트 계약만 DRIFT_SEED 로 잰다.
   *
   * #176 이 접근 금지 규칙을 넣으면 이 시드에서도 drift 0 이 되어 `it.fails` 가 "예상된 실패가
   * 통과함"으로 깨진다 → 그때 `it` 으로 되돌린다(해제를 강제하는 안전장치). 시드에 의존하지 않는
   * 진짜 규칙 계약(접근 금지)은 **#176 스코프**에서 작성한다.
   */
  it.fails("정지 중 공이 스팟에 머문다 — #176 데드볼 taker 강탈 버그 의존(#176 머지 시 해제)", () => {
    expect(driftScan.checked, "판정 가능한 재시작 없음").toBeGreaterThan(0);
    expect(driftScan.drifts, driftScan.drifts.join(" | ")).toEqual([]);
  });
});
