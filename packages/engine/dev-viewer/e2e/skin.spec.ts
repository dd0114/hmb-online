import { test, expect } from "@playwright/test";
import { loadViewer } from "./fixture";

// #169 S3: QA 뷰어 캐릭터 스킨 토글 — 기본 off(엔진 디버그=단색 원), 켜면 게임화면과 같은 얼굴 스킨.
// 스킨 페이로드(window.__SKIN__)는 build-test-viewer 가 임베드(apps/web/public/chars 에셋). 코어의
// setSkin(#145, web p3-char-skin 가 렌더 픽셀 검증) 을 셸 토글이 부른다 — 여기선 토글 계약을 박제한다.
test.beforeEach(async ({ page }) => { await loadViewer(page); });

test("스킨 토글 버튼이 노출되고 기본은 off(단색 원)", async ({ page }) => {
  await expect(page.locator("#skinBtn")).toBeVisible();
  // 기본 off: active 아님 + skin 미적용.
  expect(await page.locator("#skinBtn").evaluate((el) => el.classList.contains("active"))).toBe(false);
  expect(await page.evaluate(() => (window as any).__viewer.skinReady())).toBe(false);
});

test("토글 on → 스킨 적용(skinReady) + 렌더 픽셀이 실제로 달라진다", async ({ page }) => {
  // off 상태 한 프레임.
  const off = await page.evaluate(() => {
    const v = (window as any).__viewer;
    v.autoPace(false); v.setViewMode("fix"); v.seek(900);
    return (document.getElementById("pitch") as HTMLCanvasElement).toDataURL();
  });
  // 토글 on → 아틀라스 로드 대기 → 같은 틱 렌더.
  await page.click("#skinBtn");
  await page.waitForFunction(() => (window as any).__viewer.skinReady() === true, null, { timeout: 20_000 });
  expect(await page.locator("#skinBtn").evaluate((el) => el.classList.contains("active"))).toBe(true);
  const on = await page.evaluate(() => {
    const v = (window as any).__viewer;
    v.seek(900);
    return (document.getElementById("pitch") as HTMLCanvasElement).toDataURL();
  });
  expect(on.length, "스킨 렌더가 비어있지 않다").toBeGreaterThan(1000);
  expect(on, "스킨 on/off 렌더가 달라야 한다 — 같으면 얼굴이 안 그려진 것").not.toBe(off);

  // 다시 off → 스킨 해제.
  await page.click("#skinBtn");
  await expect.poll(() => page.evaluate(() => (window as any).__viewer.skinReady())).toBe(false);
});
