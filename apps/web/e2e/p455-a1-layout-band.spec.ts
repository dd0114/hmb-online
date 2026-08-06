/**
 * #455 A1 — **레이아웃 축이 폭에 따라 갈리는 자리**의 계약(덱셋팅 `/deck`).
 *
 * ## 왜 이 파일이 따로 있나
 * `p455-a1-deck-fullscreen.spec.ts` 는 **폰 390×844 고정**이다(`test.use({viewport})` 는 파일
 * 단위라 그 안에서 폭을 훑을 수 없고, 그 파일의 자기전제 단언이 그것을 막는다). 그런데 A1 이
 * 만든 결함 둘은 **폰이 아닌 폭에서만** 났다:
 *
 * - **BL-1** — 팀 사기 위젯이 `teamExtra` 로만 넘어가 `tabs` 분기 안에서만 렌더됐다 →
 *   **데스크탑(stack)에서 위젯이 통째로 사라졌다**(1024·1280 실측 존재 0).
 * - **BL-2** — 폭 900~1023 에서 `.app-container` 가 720 으로 넓어지며 보드가 688×688 을 먹고,
 *   `overflow: hidden` 이라 문서 스크롤도 0 → **프롬프트·탭에 스크롤로도 못 닿았다**
 *   (패널 높이 실측 900×900 **0** · 1023×900 **0** · 1023×768 18 · 960×800 50).
 *
 * 둘 다 폰 계약 7건이 **전부 초록인 채로** 살아 있었다. 그래서 자를 폭 축으로 하나 더 세운다.
 *
 * ⚠️ 판정은 `toBeVisible()` 이 아니라 **`elementFromPoint` 히트**다 — 뷰포트 밖도 그건 통과한다
 *    (apps/web/CLAUDE.md "초록으로 거짓말하는 방식" ③).
 * ⚠️ 실행: 전체 e2e 금지(:8080 데모 충돌) — 이 스펙만 지정 + 빈 포트.
 *    `CI=1 WEB_E2E_PORT=5599 npx playwright test e2e/p455-a1-layout-band.spec.ts`
 */
import { expect, test, type Page } from "@playwright/test";
import { hitAt, openDeck } from "./deck-mock";

/** 이 파일은 폭을 직접 정한다 — 뷰포트를 파일 단위로 고정하지 않는다. */
test.use({ viewport: { width: 390, height: 844 } });

/** 지금 화면이 어느 레이아웃으로 서 있나 — 구현이 `.wrap` 에 다는 값 그대로. */
async function layoutOf(page: Page) {
  return page.evaluate(() => document.querySelector("[data-deck-layout]")?.getAttribute("data-deck-layout") ?? null);
}

/**
 * **팀 프롬프트에 실제로 닿는가** — 이 화면에 온 이유(#244)가 어느 폭에서도 도달 가능한지.
 * 탭 레이아웃이면 첫 화면 안에 있고, stack 이면 스크롤해서라도 닿아야 한다.
 * 그래서 `scrollIntoView` **뒤에** 히트를 잰다 — "스크롤하면 닿는다"까지가 합격이다.
 */
async function promptReachable(page: Page) {
  const input = page.getByTestId("editor-team-prompt");
  await input.scrollIntoViewIfNeeded();
  const box = await input.boundingBox();
  if (!box) return { hit: false, h: 0 };
  const hit = await hitAt(page, box.x + box.width / 2, box.y + box.height / 2, "editor-team-prompt");
  return { hit, h: Math.round(box.height) };
}

// ── ⑧ 어느 폭에서도 프롬프트에 닿는다 (BL-2) ─────────────────────────────────
/**
 * **레이아웃이 어느 쪽으로 서든 상관없다 — 닿기만 하면 된다.** 임계값을 이 계약에 적지 않는
 * 이유가 그것이다(`DECK_TABS_MAX_WIDTH` 를 import 하면 임계 변이가 통과한다 —
 * apps/web/CLAUDE.md "초록으로 거짓말하는 방식" ②). 임계를 옮기려면 옮겨도 되고,
 * **어느 폭에서도 프롬프트가 도달 가능하다**만 지키면 된다.
 *
 * ⚠️ 900·1023 은 BL-2 가 실제로 죽어 있던 폭이다. 900 은 `.app-container` 가 480 → 720 으로
 *    넓어지는 바로 그 지점이라 **경계 표본**으로 뺄 수 없다.
 */
const BAND = [
  { w: 390, h: 844, why: "폰 세로 — A1 의 확정 계약 대상" },
  { w: 480, h: 844, why: "컨테이너 상한과 같은 폭" },
  // 세로 820 = 짧은 창 양보(≤819 → 68/44)가 **안 걸리는 바로 위**. 비율만 걸려 있던 동안
  // 이 지점의 패널이 **64px** 였다(보드 448×448) — 탭 밴드 안쪽의 두 번째 세로 절벽.
  { w: 480, h: 820, why: "탭 밴드 안의 최악점(세로 예산 상한이 여기서 걸린다)" },
  { w: 899, h: 820, why: "밴드 위쪽 끝 × 최악 높이" },
  { w: 899, h: 900, why: "탭 밴드의 위쪽 끝(경계 표본)" },
  { w: 900, h: 900, why: "컨테이너가 720 으로 넓어지는 지점 — BL-2 가 났던 폭" },
  { w: 1023, h: 900, why: "구 임계 — BL-2 실측 패널 0px" },
  { w: 1023, h: 768, why: "짧은 창까지 겹친 자리(BL-2 실측 18px)" },
  { w: 960, h: 800, why: "BL-2 실측 50px" },
  { w: 1280, h: 900, why: "데스크탑 2컬럼" },
];

for (const c of BAND) {
  test(`⑧ ${c.w}×${c.h} — 팀 프롬프트에 닿는다 (${c.why})`, async ({ page }) => {
    await page.setViewportSize({ width: c.w, height: c.h });
    await openDeck(page, "높은 라인으로 압박해라");
    const layout = await layoutOf(page);
    expect(layout, "레이아웃 축이 화면에 선언돼 있어야 잴 수 있다").not.toBeNull();

    const { hit, h } = await promptReachable(page);
    expect(h, `입력칸 높이 ${h}px (layout=${layout})`).toBeGreaterThanOrEqual(48);
    expect(hit, `입력칸 한가운데가 화면에 있다 — ${c.w}×${c.h} layout=${layout}`).toBe(true);

    // 탭으로 섰다면 **탭 패널이 쓸 만한 크기**여야 한다. BL-2 는 정확히 여기서 0 이었다.
    if (layout === "tabs") {
      const panelH = await page.evaluate(() =>
        Math.round(document.getElementById("deck-tabpanel-team")?.getBoundingClientRect().height ?? -1));
      expect(panelH, `[전체 지시] 패널 ${panelH}px — 탭으로 섰으면 세로를 받아야 한다`).toBeGreaterThanOrEqual(120);
    }
  });
}

// ── ⑨ 팀 사기 위젯은 두 갈래 **모두** 있다 (BL-1) ───────────────────────────
/**
 * A1 초판이 이 위젯을 `teamExtra` 하나로 옮겼는데, `DeckEditor` 는 그 노드를 `tabs` 분기
 * 안에서만 렌더한다 → stack(데스크탑)에서 **존재 0**. `p286-home-nav.spec.ts` 가 이미 red 였는데
 * 그 스펙이 그 배치의 게이트에 없었다.
 *
 * ⚠️ **양쪽을 한 테스트에서 재라.** 한쪽만 재면 "옮겼다"와 "잃었다"가 구분되지 않는다 —
 *    이 결함의 모양이 정확히 그것이었다(폰에서는 있었고 데스크탑에서만 없었다).
 * ⚠️ 폰(tabs)에서는 [세부 전술] 탭 안이라 기본 상태에선 `hidden` 이다 — **존재**를 재고,
 *    탭을 연 뒤 **보이는지**까지 잰다(존재만 재면 아무 데나 숨겨 둔 것도 통과한다).
 */
test("⑨ 팀 사기 위젯이 stack·tabs 두 갈래 모두에서 화면에 있다", async ({ page }) => {
  // ⓐ 데스크탑(stack) — 에디터 아래 형제 자리
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDeck(page);
  expect(await layoutOf(page), "1280 은 stack 이다").toBe("stack");
  const desktop = page.getByTestId("team-morale");
  await expect(desktop, "데스크탑에서 팀 사기 위젯이 사라지면 안 된다").toHaveCount(1);
  // ⚠️ 순서가 계약의 일부다 — 스크롤 **뒤에** 좌표를 잡는다(먼저 잡으면 낡은 좌표를 찍는다).
  await desktop.scrollIntoViewIfNeeded();
  const dbox = (await desktop.boundingBox())!;
  const dhit = await hitAt(page, dbox.x + 8, dbox.y + dbox.height / 2, "team-morale");
  expect(dhit, "데스크탑에서 실제로 화면에 있다").toBe(true);

  // ⓑ 폰(tabs) — [⚙ 세부 전술] 탭 꼬리
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);
  expect(await layoutOf(page), "390 은 tabs 다").toBe("tabs");
  await expect(page.getByTestId("team-morale"), "폰에서도 존재한다").toHaveCount(1);
  await page.getByTestId("deck-tab-tune").click();
  await expect(page.getByTestId("team-morale"), "[세부 전술] 탭을 열면 보인다").toBeVisible();
});
