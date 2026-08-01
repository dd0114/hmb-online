import { test, expect } from "@playwright/test";
import { loadViewer, eventsOfType, playUntilSituationContains, PITCH_W } from "./fixture";

/**
 * #347/#378 — 킥오프 계약 두 겹.
 *
 * ① **연출**: 킥오프에 "▶ KICK-OFF!" 한 호흡(자막 + freeze). 엔진이 그 틱에 전원을 자기 진영
 *    배치로 **순간이동**시키므로(Law 8), 신호가 없으면 관객에겐 그냥 점프한 프레임이다.
 *    (골킥 #230 과 같은 처방 — 그때도 "정지가 없어 왜 공이 저기 놓였는지 모른다"가 문제였다.)
 * ② **배치**: 그 틱의 렌더된 스냅샷에서 전원이 자기 진영 안. 엔진 계약(`kickoff-law8.test.ts`)이
 *    이미 좌표를 걸지만, 여기서는 **뷰어가 실제로 그리는 것**을 본다(§2-2 좌표 추론 금지).
 */

test.beforeEach(async ({ page }) => { await loadViewer(page); });

/** detail 없는 kickoff = 진짜 킥오프(코너/스로인/골킥은 detail 로 갈린다). */
async function realKickoffs(page: import("@playwright/test").Page) {
  const all = await eventsOfType(page, "kickoff");
  return all.filter((e) => !e.detail);
}

test("킥오프 → '▶ KICK-OFF!' 자막이 뜬다(한 호흡)", async ({ page }) => {
  const ks = await realKickoffs(page);
  expect(ks.length, "detail 없는 kickoff 이벤트가 있어야 한다(골 후·후반 시작)").toBeGreaterThan(0);
  const caps = await playUntilSituationContains(page, Math.max(0, ks[0].tick - 6), "KICK-OFF");
  expect(caps.situation).toContain("KICK-OFF");
});

test("킥오프 틱 → 전원이 자기 진영 안에 있다 (Law 8)", async ({ page }) => {
  const ks = await realKickoffs(page);
  expect(ks.length).toBeGreaterThan(0);
  for (const k of ks) {
    // `curPlayers()` = **뷰어가 실제로 그린** 선수 목록(보간 후). 좌표를 바깥에서 재구성하지 않는다.
    const bad = await page.evaluate((t) => {
      const v = (window as any).__viewer;
      v.seek(t);
      const ownerId = v.cur().ballOwner;
      const half = 105 / 2;
      return v
        .curPlayers()
        .filter((p: any) => p.id !== ownerId) // taker 는 센터 스팟(Law 8 예외)
        .filter((p: any) => (p.team === "home" ? p.x - half : half - p.x) > 0.05)
        .map((p: any) => `${p.team}:${p.id}@${p.x.toFixed(1)}`);
    }, k.tick);
    expect(bad, `t${k.tick} 상대 진영 침범: ${bad.join(", ")}`).toEqual([]);
  }
});

test("킥오프 틱 → 공이 센터 스팟에 있다", async ({ page }) => {
  const ks = await realKickoffs(page);
  const b = await page.evaluate((t) => {
    const v = (window as any).__viewer;
    v.seek(t);
    return v.cur().ball;
  }, ks[0].tick);
  expect(Math.abs(b.x - PITCH_W / 2)).toBeLessThan(1.0);
});
