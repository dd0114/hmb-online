import { test, expect } from "@playwright/test";
import { loadViewer, VIEWER_REAL_URL } from "./fixture";

/**
 * **화면 시계는 표기 분(0~90')을 따른다** (#365).
 *
 * 엔진은 45분(하프 1350틱)을 돌지만 `minute` 에 0~90 을 구워 보낸다(`EngineConfig.displayMinutes`).
 * 로그줄·타임라인은 그 구워진 값을 읽는데 **뷰어 시계만 엔진 틱을 그대로 분으로 읽고 있었다** —
 * 그래서 화면 위쪽 시계는 0~44' 로 흐르고 아래 로그는 0~90' 을 말하는, **한 화면이 두 시각을
 * 말하는** 상태였다. 순수 유도 규칙은 `viewer-core/playback.mjs.clockScaleOf` 가 SoT 이고
 * 여기서는 **실제 DOM 에 그려진 텍스트**로 확인한다(순수 함수만 검사하면 배선이 빠져도 통과한다).
 */

const clockText = (s: string): number => {
  const m = /^(\d+)'(\d{2})"/.exec(s.trim());
  if (!m) throw new Error(`시계 형식이 아니다: ${JSON.stringify(s)}`);
  return Number(m[1]) + Number(m[2]) / 60;
};

test.beforeEach(async ({ page }) => { await loadViewer(page, VIEWER_REAL_URL); });

test("시계가 로그에 구워진 표기 분을 따른다(엔진 틱이 아니라)", async ({ page }) => {
  // 표본은 **이벤트**로 잡는다 — 이벤트가 `tick` 과 `minute` 을 같이 들고 있어 두 축을 직접 맞댈 수
  // 있다(뷰어의 `cur()` 스냅샷은 렌더용이라 minute 을 싣지 않는다).
  const samples: { tick: number; minute: number }[] = await page.evaluate(() => {
    const evs = (window as any).__viewer.events().filter((e: { minute?: number }) => typeof e.minute === "number");
    // 하프 전후를 고루 — 스케일이 구간마다 흔들리지 않는지도 같이 본다.
    return [0.15, 0.35, 0.55, 0.85].map((f) => {
      const e = evs[Math.floor((evs.length - 1) * f)];
      return { tick: e.tick, minute: e.minute };
    });
  });
  expect(samples.length).toBe(4);

  for (const s of samples) {
    await page.evaluate((t) => (window as any).__viewer.seek(t), s.tick);
    const shown = clockText(await page.locator("#minute").innerText());
    // 시계는 초 단위까지 그리므로 이벤트의 정수 분과 ±1분 안에서 일치해야 한다.
    expect(
      Math.abs(shown - s.minute),
      `tick ${s.tick}: 화면 ${shown.toFixed(2)}' vs 이벤트 minute ${s.minute}'`,
    ).toBeLessThan(1);
  }
});

test("경기 끝 시계가 표기 전체 길이(90')에 닿는다 — 45분에서 멈추지 않는다", async ({ page }) => {
  const full = await page.evaluate(() => {
    const v = (window as any).__viewer;
    const e = v.events().find((x: { type: string }) => x.type === "full_whistle");
    if (e) v.seek(e.tick);
    return e ? { tick: e.tick, minute: e.minute } : null;
  });
  expect(full, "full_whistle 이벤트가 있어야 이 계약이 성립한다").not.toBeNull();
  const shown = clockText(await page.locator("#minute").innerText());
  expect(shown, `종료 시계 ${shown.toFixed(2)}' (이벤트 minute ${full!.minute}')`).toBeGreaterThanOrEqual(full!.minute - 1);
  // ⚠️ 리터럴 90 을 직접 단언한다 — 로그값과만 비교하면 둘이 함께 틀려도 통과한다.
  expect(shown).toBeGreaterThan(88);
});
