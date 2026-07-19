import { expect, test, type Page } from "@playwright/test";

/**
 * 실터치 회귀 계약 — "폰에서 선수 리스트→보드 드래그가 안 된다"(hero 제보, 독립 QA 근본원인 확정).
 *
 * 왜 별도 스펙인가:
 *   deck-list-dnd.spec.ts 는 390x2200(실재하지 않는 세로 뷰포트) + page.mouse.* 라서
 *   브라우저 네이티브 터치 스크롤이 개입할 여지가 없다. 실제 폰은 **터치 입력**으로 리스트
 *   (.list = max-height:260px / overflow-y:auto 내부 스크롤 컨테이너) 위를 누른다.
 *
 * 근본원인(실측):
 *   PointerSensor(distance:6)는 터치에서도 pointerdown 을 먼저 잡아 TouchSensor 의 delay(롱프레스)
 *   활성화를 영영 막았고, 거리 기반이라 손가락이 6px 움직이는 순간 브라우저가 리스트 네이티브
 *   스크롤을 시작 → pointercancel 로 드래그가 죽었다. 그래서 폰에서 드래그 100% 실패.
 *   ⚠️ 행에 `touch-action: none` 만 거는 "쉬운" 수정은 드래그를 살리는 대신 **리스트 터치 스크롤을
 *   죽인다**(실측 scrollTop 0). 그래서 채택한 해법 = MouseSensor/TouchSensor 분리(DeckEditor) +
 *   행 `touch-action: manipulation`(PlayerPicker.module.css) → 짧은 스와이프=스크롤, 롱프레스=드래그.
 *
 * 이 스펙은 그 두 제스처를 **둘 다** 박제한다(한쪽만 고치는 회귀를 잡기 위해):
 *   - hasTouch 컨텍스트 + **실제 터치 이벤트**(CDP Input.dispatchTouchEvent — Playwright 의
 *     page.touchscreen 은 tap 만 지원해 드래그/스와이프 시퀀스를 만들 수 없다).
 *   - 뷰포트 390x844(실제 폰 크기) + 리스트가 실제로 내부 스크롤을 갖는 선수 수.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

function attrs(overall: number) {
  return {
    technical: overall, mental: overall, physical: overall, passing: overall, shooting: overall,
    tackling: overall, pace: overall, stamina: overall, positioning: overall,
  };
}

const P = (id: string, name: string, position: string, grade: string, overall: number) => ({
  id, name, position, grade, owned: true, ownedCount: 1, attributes: attrs(overall), personality: "CALM",
});

/** 리스트가 내부 스크롤(overflow-y:auto)을 실제로 갖도록 충분히 많은 보유 선수. */
const PLAYERS = [
  P("FW_TOP", "탑공격수", "FW", "LEGEND", 92),
  P("MF_TOP", "탑미드", "MF", "DIA", 88),
  P("DF_HI", "강수비", "DF", "GOLD", 78),
  P("MF_A", "미드A", "MF", "GOLD", 72),
  P("FW_MID", "중공격", "FW", "SILVER", 70),
  P("MF_B", "미드B", "MF", "SILVER", 69),
  P("DF_MID", "중수비", "DF", "SILVER", 66),
  P("MF_MID", "미드미드", "MF", "SILVER", 65),
  P("DF_B", "수비B", "DF", "SILVER", 63),
  P("GK2", "골리2", "GK", "SILVER", 60),
  P("FW_LOW", "약공격", "FW", "BRONZE", 58),
  P("GK1", "골리1", "GK", "SILVER", 55),
  P("MF_LOW", "약미드", "MF", "BRONZE", 50),
  P("DF_LOW", "약수비", "DF", "BRONZE", 48),
];

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** Stateful /api mock (deck-list-dnd.spec.ts 와 동일 패턴). */
async function mockApi(page: Page) {
  const state = { deck: { formation: "4-4-2", slots: [] as unknown[] } };
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/presets", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 60, streak: 0, players: [] })),
  );
  await page.route((url) => url.pathname === "/api/deck", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      state.deck = { formation: body.formation, slots: body.slots };
    }
    return route.fulfill(json(state.deck));
  });
  await page.route((url) => url.pathname === "/api/presets/team", (route) =>
    route.fulfill(json([{ slot: 1, name: null, snapshot: null }, { slot: 2, name: null, snapshot: null }, { slot: 3, name: null, snapshot: null }])),
  );
}

interface Box { x: number; y: number; width: number; height: number }
const center = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

const touchPoints = (x: number, y: number) => [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }];

/**
 * 롱프레스 후 드래그(= 폰에서 배치하는 제스처). Playwright touchscreen 은 tap 뿐이라
 * CDP 로 raw 터치 시퀀스를 쏜다: touchStart → **무이동 홀드 300ms**(TouchSensor delay:150 충족,
 * tolerance:8 이내) → 목표까지 이동 → touchEnd.
 */
async function longPressDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touchPoints(from.x, from.y) });
  await page.waitForTimeout(300); // hold past the 150ms activation delay, no movement
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touchPoints(x, y) });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(60);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** 홀드 없는 빠른 세로 스와이프(= 리스트를 넘겨보는 제스처). 끝난 뒤 .list 의 scrollTop 반환. */
async function quickSwipe(page: Page, x: number, y: number, dy: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touchPoints(x, y) });
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touchPoints(x, y + (dy * i) / 10) });
    await page.waitForTimeout(12);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400); // let momentum scrolling settle
  await cdp.detach();
  return page.evaluate(() => (document.querySelector("ul") as HTMLElement).scrollTop);
}

test("실폰(390x844, 터치): 짧은 스와이프=리스트 스크롤 / 롱프레스 드래그=보드 배치 (둘 다 산다)", async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
  await expect(page.getByTestId("starter-count")).toHaveText(/0\/11/);

  // 실사용 동선: 리스트가 화면 하단에 들어오고 보드 하단 슬롯이 아직 보이는 위치까지 스크롤.
  // (폰에서 한 번의 드래그로 리스트→보드가 가능한 스크롤 구간.)
  const source = page.getByTestId("pick-FW_TOP");
  await page.evaluate(() => {
    const list = document.querySelector("ul")!;
    window.scrollBy(0, list.getBoundingClientRect().top - (window.innerHeight - 220));
  });
  await page.waitForTimeout(200);
  await expect(source).toBeInViewport();

  // 드래그 소스가 내부 스크롤 컨테이너(.list) 안에 있어야 이 회귀 계약이 유효하다
  // (스크롤 가능해야 브라우저가 터치를 스크롤로 선점한다).
  const listScrolls = await source.evaluate((el) => {
    const list = el.closest("ul")!;
    return list.scrollHeight > list.clientHeight + 1;
  });
  expect(listScrolls, "리스트가 내부 스크롤 컨테이너여야 이 회귀 계약이 유효하다").toBe(true);

  // 뷰포트 안에 실제로 닿을 수 있는 빈 선발 슬롯을 타깃으로.
  const target = await page.evaluate(() => {
    const slots = Array.from(document.querySelectorAll('[data-testid^="board-slot-starter-"]'));
    for (const el of slots) {
      const r = el.getBoundingClientRect();
      if (r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0) {
        return { testId: el.getAttribute("data-testid")!, x: r.x, y: r.y, width: r.width, height: r.height };
      }
    }
    return null;
  });
  expect(target, "뷰포트 안에 도달 가능한 빈 선발 슬롯이 있어야 한다").not.toBeNull();

  // (A) 짧은 스와이프는 **리스트 스크롤**로 남아야 한다 — 행이 리스트의 거의 전부(42px/행,
  // .list padding 0 / gap 0)라 행 위 스크롤이 죽으면 리스트를 넘길 수 없고, 그러면 탭-투-플레이스
  // (현재 1급 배치 경로)까지 사실상 마비된다. `touch-action: none` 이면 여기서 0 이 나온다.
  const rowBox = (await page.getByTestId("pick-MF_TOP").boundingBox())!;
  const scrolled = await quickSwipe(page, rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2, -100);
  console.log(`[touch] quick swipe on row → list scrollTop = ${scrolled}`);
  expect(scrolled, "행 위 짧은 스와이프로 리스트가 스크롤돼야 한다").toBeGreaterThan(0);
  // 스크롤 제스처가 실수로 배치를 일으키면 안 된다.
  await expect(page.getByTestId("starter-count")).toHaveText(/0\/11/);

  // (B) 롱프레스 드래그는 **배치**로 이어져야 한다. 리스트를 원위치로 되돌리고 다시 잡는다.
  await page.evaluate(() => { (document.querySelector("ul") as HTMLElement).scrollTop = 0; });
  await page.waitForTimeout(150);
  const srcBox = (await source.boundingBox())!;
  await longPressDrag(page, center(srcBox), center(target as Box));

  // 배치 성공 = 선발 카운트 증가 + 어떤 선발 슬롯에 토큰 + 리스트 항목 placed(중복 방지).
  // 정확히 어느 슬롯인지는 고정하지 않는다 — @dnd-kit closestCenter 는 드래그 rect(리스트 행은
  // 가로로 넓다) 중심 기준이라 놓은 지점 근처의 다른 선발 슬롯이 선택될 수 있다. 계약은 "터치
  // 드래그가 보드 배치로 이어진다"이다.
  await expect(page.getByTestId("starter-count")).toHaveText(/1\/11/);
  const token = page.getByTestId("token-FW_TOP");
  await expect(token).toBeVisible();
  await expect(token.locator('xpath=ancestor::*[starts-with(@data-testid,"board-slot-starter-")]')).toHaveCount(1);
  await expect(page.getByTestId("pick-FW_TOP")).toBeDisabled();
  await expect(page.getByTestId("pick-FW_TOP")).toContainText("선발");
});
