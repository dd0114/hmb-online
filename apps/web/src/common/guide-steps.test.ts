import { describe, expect, it } from "vitest";
import { SCREEN_GUIDES, guideForPath } from "./guide-steps";
import { TUTORIAL_STEPS, DECK_SETUP_STEPS } from "./tutorial-steps";

/**
 * #493 W2 — 화면별 가이드 정의의 구조 계약 (AC4 "분리 프로바이더"의 데이터 절반).
 *
 * ⚠️ 온보딩 배열(`TUTORIAL_STEPS`)에 스텝을 더하면 "n / total"·완료 저장(=덱 지급 트리거)
 * 계약이 깨진다(트레이드 코치마크 롤백 전례, hero Q7=A). 화면별 가이드는 **별도 배열**이고,
 * 이 파일은 두 시퀀스가 구조적으로 섞이지 않았음을 박제한다.
 */
describe("#493 guide-steps", () => {
  it("온보딩 시퀀스는 손대지 않았다 — 7 + 3 그대로", () => {
    expect(TUTORIAL_STEPS).toHaveLength(7);
    expect(DECK_SETUP_STEPS).toHaveLength(3);
  });

  it("가이드 스텝 id 는 온보딩·덱셋업 id 와 겹치지 않는다", () => {
    const onboarding = new Set([...TUTORIAL_STEPS, ...DECK_SETUP_STEPS].map((s) => s.id));
    for (const g of SCREEN_GUIDES) {
      for (const s of g.steps) {
        expect(onboarding.has(s.id), `가이드 스텝 id 가 온보딩과 충돌: ${s.id}`).toBe(false);
      }
    }
  });

  it("가이드는 온보딩이 소유한 화면(/home·/deck)을 덮지 않는다", () => {
    for (const g of SCREEN_GUIDES) {
      expect(["/home", "/deck"]).not.toContain(g.screen);
    }
  });

  it("화면 id 는 유일하고, 각 화면에 스텝이 1개 이상", () => {
    const screens = SCREEN_GUIDES.map((g) => g.screen);
    expect(new Set(screens).size).toBe(screens.length);
    for (const g of SCREEN_GUIDES) expect(g.steps.length).toBeGreaterThan(0);
  });

  it("모든 스텝은 data-testid 를 지목하고 제목·본문이 비어 있지 않다", () => {
    for (const g of SCREEN_GUIDES) {
      for (const s of g.steps) {
        expect(s.targetTestId.length).toBeGreaterThan(0);
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.body.length).toBeGreaterThan(0);
      }
    }
  });

  it("guideForPath — 정확 경로 매칭, 미정의 화면은 null", () => {
    expect(guideForPath("/game")?.screen).toBe("/game");
    expect(guideForPath("/home")).toBeNull();
    expect(guideForPath("/deck")).toBeNull();
    expect(guideForPath("/nope")).toBeNull();
  });
});
