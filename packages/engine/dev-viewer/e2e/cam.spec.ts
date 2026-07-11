import { test, expect } from "@playwright/test";
import { loadViewer } from "./fixture";

// #45: 카메라 연속성 계약 — 하이라이트 줌인이 세트피스 와이드 직후 걸리는 급전환(save@145→corner@148
// →코너 후 슛 하이라이트)에서도 카메라가 '한 번 튀는' 점프 없이 속도 상한 내로 글라이드해야 한다.
// 수정 전 실측: t153 에서 93.9px/frame 스텝(줌 방향 반전 3회). CAM_MAX_PAN_PXPS 클램프로 해소.
test("하이라이트×코너 겹침: 단일 rAF 프레임 카메라 스텝 ≤ 80px (#45)", async ({ page }) => {
  test.setTimeout(60000);
  await loadViewer(page);
  const steps: number[] = await page.evaluate(async () => {
    const v = (window as any).__viewer;
    v.autoPace(true);
    v.seek(138);
    const g = v.screenGeom();
    const BASE = Math.min((g.cw - 60) / 105, (g.ch - 60) / 68);
    const rec: { wt: number; cx: number; cy: number; zoom: number }[] = [];
    v.play();
    await new Promise<void>((res) => {
      (function loop() {
        const c = v.cam();
        rec.push({ wt: performance.now(), cx: c.cx, cy: c.cy, zoom: c.zoom });
        if (v.cur().tick >= 158) { v.pause(); res(); } else requestAnimationFrame(loop);
      })();
    });
    const out: number[] = [];
    for (let i = 1; i < rec.length; i++) {
      const a = rec[i - 1], b = rec[i];
      const dt = b.wt - a.wt;
      if (dt <= 0 || dt > 100) continue; // 정지/랙 프레임 제외
      // 60fps 프레임 기준으로 정규화(px/16.7ms) — CI 프레임레이트 편차에 견고.
      out.push(Math.hypot((b.cx - a.cx) * BASE * b.zoom, (b.cy - a.cy) * BASE * b.zoom) * (16.7 / dt));
    }
    return out;
  });
  expect(steps.length).toBeGreaterThan(100); // 실재생이 실제로 진행됐는지 새너티
  const max = Math.max(...steps);
  expect(max, `max cam step ${max.toFixed(1)}px/frame(60fps 정규화)`).toBeLessThanOrEqual(80);
});
