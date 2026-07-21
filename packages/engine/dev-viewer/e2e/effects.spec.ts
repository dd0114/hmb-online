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
  // SURGE 는 이벤트가 아니라 긴 전진 소유 런에서 파생되는 annos → __viewer.surgeTicks() 로 결정론적으로
  // 겨냥한다(autoPace 방랑 대신 그 틱을 실제 재생으로 통과 → spawnSurgeFx). 패스/스틸 이펙트와 동일 패턴.
  const surges = await page.evaluate(() => (window as any).__viewer.surgeTicks());
  expect(surges.length, "showcase 에 돌파(SURGE) 런이 있어야").toBeGreaterThan(0);
  await playUntilFx(page, surges[0], "surge");
  const spawned = await page.evaluate(() => (window as any).__viewer.fx().some((f: any) => f.type === "surge"));
  expect(spawned, "재생 중 돌파(SURGE) 스피드라인 이펙트가 스폰되어야").toBe(true);
});
