/**
 * 매치 잠금·재입장의 **순수 규칙** (#217). 화면(MatchLockGate·LobbyPage)은 이 함수들을 부르기만
 * 하고, 판정은 전부 여기에서 테스트된다.
 *
 * <p>서버가 이미 `locked`/`abandonable` 을 계산해 내려준다({@code GET /api/me/active-match}) —
 * 여기 있는 건 그 두 불리언을 **화면 동작**(강제 이동할까 / 로비에 카드만 띄울까)으로 옮기는 층이지,
 * 상태 집합을 클라가 다시 정의하는 게 아니다. 규칙을 복제하면 서버가 바뀔 때 조용히 어긋난다.
 */

export interface ActiveMatchInfo {
  match: { id: string; state: string } | null;
  locked: boolean;
  abandonable: boolean;
}

/**
 * 잠겨 있을 때 진입을 막는 메타 화면들. 경기 중에는 "경기를 보라"가 hero 요구다.
 *
 * <p>`/match/:id` 와 `/login` 은 당연히 빠지고, dev 전용 하니스(`/design/*`·`/qa/*`)도 뺀다 —
 * 제품 화면이 아니라 리뷰 도구라 잠글 대상이 아니다.
 *
 * <p>⚠️ **`/home` 도 포함이다**(#286 W2). 처음엔 "홈은 탈출구니까 빼자"고 했는데 그건 오독이었다 —
 * 이 게이트는 {@code locked && !abandonable} 일 때만 되돌리므로, <b>회수 가능한 사고 매치에서는
 * 홈이 그대로 열린다</b>(포기 버튼도 거기 있다). 홈을 빼면 되레 재생 중(#217 AC1 "어디로 가든
 * 경기로 돌아온다")에 홈에 눌러앉을 수 있게 된다 — 계약이 그걸 잡았다.
 * 홈에서 <b>타일을 못 누르게</b> 하는 건 또 다른 층이다(`nav-lock.ts` 주석 참조).
 *
 * <p>⚠️ 라우트를 추가하면 이 상수 · `App.tsx` 의 손 래핑 · `e2e/p4-match-lock.spec.ts` 의
 * 전수 루프를 <b>셋 다</b> 갱신해라(apps/web/CLAUDE.md #217 절) — 상수만 고치면 유닛 테스트는
 * green 인 채로 구멍이 남는다.
 */
export const LOCKED_ROUTES = [
  "/home",
  "/game",
  "/deck",
  "/players",
  "/recruit",
  "/me",
  "/league",
  "/away",
] as const;

/**
 * 지금 이 유저를 진행 중 매치로 **강제 이동**시켜야 하는가.
 *
 * <p>`locked` 만으로 결정하지 않는 게 핵심이다: 회수 가능한 매치(=시계가 멈췄거나 생성이 실패한
 * 사고 상태)까지 붙잡아 두면 <b>탈출구인 포기 버튼이 있는 로비에 영영 못 간다</b> — AC3 이 금지하는
 * 영구 잠금이 리다이렉트로 재현된다. 그래서 "잠겼고 && 아직 포기할 수 없다"일 때만 끌고 간다.
 */
export function shouldForceResume(active: ActiveMatchInfo | undefined | null): boolean {
  if (!active?.match) return false;
  return active.locked && !active.abandonable;
}

/** 진행 중 매치의 경로. 없으면 null. */
export function resumePathFor(active: ActiveMatchInfo | undefined | null): string | null {
  return active?.match ? `/match/${active.match.id}` : null;
}

/** 로비에 "이어하기" 카드를 띄울 조건 = 강제 이동은 아니지만 끝나지 않은 매치가 있다. */
export function shouldOfferResume(active: ActiveMatchInfo | undefined | null): boolean {
  return Boolean(active?.match) && !shouldForceResume(active);
}

/**
 * 서버 409 `MATCH_IN_PROGRESS` 에서 이어갈 매치 id 를 뽑는다. 빈 손 에러 문구만 띄우면 유저는
 * 막다른 길에 선다 — 이 id 가 곧 탈출 경로다.
 */
export function matchInProgressIdOf(err: unknown): string | null {
  const e = err as { code?: unknown; detail?: unknown } | null;
  if (!e || e.code !== "MATCH_IN_PROGRESS") return null;
  const detail = e.detail as { matchId?: unknown } | null | undefined;
  return typeof detail?.matchId === "string" ? detail.matchId : null;
}

/** 상태 → 이어하기 카드에 쓸 한 줄. 알 수 없는 상태도 카드가 사라지지 않게 폴백을 준다. */
export function resumeLabelFor(state: string | undefined): string {
  switch (state) {
    case "BRIEFING":
      return "경기 전 브리핑에서 멈춰 있습니다";
    case "GEN1":
      return "전반 작전을 생성하는 중입니다";
    case "GEN2":
      return "후반 작전을 생성하는 중입니다";
    case "FIRST_HALF":
      return "전반이 진행 중입니다";
    case "HALFTIME":
    case "H1_BREAK":
      return "감독시간입니다";
    case "SECOND_HALF":
      return "후반이 진행 중입니다";
    case "FAILED":
      return "작전 생성에 실패했습니다 — 재시도하거나 포기할 수 있습니다";
    default:
      return "진행 중인 경기가 있습니다";
  }
}
