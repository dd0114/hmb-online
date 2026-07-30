/**
 * 게임 탭의 **순수 로직** (#286 W2).
 *
 * 화면이 문장을 조립하지 않게 여기로 뺐다 — 서버 값이 없을 때 무엇을 그리지 *않을지*가
 * 규칙이고, 그건 테스트로 잡아야 한다(#262 BL-1: 클라가 추측한 순간 화면이 거짓말을 한다).
 */
import { ApiError } from "../api/client";
import type { LeagueResponse } from "../api/v2";

export interface LeagueHint {
  /** 디비전 이름(서버 값) 또는 규칙 문구 폴백. */
  label: string;
  /** "10 / 18 라운드" — 서버가 라운드를 주지 않으면 **null**(줄을 그리지 않는다). */
  round: string | null;
}

type Season = NonNullable<LeagueResponse["season"]> | null | undefined;

/**
 * 리그 카드의 부제.
 *
 * ⚠️ **`currentRound`/`totalRounds` 는 서버가 아직 발행하지 않는다** — 실사(2026-07-31):
 * `server-java` grep 0건 · `openapi-v2.yaml` 0건. 즉 이 카드의 `N / 18 라운드` 줄은 W2 이후
 * **한 번도 라이브에 뜬 적이 없다**(독립검증 #286 MAJ-1 이 리그 진행바에서 같은 갭을 잡았다).
 * 발행 요청은 #319 에 있다. 지금 동작(없으면 줄을 안 그린다)은 그대로 옳다.
 *
 * ⚠️ 디비전 이름을 `level` 로 만들지 않는다. 라운드도 일정표를 세어 추정하지 않는다 —
 * 서버가 `currentRound`/`totalRounds` 를 줄 때만 그린다. 둘 다 없으면 규칙 문구로 떨어진다
 * (구 서버에서도 화면이 깨지지 않게).
 */
export function leagueModeHint(divisionName: string | null, season: Season): LeagueHint {
  const s = season as { divisionName?: unknown; currentRound?: unknown; totalRounds?: unknown } | null | undefined;

  // 헤더와 같은 우선순위: 시즌이 있으면 **그 시즌에 박제된** 값이 먼저다(#268 —
  // 시즌 종료 후 승급하면 users.division 은 이미 다음 값이라 둘이 어긋난다).
  const name =
    (typeof s?.divisionName === "string" && s.divisionName) || divisionName || null;

  const cur = typeof s?.currentRound === "number" ? s.currentRound : null;
  const total = typeof s?.totalRounds === "number" ? s.totalRounds : null;

  return {
    label: name ?? "10팀 18라운드",
    round: cur !== null && total !== null ? `${cur} / ${total} 라운드` : null,
  };
}

/** 연습 경기 생성 실패 문구. 409(이어가기)는 호출부가 먼저 처리하므로 여기 오지 않는다. */
export function practiceError(err: ApiError | Error): string {
  if (err instanceof ApiError && err.code === "DECK_INVALID") {
    return `덱이 유효하지 않습니다 — ${err.message}`;
  }
  return err instanceof Error ? err.message : "매치 생성에 실패했습니다";
}
