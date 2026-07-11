import { test, expect } from "@playwright/test";
import {
  loadViewer, eventsOfType, situationCaptions, tickerCards, VIEWER_REAL_URL,
} from "./fixture";

// 규칙 이벤트(파울/오프사이드/카드) 연출 계약.
// 파울은 showcase 로그에 있고, offside·card 는 이 시드에 없어 real config 뷰어로 검증.

test("foul → 파울 상황카드 + 후속 free_kick 이벤트 (PK 파울은 페널티 카드로 병합, #43)", async ({ page }) => {
  await loadViewer(page);
  const fouls = await eventsOfType(page, "foul");
  expect(fouls.length).toBeGreaterThan(0);
  const pens = new Set((await eventsOfType(page, "penalty")).map((e) => e.tick));
  // 같은 틱 이중 정지 병합(#43): PK 파울은 더 구체적인 '페널티킥!' 카드 하나만 뜬다.
  const plain = fouls.find((f) => !pens.has(f.tick));
  expect(plain, "PK 아닌 일반 파울이 로그에 있어야").toBeTruthy();
  // 파울 배너("파울→프리킥")는 같은 틱의 free_kick 배너로 즉시 덮이므로, 상황카드로 검증.
  expect((await situationCaptions(page, plain!.tick)).situation).toContain("파울");
  const pkFoul = fouls.find((f) => pens.has(f.tick));
  if (pkFoul) expect((await situationCaptions(page, pkFoul.tick)).situation).toContain("페널티");
  const fk = await eventsOfType(page, "free_kick", "foul");
  expect(fk.length).toBeGreaterThan(0);
});

test.describe("real config 뷰어(offside/card)", () => {
  test.beforeEach(async ({ page }) => { await loadViewer(page, VIEWER_REAL_URL); });

  test("offside → 오프사이드 상황카드 + free_kick:offside 이벤트", async ({ page }) => {
    const offs = await eventsOfType(page, "offside");
    expect(offs.length).toBeGreaterThan(0);
    // 오프사이드 배너도 같은 틱 free_kick 배너로 덮이므로 상황카드로 검증.
    expect((await situationCaptions(page, offs[0].tick)).situation).toContain("오프사이드");
    const fk = await eventsOfType(page, "free_kick", "offside");
    expect(fk.length).toBeGreaterThan(0);
  });

  test("card → 이벤트 티커에 카드(🟨/🟥) 항목이 렌더된다", async ({ page }) => {
    const cards = await eventsOfType(page, "card");
    expect(cards.length).toBeGreaterThan(0);
    const rendered = await tickerCards(page);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.join(" ")).toMatch(/레드|옐로/);
  });
});
