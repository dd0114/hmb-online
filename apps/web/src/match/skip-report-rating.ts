/**
 * 하프 리포트의 **평점 어댑터** — #421 이 소유하는 격리막 1파일 (W2).
 *
 * ⚠️ **평점 산식의 SoT 는 #403 의 `apps/web/src/match/player-stats.ts` 다. 여기에 다시 만들지
 * 않는다(#57 재발명 금지).** 그 모듈은 입력 단위가 곧 하프라(`computePlayerStats(halfLog).motm`)
 * "전반전 가장 평점 좋은 인물"이 한 줄로 나오고, `findPlayerStat` 이 골·어시·선방·키패스·태클·
 * 패스%·뛴거리까지 같이 준다 — #421 이 필요한 건 그걸 **부르는 것**뿐이다.
 *
 * 🔴 **그 파일은 아직 main 에 없다**(로컬 브랜치 `epic403-player-stats` @ `f219392`, main 이 별도
 * 승격 중). 그렇다고 이 브랜치로 **복사하면 안 된다** — 계수가 hero 확정 대기라 두 벌이 갈리고,
 * 갈린 뒤엔 어느 쪽이 진짜 평점인지 화면이 답할 수 없다.
 *
 * 그래서 지금은 **명시적 스텁**(항상 `null`)이고, 머지되면 **이 파일 안 한 곳**만 바뀐다:
 *
 * ```ts
 * import { computePlayerStats, findPlayerStat } from "./player-stats";
 * // …
 * const r = computePlayerStats(halfLog, {});
 * const motm = opts.team ? teamMotmOf(r, opts.team) : r.motm;   // 아래 ② 참조
 * return motm ? { team: motm.team, playerId: motm.playerId, rating: motm.rating, line: findPlayerStat(r, motm.team, motm.playerId) } : null;
 * ```
 *
 * **시그니처는 그때 바뀌지 않는다** — 소비자(`HalfReportModal`)는 오늘 쓰는 그대로 둔다.
 *
 * ── ② 우리 팀 최고인가, 양 팀 통합인가 ────────────────────────────────────────────────
 * `#403` 의 `motm` 은 **양 팀 통합 1명**이다. #421 리포트는 유저가 **자기 팀 서사**를 읽는
 * 화면이라 우리 팀 최고가 자연스럽다 → `opts.team` 으로 **소비자가 고른다**(모듈 수정 불요).
 * 현재 소비자 기본값 = **우리 팀**(`myTeamSide` 를 아는 경우), 사이드를 모르면 필터 없이
 * 양 팀 통합으로 떨어진다(거짓 소속을 지어내지 않는다).
 *
 * ── ③ UI 는 `null` 을 견뎌야 한다 ──────────────────────────────────────────────────────
 * 스텁 기간 내내 `null` 이므로, 평점 카드가 없으면 스택이 **1장(타임라인)** 으로 줄고 페이저·도트가
 * 그에 맞게 사라진다. 그 성질은 `HalfReportModal.test.ts` 가 계약으로 박는다 — 모듈이 머지되기
 * 전에도 **스킵 플로우 전체가 안 깨지는 것**이 이 격리막의 목적이다.
 */

/**
 * 하프 최고 평점 인물.
 *
 * `line` 은 #403 의 `PlayerStatLine`(골·어시·선방·키패스·태클·패스%·뛴거리)이 들어올 자리다.
 * 그 타입을 지금 흉내 내 적으면 그게 곧 두 번째 SoT 가 되므로 **`unknown`** 으로 둔다 —
 * 머지되는 날 `import type { PlayerStatLine }` 한 줄로 좁힌다.
 */
export interface TopRated {
  team: string;
  playerId: string;
  rating: number;
  line: unknown;
}

export interface TopRatedOptions {
  /** 이 팀에서만 고른다("home"|"away"). 생략하면 양 팀 통합(= #403 `motm` 원형). */
  team?: string;
}

/**
 * 하프 로그 → 그 하프 최고 평점 인물. **지금은 항상 `null`**(위 스텁 설명).
 *
 * 반환이 `null` 이라고 화면이 깨지면 안 된다 — 그게 이 함수의 두 번째 계약이다.
 */
export function topRatedOfHalf(halfLog: unknown, opts: TopRatedOptions = {}): TopRated | null {
  // TODO(#403): `player-stats.ts` 가 main 에 오면 위 주석의 세 줄로 교체한다(시그니처 무변경).
  void halfLog;
  void opts;
  return null;
}
