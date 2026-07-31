import { defaultEngineConfig, type EngineConfig } from "../config";

/**
 * realism/rollback — **롤백 config 의 단일 출처**.
 *
 * 왜 파일로 뺐나: 이 config 는 `hold-pressure.test.ts`(0.27.0 해시 비트동일 계약)와
 * `foul-probe.test.ts`(#358 층별 분해 대조군) 둘이 쓴다. 테스트 파일끼리 import 하면 그쪽
 * describe 가 같이 등록되므로, 공유 자산은 일반 모듈에 둔다. 값 자체는 옮기기만 했다.
 *
 * 순수 분석 유틸(프로덕션 `index.ts` 에 export 되지 않는다).
 */

/**
 * #353(홀드 압박·슛 압박) + #357(가치 재보정) 이 추가·변경한 노브를 전부 **레거시(무효)** 로
 * 되돌린 config = **0.27.0 상당**.
 *
 * 홀드: `keepBase=1` + 페널티 0 → `EV = 1×(V−holdPenalty) + 0×턴오버` = 구 식과 **정확히** 같다
 * (`mulFrac(v, FRAC_SCALE) === v`, `mulFrac(v, 0) === 0` 이라 반올림 손실도 없다).
 *
 * `goalValue`/`shootXgThreshold`/`onTargetBase`/`headerXgThreshold` 는 #353 메커니즘과 무관하지만
 * **0.27.0 해시를 재현하려면 0.27.0 의 값이어야 한다** — 안 되돌리면 계약이 "메커니즘이 꺼지는가"가
 * 아니라 "그 뒤로 튜닝이 있었는가"를 재게 된다(그건 골든의 일이다). 되돌린 상태에서 해시가
 * **여전히 비트 동일**하다는 것이 #357 이 **config-only** 였다는 증거다.
 */
export function legacy0270(): EngineConfig {
  const cfg = defaultEngineConfig;
  return {
    ...cfg,
    chain: {
      ...cfg.chain,
      hold: { ...cfg.chain.hold, keepBase: 1, pressPenalty: 0, tightPenalty: 0 },
      goalValue: 9.4,
    },
    contest: {
      ...cfg.contest,
      shotPressureAimPenalty: 0,
      shotPressureXgMult: 1,
      passReceiverPressurePenalty: 0,
      shootXgThreshold: 0.07,
      onTargetBase: 0.21,
      // #357 헤더 임계 분리 이전 = 필드 임계와 같은 값(그때는 한 노브였다).
      aerial: { ...cfg.contest.aerial, headerXgThreshold: 0.07 },
    },
    rules: {
      ...cfg.rules,
      // #358 파울 재보정도 되돌린다(같은 이유 — 0.27.0 해시를 재현하려면 0.27.0 의 값이어야 한다).
      // `runningMult: 1` 은 곱이 항등이라 새 코드 경로가 **꺼진다** = 롤백 스위치의 계약이기도 하다.
      foul: { ...cfg.rules.foul, base: 0.0188, boxFoulMult: 1.0, runningMult: 1 },
    },
  };
}
