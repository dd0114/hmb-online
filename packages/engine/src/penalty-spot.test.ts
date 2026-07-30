import { describe, it, expect } from "vitest";
import { runMatch } from "./match";
import { defaultEngineConfig } from "./config";
import { demoSeed, demoHome, demoAway, demoSelect } from "./fixtures";
import type { MatchLog, TickSnapshot } from "@hmb/shared";

/**
 * #48 페널티 스팟 무드리프트 계약: PK 는 페널티 스팟(정중앙)에서 실행돼야 한다.
 * restartPenalty 가 taker.posFx 만 스팟에 고정하고 targetFx 를 오픈플레이 잔여값으로 두면,
 * 세트피스 정지 동안 위치적분 루프(match.ts)가 taker 를 그 targetFx 로 걸어나가게 해 공이
 * 스팟에서 드리프트한다 — 코너/스로인의 #31 과 동일 메커니즘(restartSetPiece 는 targetFx 도
 * 스팟으로 핀). 페널티만 그 라인이 누락됐던 회귀를 박제한다.
 */
const config = defaultEngineConfig;
const CENTER_Y = config.pitch.height / 2; // 34
// default config 에서 페널티가 발생하는 시드(스캔으로 확정). 재현 고정.
// 매치 전개가 바뀔 때마다 재스캔한다: "3"(~0.15.0) → "2"(0.16.0 좌우대칭 픽스) →
// "1"(#182 코너 rest defence) → "5"(#182 리베이스, #181 공 도착/아웃 판정 반영) →
// "3"(#279 사슬 코어) → **"4"**(#307 프리킥 벽/백업 + 데드볼 도착 페이싱 — 데드볼 배치와
// 프리킥 정지 길이가 바뀌며 시드 3 에서 페널티가 소멸).
// 스캔 결과 보유 시드(1~60): 4/6/7/8/9/10/11/12/14/16/18/20/24/25/26/28/29/38/42/45/46/48/
// 49/50/51/54/57/58/59/60. 재스캔은 penalty 이벤트 유무로 훑으면 된다.
//   → **"13"**(engine@0.25.0 볼륨 재보정 — 공 물리 3건 + 데드볼 2건 + config 재보정).
// engine@0.26.0(#320 공 물리 속도벡터 재작성 + 볼륨 재보정)에서도 **"13" 이 그대로 유효하다**.
// 재스캔 실측(1~80): penalty 보유 시드 36개 —
//   8,13,15,16,18,20,23,24,26,27,30,32,34,36,38,39,40,48,49,51,52,53,56,58,60,61,62,63,64,65,69,
//   71,73,77,78,79. 백업이 넉넉하다.
// 0.25.0 주석이 경고한 병목(파울 팀당 5.11 회 = 벤치의 절반, PK 시드 1개)은 #320 에서 해소됐다 —
// 속도 기반에서 공 소유 틱이 회복되며 태클 시도가 늘었고 `foul.base`(태클 시도당 확률)가
// 자동으로 따라 올라갔다. 같은 사유가 `e2e/gen-fixtures.test.ts` 에도 적혀 있다.
const PK_SEED = "13";

function snapByTick(log: MatchLog): Map<number, TickSnapshot> {
  return new Map(log.tickSnapshots.map((s) => [s.tick, s]));
}

/**
 * 정지 창을 **같은 하프 안으로 잘라내는** 상한 틱(포함).
 *
 * 왜 필요한가 (engine@0.24.0 사슬 채택에서 처음 걸림): 세트피스가 하프 종료 직전에 선언되면
 * `from + stoppageTicks` 창이 하프 경계를 넘는다. 경계 다음 틱의 공은 **킥오프 리셋으로 중앙
 * (52.5, 34)** 에 있으므로, 스팟 대비 거리가 30m+ 로 찍혀 "드리프트"로 오판된다.
 * 실제로 `free_kick@2693`(STOP=8 → 창 2693..2701)이 t2700 의 하프 휘슬+킥오프를 삼켜
 * 35.8m 를 기록했다 — 공은 2693~2699 내내 (88.3, 33.4) 에 **정확히 정지**해 있었다.
 * 이건 드리프트 회귀가 아니라 **측정 창 버그**다. 창을 하프 안으로 자른다(가드는 그대로 유지).
 */
function halfBoundedEnd(log: MatchLog, from: number, stop: number): number {
  const whistle = log.events.find((e) => e.type === "half_whistle" && e.tick > from);
  const cap = whistle ? whistle.tick - 1 : Number.POSITIVE_INFINITY;
  return Math.min(from + stop, cap);
}

describe("penalty spot no-drift (#48)", () => {
  it("PK 정지 동안 공이 페널티 스팟에서 드리프트하지 않는다(스팟에서 슛)", () => {
    const log = runMatch(PK_SEED, demoHome, demoAway, demoSelect, config);
    const byTick = snapByTick(log);
    const pens = log.events.filter((e) => e.type === "penalty");
    expect(pens.length, `시드 ${PK_SEED} 에 페널티가 있어야 한다(스캔 확정)`).toBeGreaterThan(0);

    const STOP = config.rules.penalty.stoppageTicks;
    const DRIFT_MAX_M = 2; // 스팟 정착 허용치. 버그 드리프트는 5m+ 라 넉넉히 판별.
    for (const p of pens) {
      const spot = byTick.get(p.tick)!.ball; // 선언 순간 = 페널티 스팟(정중앙).
      // 스팟 자체가 정중앙(y=34)인지 확인.
      expect(
        Math.abs(spot.y - CENTER_Y),
        `penalty@${p.tick} 스팟 y=${spot.y.toFixed(1)} 중앙 아님`,
      ).toBeLessThan(0.5);
      // 선언~슛(정지 종료)까지 공이 스팟에 머무는가.
      let maxDrift = 0;
      let worst = -1;
      const end = halfBoundedEnd(log, p.tick, STOP);
      for (let t = p.tick; t <= end; t++) {
        const s = byTick.get(t);
        if (!s) continue;
        const d = Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y);
        if (d > maxDrift) {
          maxDrift = d;
          worst = t;
        }
      }
      expect(
        maxDrift <= DRIFT_MAX_M,
        `penalty@${p.tick} 정지 중 공 드리프트 ${maxDrift.toFixed(1)}m (t${worst}) — taker 가 스팟에서 걸어나감`,
      ).toBe(true);
    }
  });

  // 프리킥도 restartSetPiece 를 거치지 않아 같은 targetFx 누락 버그가 있었다(#48 스윕에서 발견,
  // demoSeed free_kick@226 은 수정 전 22m 드리프트). 같은 1줄 수정으로 함께 해소 → 회귀 방지.
  it("free_kick 정지 동안 공이 스팟에서 드리프트하지 않는다", () => {
    const log = runMatch(demoSeed, demoHome, demoAway, demoSelect, config);
    const byTick = snapByTick(log);
    const fks = log.events.filter((e) => e.type === "free_kick");
    expect(fks.length).toBeGreaterThan(0);
    const STOP = config.rules.freeKickStoppageTicks;
    const DRIFT_MAX_M = 3;
    for (const fk of fks) {
      const spot = byTick.get(fk.tick)!.ball;
      let maxDrift = 0;
      let worst = -1;
      const end = halfBoundedEnd(log, fk.tick, STOP);
      for (let t = fk.tick; t <= end; t++) {
        const s = byTick.get(t);
        if (!s) continue;
        const d = Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y);
        if (d > maxDrift) {
          maxDrift = d;
          worst = t;
        }
      }
      expect(
        maxDrift <= DRIFT_MAX_M,
        `free_kick@${fk.tick} 정지 중 공 드리프트 ${maxDrift.toFixed(1)}m (t${worst})`,
      ).toBe(true);
    }
  });
});
