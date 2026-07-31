/**
 * 검증 티어 — #376 / #377 M0-3
 *
 * ## 문제
 * `engdeep` 세션이 vitest 를 2h13m 연속 돌려 **load average 328** 로 머신을 죽였다. 엔진 변경은
 * 이미 끝나 있었고 CPU 를 태운 것은 전부 검증이었다. 뿌리는 "검증이 한 덩어리"라는 것 —
 * 매 커밋에 필요한 것과 릴리스 전에 필요한 것이 같은 스위트에 섞여 있으면 사람은 **둘 다 안 돌리거나
 * 둘 다 돌린다**. #376 이 남긴 가장 아픈 관찰:
 *
 * > 이번 사고(#370)의 유일한 필수 AC 는 "붕괴 케이스 1경기 입력 1회"였다. 그건 **480ms** 다.
 * > **4.8분짜리 사다리보다 먼저 돌았어야 했다.**
 *
 * ## 티어
 * | | 언제 | 예산 | 담는 것 |
 * |---|---|---|---|
 * | **T0** | 매 커밋 | ≤1분 | 결정론(축약 반복)·하이진·계약 단위 + **붕괴 케이스 1경기** |
 * | **T1** | 노브를 만진 웨이브 | ≤5분 | T0 전량 + 다시드 집계 밴드 + **실덱 전량 스모크** |
 * | **T2** | 릴리스 전 | 제한 없음 | T1 + 사다리(`HMB_LADDER`) + 독립검증 + hero 눈 QA |
 *
 * **기본값은 T1 이고 T1 은 현행 `npm test` 와 같은 것을 돈다.** 다른 세션이 돌리던 것이 조용히
 * 줄어들면 그게 새 거짓 green 구멍이다. T0 은 `npm run test:t0` 로 **명시적으로** 고른다.
 *
 * ## 두 가지 게이트 방식 (둘 다 필요하다)
 * 1. **파일 단위 제외**(`T0_EXCLUDED`) — 모듈 최상위에서 다시드 집계를 돌리는 파일들. 이런 파일은
 *    `describe.skipIf` 로는 못 막는다(스킵해도 collect 단계에서 이미 다 계산된다). 그래서
 *    `vitest.config.ts` 가 T0 에서 **include 에서 뺀다**.
 * 2. **파일 안 부분 게이트**(`PARTIAL_GATED`) — 일부만 무거운 파일. `atLeastTier(n)` 로 그 블록만 막는다.
 *
 * ## HMB_LADDER 와의 관계
 * **별개 축**이다. `HMB_LADDER`(#371)는 사다리·단조성 **계약**을 켜고, 여기 티어는 **비용 계층**이다.
 * 합치지 않는 이유는 `gate.ts` 가 적은 것과 같다 — 한 env 에 두 의미를 실으면 어느 쪽을 끄고 싶은지
 * 표현할 수 없다. T2 = `HMB_TIER=2 HMB_LADDER=1`.
 *
 * ## 커버리지 손실 가드
 * 이 구조의 유일한 실패 모드는 **T0 제외 목록이 조용히 자라는 것**이다. `tier.test.ts` 가
 * ①등록된 경로가 실재하고 ②근거(`what`·`issue`)가 붙어 있고 ③`vitest.config.ts` 가 정확히
 * 이 목록만 제외하며 ④`atLeastTier` 를 쓰는 파일이 전부 `PARTIAL_GATED` 에 있는지(고아 검출)
 * 를 검증한다. `gate.ts`(#371)의 커버리지 가드와 같은 규율.
 */

const ENV = (process as unknown as { env?: Record<string, string | undefined> }).env;

/** env 원문 → 티어. 순수 함수로 뺀 이유 = 계약 테스트가 하위 프로세스 없이 검증할 수 있게. */
export function parseTier(raw: string | undefined): number {
  if (raw == null || raw === "") return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : 1;
}

/** 읽는 env 변수 이름 — 계약 테스트가 이 이름이 실제로 배선됐는지 확인한다(오타 검출). */
export const TIER_ENV = "HMB_TIER";

/** 현재 티어. `HMB_TIER=0|1|2`, 기본 **1**. */
export const TIER: number = parseTier(ENV?.[TIER_ENV]);

/** 이 티어 이상에서 돌아야 하는가. `describe.skipIf(!atLeastTier(1))` 형태로 쓴다. */
export function atLeastTier(n: number): boolean {
  return TIER >= n;
}

export const TIER_TAG = "[티어 · HMB_TIER]";

/** 등록 항목 — 근거 없이 목록에 오르지 못하게 `what`·`issue` 를 필수로 둔다. */
export interface TierEntry {
  /** 리포 루트 기준 경로. */
  file: string;
  what: string;
  issue: string;
  /** 실측 근사(초) — 예산 계산 근거. */
  seconds: number;
}

/**
 * **T0 에서 파일째 제외**되는 스위트. 전부 "모듈 최상위에서 다시드 집계를 돌리는" 부류다.
 * T1 이상에서는 전량 돈다 — 여기 있다고 검증이 사라지는 것이 아니라 **언제 도느냐**만 정한다.
 */
export const T0_EXCLUDED: TierEntry[] = [
  {
    file: "packages/engine/src/realism/one-on-one.test.ts",
    what: "1대1 찬스 판정 — GUARD_SEEDS(60) 전량 집계",
    issue: "#316 / #279",
    seconds: 21,
  },
  {
    file: "packages/engine/src/realism/hold-pressure.test.ts",
    what: "홀드 압박 반응 — REALISM_SEEDS 다점 대조군",
    issue: "#353",
    seconds: 19,
  },
  {
    file: "packages/engine/src/realism/header-threshold.test.ts",
    what: "헤더 임계 분리 — 8시드 × 변이체 대조",
    issue: "#357",
    seconds: 18,
  },
  {
    file: "packages/engine/src/realism/behaviour.test.ts",
    what: "행동·의도 지표 — 16시드 집계",
    issue: "#314",
    seconds: 7,
  },
  {
    file: "packages/engine/src/realism/foul-opportunity.test.ts",
    what: "파울 기회 계약 — GUARD_SEEDS(60) × 2 config",
    issue: "#358",
    seconds: 12,
  },
  {
    file: "packages/engine/src/realism/pass-accuracy.test.ts",
    what: "패스 성공률·롱패스 비율 — 10시드 집계 밴드",
    issue: "#99 E1/E2",
    seconds: 6,
  },
  {
    file: "packages/engine/src/realism/shot-frequency.test.ts",
    what: "슛 볼륨 — GUARD_SEEDS(60) 집계 밴드",
    issue: "#99 G-A / #279",
    seconds: 20,
  },
  {
    file: "packages/engine/src/corner-rest-defence.test.ts",
    what: "코너 잔류 수비 — 다시드 3층 대조. T0 임계경로의 절반을 혼자 먹는다(실측 64s).",
    issue: "#182",
    seconds: 64,
  },
  {
    file: "packages/engine/src/deadball-duplicate-id.test.ts",
    what: "중복 playerId 데드볼 — 대조군 대비 관계식, 다시드",
    issue: "#231",
    seconds: 16,
  },
  {
    file: "packages/engine/dev-viewer/generate-demo.test.ts",
    what: "쇼케이스 데모 로그 재생성. 매 커밋에 다시 만들 이유가 없다(뷰어 산출물).",
    issue: "#377 M0-3",
    seconds: 19,
  },
  {
    file: "tools/qa-console/cli.test.ts",
    what: "QA 콘솔 CLI — 하위 프로세스를 다수 spawn 해 대기가 길다(실측 66s). 엔진 위험이 아니다.",
    issue: "#191",
    seconds: 66,
  },
];

/** 파일 안에서 `atLeastTier()` 로 일부 블록만 게이트하는 스위트(고아 검출 대상). */
export const PARTIAL_GATED: (TierEntry & { minTier: number })[] = [
  {
    file: "packages/engine/src/realism/real-deck-smoke.test.ts",
    minTier: 1,
    what:
      "실덱 10덱 × 다시드 전량 스캔(슛 붕괴 판정). T0 에는 붕괴 케이스 1경기가 남지만 " +
      "그 사정거리는 **하프 사망 검출**까지다 — 슛 붕괴는 T1 에만 있다(파일 상단 주석 참조).",
    issue: "#374 / #376",
    seconds: 25,
  },
  {
    file: "packages/engine/src/determinism.test.ts",
    minTier: 1,
    what: "desync 반복 80회. T0 은 축약 반복으로 같은 성질을 확인한다 — 결정론은 어느 티어에도 면제가 없다.",
    issue: "#377 M0-3",
    seconds: 22,
  },
];

/** T0 에서 include 에서 빼야 하는 경로들(`vitest.config.ts` 가 소비). */
export function t0ExcludedFiles(): string[] {
  return T0_EXCLUDED.map((e) => e.file);
}
