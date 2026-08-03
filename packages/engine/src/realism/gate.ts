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
 * ## 순서가 비용을 정한다 (#376 부하 사건에서 engdeep 이 관측)
 * 게이트를 **싼 것부터** 돌면 비싼 것을 아예 안 돌고 끝나는 경우가 많다. #370 붕괴 사고에서
 * 유일한 필수 검증은 "붕괴 케이스 1경기 입력 1회" = **480ms** 였는데, 4.8분짜리 사다리가
 * 그보다 먼저 돌고 있었다. 권장 순서:
 *   1. 타입·계약 (`npm run typecheck`, `gate.test.ts` — 시뮬 0회, 초 단위)
 *   2. 문제를 재현하는 **최소 케이스 1건**(경기 1회 = 480ms)
 *   3. 결정론·골든 (`determinism` · `resume` · `hygiene`)
 *   4. 밴드 1점 확인 (60시드 집계 1회 ≈ 29초)
 *   5. 사다리 (`npm run test:ladder`) — **노브를 만졌을 때만**
 *
 * ## ⚠️ 그리고: 밴드가 비싼 검증을 부른다 (#376)
 * 사다리·스윕이 도는 이유는 대개 **밴드를 다시 맞추기 위해서**다. hero 가 "팀당 슛 12–14 는
 * 안 지켜도 된다"고 완화한 순간 재보정 스윕 자체가 불필요해졌다. 즉 비용을 지우는 길이
 * "계약을 줄이기"만 있는 게 아니라 **밴드가 아직 정당한지 재검토하기**도 있다.
 * 이 파일은 전자(실행 시점 분리)만 한다 — 후자는 게임 디자인 결정이라 hero 판단 영역이다.
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
    what: "슛 볼륨 레버 사다리 4종(chain.goalValue 단조 + contest.shootXgThreshold 단조 + chain.shootDistance.perM 단조 + weighted 롤백 2점 대비)",
    issue: "#99 G-A / #279 / #338 / #357 / #407 N1",
  },
  {
    file: "box-arrival.test.ts",
    what: "박스 도착런 정원 사다리 3 rung(`movement.boxArrival.maxRunners` 0/1/2 — 게이트 틱당 박스 안 비ST 인구 단조. 3 이상은 자격자 수에 막혀 포화)",
    issue: "#407 N2",
  },
  {
    file: "lane-read.test.ts",
    what: "수비 레인 예측 용량–반응(세기 4 rung — 읽힌 레인의 좁힘·점유 격차가 단조)",
    issue: "#379 (트랙 D M3-B)",
  },
  {
    file: "offside-trap.test.ts",
    what: "오프사이드 트랩 `stepUpM` 사다리 3 rung(n60 — 라인 뒤 상대 · 라인 높이 단조)",
    issue: "#377 S3-C 독립검증 m1 (n20 인접 rung 은 t 0.70~1.06 으로 분해 불가)",
  },
  {
    file: "offside-call.test.ts",
    what: "오프사이드 호출 게이트 `rules.offside.callProb` 사다리 4 rung(n60 — 콜 빈도 엄격 단조)",
    issue: "#407 ⑦ (rung 간격은 se 의 3.5~7배 — 촘촘한 rung 은 검출력 부족이라 일부러 뺐다)",
  },
];
