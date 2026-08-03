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

/* ══════════════════════════════════════════════════════════════════════════ *
 * 출하 **튜닝값**의 되돌리기 지점 (#407 / 0.44.0)
 *
 * ## 왜 필요한가 — config-only 웨이브가 남의 롤백 계약을 전부 깬다
 * 이 리포에는 웨이브마다 **롤백 비트동일 계약**이 있다: *"내 스위치를 끄면 구 버전(`2cabfc3`,
 * `3d38e86`, `221c673` …)의 해시가 그대로 나온다"*. 강한 계약이고 실제로 여러 번 사고를 잡았다.
 * 그런데 그 계약들은 **"내 스위치 밖의 출하값은 그대로다"를 암묵 전제**로 깔고 있다.
 *
 * 0.44.0(박스 유입 다양성 팔)은 **코드를 한 줄도 안 바꾸고 출하 튜닝값 3개만** 바꿨다. 그 순간
 * 여섯 개 웨이브의 롤백 계약이 동시에 빨개진다 — 그 웨이브들이 회귀해서가 아니라 비교
 * 기준점이 움직였기 때문이다.
 *
 * ## 처방을 바꾼다 — 재기록이 아니라 **기준점 이동**
 * 0.42.0 까지의 관용구는 **골든 해시 재기록**이었다(각 파일의 "재기록" 주석 참조). 그때마다
 * "구 버전과 bit-identical" 이라는 **역사적 앵커가 하나씩 사라진다** — 재기록이 정당했는지
 * 확인할 방법이 그 자리에 안 남는다. 대신 롤백 config 에 `preShipping()` 을 **추가로** 적용하면
 * 원래 값이 **지금도 재현되는 사실**로 남고, 그 재현 자체가 정당성의 증명이 된다.
 *
 * ## 다음 config-only 웨이브가 할 일
 * 함수를 하나 **추가**하고(`pre045` …) `preShipping()` 에 이어 붙인다. 롤백 계약들은
 * `preShipping()` 하나만 부르므로 **그 파일들을 다시 안 건드려도 된다** — 이 함수가 없었다면
 * 매번 여섯 파일을 손대야 했고, 그 비용이 곧 "그냥 골든을 재기록하자"는 압력이 된다.
 *
 * ⚠️ 여기 적히는 것은 **출하 튜닝값의 변경 이력**뿐이다. 기제(코드) 변경은 각 웨이브의 자기
 * 스위치로 되돌린다 — 그건 이 함수가 대신할 수 없다.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ **현재는 항등(identity)이다 — 되돌릴 출하 튜닝값 변경이 없다.**
 *
 * #407 박스 유입 탐색(0.44.0 후보)이 `variety.defenderOverlapProb`·`variety.overlapBaseLine`·
 * `rules.foul.base` 세 값을 바꾸는 config-only 팔을 시도했고, **그 팔은 출하되지 않았다**
 * (탐색 종료 — `issues/2026-08-03-engine-box-inflow-arm.md` §7-quinquies). 그래서 되돌릴 것이 없다.
 *
 * **그런데도 이 함수와 호출부를 남기는 이유**는, 이 리포가 실제로 겪은 구조 문제의 처방이기
 * 때문이다(위 블록). 다음 config-only 웨이브는 **여기에 값을 채우기만 하면** 여덟 개 롤백 계약이
 * 자동으로 기준점을 잡는다 — 그 파일들을 다시 안 건드려도 되고, 그래서 **골든 재기록 압력이
 * 생기지 않는다**. 그 압력이 곧 역사적 앵커를 지워 온 원인이었다.
 *
 * ⚠️ **항등인 동안 위 3층 보증은 잠들어 있다**(되돌릴 값이 없으면 no-op 변이가 아무것도 안 죽인다).
 * 값을 채우는 웨이브가 **그때 3층을 되살려야 한다** — 특히 ②(헬퍼 출력을 테스트 파일의 **독립
 * 리터럴**과 deep-equal)와 ③(`변경된 서브트리만` 단언). 값만 채우고 계약을 안 세우면 이 구조는
 * "통과하는데 아무것도 안 지키는" 상태가 된다.
 */
export function preShipping(_c: EngineConfig): void {
  // 다음 config-only 웨이브가 여기에 `preNNN(_c)` 를 이어 붙인다(최신부터 역순).
}

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
  const out: EngineConfig = {
    ...cfg,
    // ⚠️ 스프레드는 얕다 — `variety` 를 복사해 두지 않으면 아래 `preShipping` 이
    // `defaultEngineConfig.variety` **자체**를 오염시킨다(전역 상태 사고).
    variety: { ...cfg.variety },
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
  // #407(0.44.0): **출하 튜닝값도 0.43.0 으로** 되돌린다 — 같은 사유다("0.27.0 해시를 재현하려면
  // 0.27.0 의 값이어야 한다"). 안 되돌리면 이 계약이 "메커니즘이 꺼지는가"가 아니라 "그 뒤로
  // config-only 튜닝이 있었는가"를 재게 된다.
  // 순서 주의: `preShipping` 이 `foul.base` 를 0.135 로 되돌리므로 **0.27.0 값을 다시 덮는다**
  // (파울 계수는 이 롤백이 더 깊은 시점을 요구한다).
  preShipping(out);
  out.rules.foul.base = 0.0188;
  return out;
}
