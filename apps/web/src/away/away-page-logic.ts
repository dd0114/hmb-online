/**
 * 원정 화면의 **순수 로직** (#286 W2).
 *
 * 에러 코드를 문장으로 옮기는 층. 화면에 흩어 두면 서버가 코드를 늘릴 때 어디를 고쳐야 하는지
 * 찾기 어렵고, 무엇보다 **"봇으로 몰래 대체하지 않는다"** 같은 결정이 코드에 안 남는다.
 */
import { ApiError } from "../api/client";

/**
 * 원정 시작 실패 문구. 409(이어가기)는 호출부가 먼저 처리하므로 여기 오지 않는다.
 *
 * ⚠️ `NO_OPPONENT` 를 "봇과 하시겠습니까"로 바꾸지 마라 — 그러면 "원정 = 실제 유저 팀"이
 * 거짓말이 된다(#245). 상대가 없으면 없다고 말한다.
 */
export function awayStartError(err: ApiError | Error): string {
  if (err instanceof ApiError) {
    if (err.code === "AWAY_DAILY_LIMIT") return err.message;
    if (err.code === "NO_OPPONENT") {
      return "아직 원정 갈 상대가 없습니다 — 다른 감독이 팀을 꾸리면 열립니다";
    }
    if (err.code === "DECK_INVALID") return `덱이 유효하지 않습니다 — ${err.message}`;
  }
  return err instanceof Error ? err.message : "원정을 시작하지 못했습니다";
}
