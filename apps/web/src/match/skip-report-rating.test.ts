/**
 * #421 W2 — 평점 어댑터의 **격리 계약**.
 *
 * 이 파일이 지키는 것은 "평점이 맞느냐"가 아니다(그건 #403 `player-stats.ts` 의 계약 88건 몫이다).
 * 여기서 박는 것은 **경계**다:
 *  ① 산식이 이 브랜치에 복사되지 않았다 — 스텁은 무엇을 먹여도 `null` 이다(#57 재발명 금지).
 *  ② 어떤 입력(빈 로그·손상 로그·null)에도 **던지지 않는다** — 리포트가 화면을 죽이면 안 된다.
 *  ③ 팀 필터는 **소비자가 고르는 옵션**이다(모듈 수정 없이 "우리 팀 최고"로 좁힌다).
 *
 * ⚠️ 이 스위트는 #403 이 머지되는 날 **바뀐다**. 그때 ①은 "null 만 준다"에서 "그 하프의 MOTM 을
 * 준다"로 좁혀지고, ②③은 그대로 남는다 — 그게 시그니처를 안 바꾼다는 약속의 증거다.
 */
import { describe, expect, it } from "vitest";
import { topRatedOfHalf } from "./skip-report-rating";

describe("topRatedOfHalf — #403 머지 전 스텁", () => {
  it("무엇을 먹여도 null 이다(산식이 여기 복사돼 있지 않다는 증거)", () => {
    expect(topRatedOfHalf(null)).toBeNull();
    expect(topRatedOfHalf({ events: [], tickSnapshots: [] })).toBeNull();
    expect(topRatedOfHalf({ events: [{ tick: 1, type: "goal", team: "home", playerId: "P1" }] })).toBeNull();
  });

  it("손상 입력에도 던지지 않는다", () => {
    expect(() => topRatedOfHalf(undefined)).not.toThrow();
    expect(() => topRatedOfHalf("not a log")).not.toThrow();
    expect(() => topRatedOfHalf({ events: null })).not.toThrow();
  });

  it("팀 필터 옵션을 받는다 — 소비자가 '우리 팀 최고'로 좁힐 수 있어야 한다", () => {
    expect(topRatedOfHalf({}, { team: "home" })).toBeNull();
    expect(topRatedOfHalf({}, { team: "away" })).toBeNull();
    // 옵션 생략 = 양 팀 통합(#403 `motm` 원형).
    expect(topRatedOfHalf({}, {})).toBeNull();
  });
});
