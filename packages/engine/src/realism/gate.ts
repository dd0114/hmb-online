/**
 * 사다리·스윕 실행 게이트 (#371).
 *
 * ## 왜 있나
 * `npm test` 4.3분의 대부분이 **사다리(단조성) 계약** 하나였다. 실측(2026-07-31):
 *   경기 1회 시뮬 480ms · 60시드 집계 1회 28.8초 · `shot-frequency` = 60시드 × **10 사다리 점** = 4.8분.
 * 사다리는 "이 config 노브가 정말 레버인가"를 보는 계약이라 **노브를 만질 때** 필요한 것이지
 * 매 커밋마다 필요한 것이 아니다. 반면 밴드(1점) · 관계식 · 결정론 · 골든은 **매번** 필요하다.
 *
 * ## 무엇을 나눴나
 *  - **항상**: 결정론(desync·resume·hygiene) · 골든 · 관계식 계약 · 밴드 **1점 확인**(60시드 1회)
 *  - **게이트**(`HMB_LADDER=1`): 사다리(단조성) · 2점 대비 · 노브 격자
 *
 * ## ⚠️ 사다리를 없앤 것이 아니다
 * `decisionWeights.shoot` 이 사슬 코어에서 **완전 무효**가 된 것을 잡은 게 정확히 이 사다리다(#338).
 * 없애면 죽은 노브를 놓친다. 그래서 **삭제가 아니라 게이트**이고, 규칙은 다음 한 줄이다 —
 *   **엔진 config 노브를 만지는 웨이브는 `npm run test:ladder` 를 반드시 돌린다.**
 * 게이트된 스위트가 조용히 사라지지 않게 `gate.test.ts` 가 아래 `LADDER_SUITES` 를 상시 검증한다.
 *
 * ## 실행법
 * ```bash
 * npm test                 # 항상 도는 계약(사다리 제외)
 * npm run test:ladder      # 사다리·단조성만 (엔진 realism 스코프)
 * npm run test:full        # 전량(항상 + 사다리)
 * HMB_LADDER=1 npx vitest run packages/engine/src/realism/shot-frequency.test.ts   # 단일 파일
 * ```
 */

const ENV = (process as unknown as { env?: Record<string, string | undefined> }).env;

/** 사다리·단조성·격자 스위트를 켠다. 기본 off — `HMB_LADDER=1` 로 on. */
export const LADDER: boolean = Boolean(ENV?.HMB_LADDER);

/** 스킵 사유를 스위트 제목에 붙여 리포터에서 "왜 안 돌았나"가 보이게 한다. */
export const LADDER_TAG = "[사다리 · HMB_LADDER=1]";

/**
 * 게이트된 사다리 스위트 레지스트리 — `gate.test.ts` 의 커버리지 손실 가드가 이 목록을 읽는다.
 * 사다리를 새로 만들거나 파일을 옮기면 **여기도 갱신**해야 게이트가 통과한다(= 조용한 삭제 방지).
 *
 * `file` 은 `packages/engine/src/realism/` 기준 상대경로.
 */
/**
 * ⚠️ `HMB_LADDER` 는 **계약 사다리**만 켠다 — 이 리포의 진단 프로브(`HMB_VOLSWEEP` · `HMB_FOULSWEEP` ·
 * `HMB_PRESS` · `HMB_SWEEP` · `HMB_CHAIN` · `HMB_LOFT` · `HMB_MICRO` · `HMB_BEHAV` …)와는 **다른 축**이다.
 * 그쪽은 원래부터 기본 off 인 **격자 스윕·리포트**(계약이 아니라 튜닝을 위한 측정)라 각자 자기
 * env 와 자기 인자를 갖는다. 하나로 합치면 `test:ladder` 가 격자 전체를 끌고 와 몇 시간짜리가 된다.
 * 여기 레지스트리에는 **원래 항상 돌던 계약 중 온디맨드로 옮긴 것**만 올린다.
 */
export const LADDER_SUITES: { file: string; what: string; issue: string }[] = [
  {
    file: "shot-frequency.test.ts",
    what: "슛 볼륨 레버 사다리 3종(chain.goalValue 단조 + 현 볼륨 노브 단조 + weighted 롤백 2점 대비)",
    issue: "#99 G-A / #279 / #338 / #357",
  },
];
