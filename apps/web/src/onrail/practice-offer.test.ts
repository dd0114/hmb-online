import { describe, expect, it } from "vitest";
import { OFFER_BEFORE_DECKLESS_GUARD, practiceOfferDecision } from "./practice-offer";

/**
 * #504 D1-A — 제안 판정의 **결정표**.
 *
 * 이 함수가 존재하는 이유는 판정이 화면마다 흩어져 있었기 때문이다(홈 타일에만 있고 나머지
 * 진입로는 평가조차 안 했다). 그래서 여기서 재는 것은 "if 가 잘 돌아간다"가 아니라 **세 입력
 * 조합이 서로 다른 결과로 갈리는가**다 — 특히 D3 스위치가 실제 레버인가.
 */
describe("practiceOfferDecision", () => {
  it("자격이 없으면 덱 상태와 무관하게 아무 일도 없다 (기존 유저 방해 0)", () => {
    expect(practiceOfferDecision({ eligible: false, deckMissing: false })).toBe("none");
    expect(practiceOfferDecision({ eligible: false, deckMissing: true })).toBe("none");
    // 스위치를 뒤집어도 자격 없는 유저에게는 아무것도 일어나지 않는다.
    expect(practiceOfferDecision({ eligible: false, deckMissing: true, offerFirst: true })).toBe("none");
  });

  it("자격이 있고 덱이 있으면 제안한다 — 이것이 이 웨이브가 되살린 경로다", () => {
    expect(practiceOfferDecision({ eligible: true, deckMissing: false })).toBe("offer");
  });

  it("D3 스위치가 실제 레버다 — 같은 입력이 값에 따라 갈린다", () => {
    const input = { eligible: true, deckMissing: true } as const;
    expect(practiceOfferDecision({ ...input, offerFirst: false })).toBe("deckless-first");
    expect(practiceOfferDecision({ ...input, offerFirst: true })).toBe("offer");
  });

  it("출하 기본값은 ②현행 유지 — 덱없음 가드가 제안보다 먼저다 (hero 미회신)", () => {
    // ⚠️ 이 단언이 red 가 되는 것은 **스위치를 뒤집었을 때**다. 그때는 뒤집은 것이 의도인지
    // (hero 회신 ①) 사고인지 여기서 한 번 걸린다 — 기본값이 조용히 바뀌는 것을 막는다.
    expect(OFFER_BEFORE_DECKLESS_GUARD).toBe(false);
    expect(practiceOfferDecision({ eligible: true, deckMissing: true })).toBe("deckless-first");
  });
});
