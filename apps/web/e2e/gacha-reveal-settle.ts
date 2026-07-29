import { expect, type Page } from "@playwright/test";

/**
 * 모두 공개 → **연출이 끝날 때까지** 기다린다.
 *
 * #250 이후 고레어(다이아↑)는 곧바로 뒤집히지 않는다 — 빛이 모인 뒤(레전드는 격상 구간 B까지)
 * 열린다. 클릭 직후에 카드를 단언하면 아직 **뒷면**이라 풀아트가 없다(실제로 `p3-card-art` 4건이
 * 그렇게 깨졌다). 확인 버튼은 모든 카드의 연출이 끝나야 나오므로 그게 "앞면이 전부 확정된" 신호다.
 *
 * ⚠️ 이 규약이 **한 곳**에 있어야 한다 — 처음엔 두 스펙에 같은 헬퍼를 복붙했는데, 그러면 정착 신호가
 * 바뀔 때 한쪽만 고쳐도 green 이라 조용히 갈라진다(2R 검증 m-1).
 */
export async function revealAllAndSettle(page: Page) {
  await page.getByTestId("gacha-reveal-all").click();
  await expect(page.getByTestId("gacha-close")).toBeVisible({ timeout: 20_000 });
}
