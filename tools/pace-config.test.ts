import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runFirstHalf } from "../packages/engine/src/match";
import { defaultEngineConfig } from "../packages/engine/src/config";
import { makeSelectData, makeTacticalInput } from "../packages/engine/src/fixtures";
import { autoPaceDurationMs, autoPaceCurve } from "../packages/viewer-core/src/playback.mjs";
import { PACE_DRIFT_FRAC } from "../apps/web/src/match/live-pace";
import { REALISM_SEEDS } from "../packages/engine/src/realism/harness";

/**
 * 서버 시계(`hmb.match.clock.half-real-ms`)가 **화면의 실제 재생 길이와 계속 정합인지** 지킨다 (#216 AC2).
 *
 * ⚠️ **#365 이후 이 값은 폴백 창이다** — 운영 창은 러너가 준 그 하프의 실제 재생 길이다
 * (`SimulateResponse.playbackMs`). 폴백이 실제 재생과 동떨어지면 그 경로(구 러너·계산 실패)에서
 * 재생이 잘리거나 빈 시간이 생기므로 계속 지킨다.
 *
 * `MatchClockShippedDefaultsTest`(server-java)는 yml 값이 **적어둔 밴드** 안인지만 본다 — 그 밴드는
 * 사람이 옮겨 적은 숫자라, 뷰어 페이싱 상수(`PACE`)나 엔진 하프 틱 수가 바뀌면 실제 재생 길이가
 * 밴드 밖으로 나가도 계속 green 이다(독립검증 minor-C). 여기서 그 구멍을 막는다: **엔진으로 진짜
 * 하프를 돌려 코어 페이싱 모델로 재생 길이를 재고**, yml 값과 대조한다. 어느 쪽이 바뀌든 여기서 깨진다.
 *
 * 이 테스트가 깨지면 답은 하나다 — `node tools/measure-playback-pace.mjs` 로 다시 재고
 * `application.yml` 의 `half-real-ms` 를 그 값에 맞춘다(그리고 server-java 쪽 밴드도 함께).
 */

/**
 * 시드 편차에 모델·측정 오차 여유를 더한 폭. (#365 실측 155~212s = p50 176.6 대비 −12%/+20% —
 * 하프가 짧아 골·정지 하나가 전체에서 차지하는 비중이 커져 90분 때(±8%)보다 산포가 크다.
 * 그래도 ±20% 안이라 이 폭은 그대로 둔다.)
 */
const TOLERANCE = 0.2;

function ymlLong(key: string): number {
  const yml = readFileSync(new URL("../server-java/src/main/resources/application.yml", import.meta.url), "utf8");
  const m = new RegExp(`^\\s*${key}:\\s*(\\d+)`, "m").exec(yml);
  if (!m) throw new Error(`application.yml 에 ${key} 가 없다`);
  return Number(m[1]);
}

describe("#216 AC2 — 서버 창(half-real-ms) ↔ 켬 모드 실측 재생 길이", () => {
  it(
    "리얼 config 하프의 연출 재생 길이가 배포 창 값과 ±20% 안이다",
    () => {
      const seed = "pace-guard";
      const select = makeSelectData();
      const carry = runFirstHalf(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, defaultEngineConfig);
      const measuredMs = autoPaceDurationMs(carry.snapshots, carry.events);
      const halfRealMs = ymlLong("half-real-ms");

      // 진단용 — 깨졌을 때 "얼마나 어긋났나"가 바로 보이게.
      const ratio = measuredMs / halfRealMs;
      expect(
        Math.abs(ratio - 1),
        `켬 모드 재생 ${(measuredMs / 1000).toFixed(1)}s vs 창 ${(halfRealMs / 1000).toFixed(1)}s ` +
          `(비율 ${ratio.toFixed(3)}) — node tools/measure-playback-pace.mjs 로 다시 재고 맞춰라`,
      ).toBeLessThan(TOLERANCE);

      // 하프가 실제로 리얼 config 인지도 같이 본다 — 픽스처가 짧아지면 위 비교가 무의미해진다.
      // #365 로 경기 길이가 노브가 됐으므로(90 → 45분) 상수 대신 config 에서 유도한다. 그래도
      // "짧은 픽스처로 잰 것"은 여전히 걸린다(리얼 config 의 하프 틱과 정확히 같아야 한다).
      const realHalfTicks = Math.round((defaultEngineConfig.matchMinutes * 60_000) / defaultEngineConfig.msPerTick / 2);
      expect(carry.snapshots.length).toBe(realHalfTicks);
    },
    120_000,
  );
});

/**
 * **가변 배속 보정을 뺄 수 있는 근거** (#365, hero 확정 "고정 배속만 쓴다").
 *
 * 서버 창은 이제 그 하프의 **실제 재생 길이**다(러너가 `autoPaceDurationMs` 로 재서 준다) —
 * 그래서 총 길이는 정확히 맞는다. 하지만 서버 게이트(`liveTick`)는 경과시간에 **선형**인데
 * 연출 페이싱은 균일하지 않다(크루즈 4x / 키장면 1x / 홀드 정지). 그 구간 편차가 web 의 허용폭
 * (`PACE_DRIFT_FRAC`)을 넘으면 **회수 점프(되감기)가 발화**한다 — #216 이 없앤 고무줄이 돌아온다.
 *
 * 즉 "보정 없이도 안전하다"는 주장은 **이 부등식 하나에 걸려 있다**. 그래서 계약으로 박는다.
 */
describe("#365 보정 없는 라이브 재생 — 자연 재생이 선형 게이트를 허용폭 이상 앞서지 않는다", () => {
  it(
    `자연 재생의 최대 앞섬 < ${(PACE_DRIFT_FRAC * 100).toFixed(0)}% (web 회수 임계)`,
    () => {
      const select = makeSelectData();
      let worstAhead = 0;
      let worstSeed = "";
      for (const seed of REALISM_SEEDS.slice(0, 6)) {
        const carry = runFirstHalf(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, defaultEngineConfig);
        const { curve, totalMs, steps } = autoPaceCurve(carry.snapshots, carry.events);
        for (const [ms, idx] of curve) {
          // 창 = 이 하프의 실제 재생 길이(totalMs) → 서버 게이트가 허용하는 인덱스는 선형이다.
          const ahead = idx / steps - ms / totalMs;
          if (ahead > worstAhead) {
            worstAhead = ahead;
            worstSeed = seed;
          }
        }
      }
      expect(
        worstAhead,
        `최대 앞섬 ${(worstAhead * 100).toFixed(1)}% (seed ${worstSeed}) — 허용폭 ${(PACE_DRIFT_FRAC * 100).toFixed(0)}%`,
      ).toBeLessThan(PACE_DRIFT_FRAC);
    },
    180_000,
  );
});
