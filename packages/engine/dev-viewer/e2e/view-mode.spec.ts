import { test, expect } from "@playwright/test";
import { loadViewer } from "./fixture";

// #114: Auto ↔ Fix 뷰 모드 계약.
//  - Fix = 한 화면 고정: 재생 중 카메라 zoom/center 불변(자동 팔로우/줌/하이라이트/데드볼·접촉 줌 억제).
//  - Fix 줌 컨트롤: setFixZoom 으로 고정 뷰 줌 레벨 변경(값 유지, 즉시 반영).
//  - Auto 복귀: 하이라이트 카메라(찬스/골 근처 자동 줌) 정상 동작.

test("Fix 모드: 재생 내내 카메라 zoom/center 불변 (#114)", async ({ page }) => {
  test.setTimeout(60000);
  await loadViewer(page);
  const res = await page.evaluate(async () => {
    const v = (window as any).__viewer;
    v.setViewMode("fix");
    v.setFixZoom(2); // 전체피치(1)보다 확대
    v.seek(120);
    const start = v.cam();
    const startTick = v.cur().tick;
    const rec: { cx: number; cy: number; zoom: number }[] = [];
    v.play();
    await new Promise<void>((r) => {
      (function loop() {
        const c = v.cam();
        rec.push({ cx: c.cx, cy: c.cy, zoom: c.zoom });
        if (v.cur().tick >= startTick + 20) { v.pause(); r(); } else requestAnimationFrame(loop);
      })();
    });
    return { start, rec };
  });
  expect(res.rec.length).toBeGreaterThan(20); // 실제로 여러 프레임 재생됨
  // 모든 프레임에서 zoom/center 가 setFixZoom(2)·피치중앙(52.5,34)으로 완전 고정.
  for (const c of res.rec) {
    expect(Math.abs(c.zoom - 2)).toBeLessThan(1e-6);
    expect(Math.abs(c.cx - 52.5)).toBeLessThan(1e-6);
    expect(Math.abs(c.cy - 34)).toBeLessThan(1e-6);
  }
});

test("Fix 모드: 줌 컨트롤 조작 시 고정 줌 변경·유지 (#114)", async ({ page }) => {
  await loadViewer(page);
  const zooms = await page.evaluate(() => {
    const v = (window as any).__viewer;
    v.setViewMode("fix");
    v.seek(100);
    v.setFixZoom(1); const z1 = v.cam().zoom;
    v.setFixZoom(2.5); const z2 = v.cam().zoom;
    // seek 해도(재생 위치 이동) 고정 줌 값이 유지되는지
    v.seek(140); const z3 = v.cam().zoom;
    return { z1, z2, z3 };
  });
  expect(Math.abs(zooms.z1 - 1)).toBeLessThan(1e-6);
  expect(Math.abs(zooms.z2 - 2.5)).toBeLessThan(1e-6);
  expect(Math.abs(zooms.z3 - 2.5)).toBeLessThan(1e-6); // 값 유지
});

test("Auto 복귀: 하이라이트 근처 자동 줌 정상 (#114)", async ({ page }) => {
  test.setTimeout(60000);
  await loadViewer(page);
  const maxZoom = await page.evaluate(async () => {
    const v = (window as any).__viewer;
    v.setViewMode("fix"); // 먼저 fix 였다가
    v.setViewMode("auto"); // auto 로 복귀
    v.autoPace(true);
    // 하이라이트 대상 틱(골) 하나를 이벤트에서 동적으로 골라 그 근처를 재생.
    const goal = v.events().find((e: any) => e.type === "goal");
    const keyTick = goal ? goal.tick : 100;
    v.seek(keyTick - 6); // 하이라이트 창(HL_PRE=8) 안쪽으로 진입
    let mz = 0;
    v.play();
    await new Promise<void>((r) => {
      (function loop() {
        mz = Math.max(mz, v.cam().zoom);
        if (v.cur().tick >= keyTick + 2) { v.pause(); r(); } else requestAnimationFrame(loop);
      })();
    });
    return mz;
  });
  // auto 하이라이트는 찬스/골 근처에서 FOLLOW_ZOOM(2.6)까지 줌인 → 전체뷰(1)보다 확실히 큼.
  expect(maxZoom, `auto max zoom ${maxZoom.toFixed(2)}`).toBeGreaterThan(1.5);
});
