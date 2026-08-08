import { type Page } from "@playwright/test";

/**
 * 매치 플로우 브릿지(#424)를 지나간다.
 *
 * 종료·하프 전환에서 `flow-bridge-overlay` 가 화면을 덮고 다음 CTA 를 요구한다. 유저는 그걸 한 번
 * 누르고 지나가지만, 브릿지보다 먼저 쓰인 스펙들은 그 걸음을 모른다 — 그래서 그 아래 버튼을 누르려다
 * `subtree intercepts pointer events` 로 죽는다(실측: `to-lobby` 가 그렇게 300초를 태웠다).
 *
 * ⚠️ 계약을 느슨하게 하는 함수가 아니다 — **유저가 실제로 지나는 한 걸음을 테스트도 지나게** 할 뿐이고,
 * 단언은 호출부에 그대로 남는다(`p406-player-highlight.spec.ts:325` 가 같은 결론을 먼저 적어 뒀다).
 * 브릿지는 겹칠 수 있어(스택) 사라질 때까지 돈다.
 */
export async function passFlowBridge(page: Page, timeoutMs = 30_000): Promise<void> {
  // 브릿지는 **여러 비트**다 — 안내 오버레이 다음에 보상 카드가 또 화면을 덮는다(실측: 브릿지를
  // 넘기자 `match-reward-card` 가 같은 자리에서 `to-lobby` 를 가로챘다). 그래서 "덮는 것이 없어질
  // 때까지" 돈다. 무엇을 눌러야 하는지는 비트마다 다르므로 **보이는 것을 순서대로** 누른다.
  const blockers = ["flow-bridge-overlay", "match-reward-card"];
  const ctas = ["flow-bridge-next", "match-reward-card", "flow-bridge-overlay"];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let blocked = false;
    for (const id of blockers) if ((await page.getByTestId(id).count()) > 0) blocked = true;
    if (!blocked) return;
    for (const id of ctas) {
      const el = page.getByTestId(id);
      if ((await el.count()) > 0) {
        await el.first().click({ timeout: 3_000 }).catch(() => {});
        break;
      }
    }
    await page.waitForTimeout(250);
  }
}
