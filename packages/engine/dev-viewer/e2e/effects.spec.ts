import { test, expect } from "@playwright/test";
import { loadViewer } from "./fixture";

// R2(#100) 계약: 패스완성/가로챔/돌파 이벤트를 재생으로 지나면 그에 맞는 재미 이펙트가 스폰된다.
// 이펙트는 canvas 파티클이라 __viewer.fx()(활성 이펙트 [{type,rgb}])로 스폰 여부를 박제한다.
test.beforeEach(async ({ page }) => { await loadViewer(page); });

/** startTick-1 부터 재생하며 fx() 에 type 이 나타날 때까지 대기. 없으면 실패. */
async function playUntilFx(page: any, startTick: number, type: string, timeout = 8000) {
  await page.evaluate((t: number) => { const v = (window as any).__viewer; v.autoPace(false); v.pause(); v.seek(t - 1); v.play(); }, startTick);
  const handle = await page.waitForFunction(
    (ty: string) => (window as any).__viewer.fx().some((f: any) => f.type === ty),
    type,
    { timeout },
  );
  const val = await handle.jsonValue();
  await page.evaluate(() => (window as any).__viewer.pause());
  return val;
}

test("패스 완성 → 팀색 펄스 이펙트 스폰", async ({ page }) => {
  const pass = (await page.evaluate(() => (window as any).__viewer.events().filter((e: any) => e.type === "pass")))[0];
  expect(pass).toBeTruthy();
  const ok = await playUntilFx(page, pass.tick, "pass");
  expect(ok).toBe(true);
});

test("가로챔 → 스틸 플래시(steal) 이펙트 스폰, 가로챈 팀 색", async ({ page }) => {
  const intc = (await page.evaluate(() => (window as any).__viewer.events().filter((e: any) => e.type === "interception")))[0];
  expect(intc).toBeTruthy();
  await playUntilFx(page, intc.tick, "steal");
  // 스폰된 steal 이펙트 색이 가로챈 팀 색과 일치.
  const rgb = await page.evaluate(() => {
    const s = (window as any).__viewer.fx().find((f: any) => f.type === "steal");
    return s ? s.rgb : null;
  });
  const expected = intc.team === "home" ? "59,130,246" : "239,68,68";
  expect(rgb).toBe(expected);
});

test("돌파(SURGE) → 스피드라인(surge) 이펙트 스폰", async ({ page }) => {
  // SURGE 토스트 틱을 찾는다: 긴 드리블 추론이라 이벤트가 아니라 annos 파생. 뷰어에서 직접 재생으로 검출.
  // showcase 에 SURGE 가 없으면 skip(엔진 시드 의존) — 하지만 대개 존재.
  const hasSurge = await page.evaluate(async () => {
    const v = (window as any).__viewer;
    v.autoPace(true); v.seek(0); v.play();
    return await new Promise<boolean>((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (v.fx().some((f: any) => f.type === "surge")) { clearInterval(iv); v.pause(); resolve(true); }
        else if (Date.now() - t0 > 25000) { clearInterval(iv); v.pause(); resolve(false); }
      }, 50);
    });
  });
  expect(hasSurge, "재생 중 돌파(SURGE) 스피드라인 이펙트가 스폰되어야").toBe(true);
});
