/**
 * 게임 탭의 **순수 로직** (#286 W2).
 *
 * 화면이 문장을 조립하지 않게 여기로 뺐다 — 서버 값이 없을 때 무엇을 그리지 *않을지*가
 * 규칙이고, 그건 테스트로 잡아야 한다(#262 BL-1: 클라가 추측한 순간 화면이 거짓말을 한다).
 */
import { ApiError } from "../api/client";
import type { LeagueResponse } from "../api/v2";
import type { AppConfig } from "../api/config";

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

/**
 * AI 모드 안내 (#471 AC3).
 *
 * hero 요구는 <b>"클로드 로그인 안되어있으면 게임시작할때 안내말만하고 스태틱 엔진으로 써있어야함"</b> 이다.
 * 여기서 지키는 규칙은 하나 — <b>모르면 아무 말도 하지 않는다</b>. 서버가 `ai` 를 안 주거나(구 서버)
 * `unknown`(실행기 신고 전·신고 만료)이면 null 이다. 그 창에서 배너를 띄우면 로그인해 둔 사용자에게
 * "스태틱 엔진입니다"라고 거짓말하게 된다 — 없는 문제를 있다고 말하는 쪽이 반대보다 나쁘다.
 *
 * 안내는 **막지 않는다**. 스텁 엔진으로도 경기는 끝까지 돌아가고(그게 로컬 빌드·E2E 의 기본 경로다),
 * 이 문구는 "왜 전술 프롬프트가 반영이 안 되지?" 를 설명해 주는 자리다.
 */
export function aiModeNotice(ai: AppConfig["ai"]): string | null {
  if (!ai || ai.mode !== "stub") return null;
  return "지금은 스태틱(스텁) 엔진으로 경기합니다 — 선수 프롬프트가 경기에 반영되지 않습니다. 라이브 AI 를 쓰려면 이 서버를 돌리는 머신에서 `claude` 로그인 후 다시 기동하세요.";
}
