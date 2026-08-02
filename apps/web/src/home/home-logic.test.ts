import { describe, expect, it } from "vitest";
import { homeNotice } from "./home-logic";

/**
 * 홈 알림 한 줄 — **유닛 계약**.
 *
 * ⚠️ 이 파일은 `homeNotice` 만 본다. `HOME_TILES`(순서까지 hero 지정)의 계약은
 * `e2e/p286-home-nav.spec.ts` 가 DOM 순서로 지키고 있으므로 여기서 중복해 박지 않는다.
 */
describe("homeNotice — 받을 미션 보상 (#408)", () => {
  const base = { unseenAwayReports: 0, openTrades: 0 };

  it("셀 게 없으면 **null** — 빈 줄이 남으면 '고장'으로 읽힌다", () => {
    expect(homeNotice(base)).toBeNull();
    expect(homeNotice({ ...base, claimableMissions: 0 })).toBeNull();
  });

  it("받을 보상만 있으면 그것만 말하고 **원정 화면**으로 보낸다(받는 자리가 거기다)", () => {
    const n = homeNotice({ ...base, claimableMissions: 2 });
    expect(n?.count).toBe(2);
    expect(n?.text).toContain("받을 보상 2건");
    expect(n?.to).toBe("/away");
  });

  it("피침공이 있으면 그쪽이 우선이다 — 시간이 지나면 밀려나 사라지기 때문", () => {
    const n = homeNotice({ unseenAwayReports: 1, openTrades: 0, claimableMissions: 3 });
    expect(n?.count).toBe(4);
    expect(n?.to).toBe("/game");
    // 두 조각이 다 보인다 — 하나가 다른 하나를 덮으면 유저가 할 일을 놓친다.
    expect(n?.text).toContain("원정 피침공 1건");
    expect(n?.text).toContain("받을 보상 3건");
  });

  it("미션이 없으면 기존 동작 그대로 — 트레이드는 영입으로 간다(무회귀)", () => {
    const n = homeNotice({ unseenAwayReports: 0, openTrades: 2 });
    expect(n?.count).toBe(2);
    expect(n?.to).toBe("/recruit");
    expect(n?.text).not.toContain("받을 보상");
  });

  it("필드가 안 오면(구 서버·미도착) 미션 몫은 0 이다 — 화면이 숫자를 지어내지 않는다", () => {
    expect(homeNotice({ unseenAwayReports: 0, openTrades: 1 })?.count).toBe(1);
  });
});
