import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mockAppConfig } from "./app-config-mock";

/**
 * #247 실화면 캡처 — 강화 상세의 잠재 재설정 영역(구매 단계 제거 후) + 첫 1회 확인 다이얼로그.
 *
 * <p>계약이 아니라 <b>증빙</b>이다: 390px 실규격에서 두 버튼·가격칩·지갑 줄·확인 다이얼로그가
 * 겹치거나 잘리지 않는지를 사람이 눈으로 볼 수 있게 남긴다(좌표 추론 금지, 루트 §2-2).
 * 오버플로 0 단언은 여기서도 같이 건다 — 캡처만 남기고 통과하면 회귀를 못 잡는다.
 */
const OUT = new URL("../.smoke/", import.meta.url).pathname;
const OWNED_ID = "P001";
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const attrs = {
  technical: 44, mental: 41, physical: 40, passing: 42, shooting: 55,
  tackling: 30, pace: 60, stamina: 43, positioning: 45,
};
const caps = {
  technical: 70, mental: 68, physical: 65, passing: 69, shooting: 80,
  tackling: 55, pace: 82, stamina: 66, positioning: 71,
};

test("#247 캡처: 잠재 재설정 버튼 + 확인 다이얼로그 (390px)", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });

  await page.route((u) => u.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  await mockAppConfig(page);
  await page.route((u) => u.pathname === "/api/me", (r) =>
    r.fulfill(json({
      user: { id: "u1", nickname: "내 팀", tutorialDone: true },
      wallet: { points: 62000, gems: 6000 },
      records: { wins: 0, draws: 0, losses: 0 },
    })),
  );
  await page.route((u) => u.pathname === "/api/players", (r) =>
    r.fulfill(json([
      { id: OWNED_ID, name: "양민혁", position: "FW", grade: "GOLD", owned: true, ownedCount: 6, attributes: attrs },
    ])),
  );
  await page.route((u) => u.pathname === `/api/growth/card/${OWNED_ID}`, (r) =>
    r.fulfill(json({
      playerId: OWNED_ID, grade: "GOLD", star: 3,
      attributes: attrs, prePotential: attrs, base: attrs, caps,
      statLevels: Object.fromEntries(Object.keys(attrs).map((k) => [k, { lv: 1, xp: 20 }])),
      potential: {
        unlocked: true, tier: "EPIC", maxTier: "EPIC",
        lines: [
          { slot: 1, tier: "EPIC", type: "STAT_PCT", stat: "shooting", value: 9 },
          { slot: 2, tier: "EPIC", type: "STAT_FLAT", stat: "pace", value: 6 },
        ],
        rollsSinceTierUp: 3, ceilingAt: 25,
      },
      ovr: 61, completion: 0.42,
    })),
  );
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
    localStorage.setItem("hmb.tutorial.done", "1");
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/growth");
  await page.getByTestId(`codex-card-${OWNED_ID}`).getByRole("button").first().click();
  await expect(page.getByTestId("growth-detail")).toBeVisible();

  await page.getByTestId("growth-dice-normal").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}p247-roll-buttons.png` });

  // 첫 롤 → 확인 다이얼로그(가격 + 차감 후 잔액 + 다시 묻지 않기).
  await page.getByTestId("growth-dice-normal").click();
  await expect(page.getByTestId("growth-roll-confirm")).toBeVisible();
  await page.screenshot({ path: `${OUT}p247-roll-confirm.png` });

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`[#247] 390px overflow px = ${overflow}`);
  expect(overflow).toBeLessThanOrEqual(0);
});
