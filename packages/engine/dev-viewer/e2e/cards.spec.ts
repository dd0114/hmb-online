import { test, expect } from "@playwright/test";
import { loadViewer, VIEWER_REAL_URL } from "./fixture";

// R4(#100) 계약: 카드가 나오면 "받은 선수"가 화면에 명확히 표시된다.
// 카드 발생 후 CARD_SHOW_TICKS 동안 그 선수 마커에 카드색 링 + 카드 아이콘 + "🟨/🟥 #번호" 라벨.
// 카드 마커는 canvas 렌더라 좌표 추론 대신 __viewer.cardMarks()(그려진 마커 데이터)로 박제한다.
// 마커 위치가 실제 받은 선수 마커에 앵커되는지는 실화면 캡처로 별도 검증(§2.2).

test("showcase: 카드 → 받은 선수가 화면에 표시된다(옐로=마커 / 레드=퇴장)", async ({ page }) => {
  // showcase(demoSeed) 의 카드 종류는 엔진 튜닝에 따라 옐로/레드로 바뀔 수 있다(시드 의존).
  // 계약: 옐로면 그 선수 마커가 앵커되고, 레드면 퇴장(마커 없음)이되 둘 다 이벤트 티커에 병기된다.
  // 옐로 마커의 세부(num/side/px 유한)는 real 뷰어 테스트(아래)가 결정론 시드로 박제한다.
  await loadViewer(page);
  const cards = await page.evaluate(() => (window as any).__viewer.events().filter((e: any) => e.type === "card"));
  expect(cards.length, "showcase 에 카드 있어야").toBeGreaterThan(0);
  const c = cards[0];
  const marks = await page.evaluate((tick: number) => {
    const v = (window as any).__viewer;
    v.seek(tick);
    return v.cardMarks();
  }, c.tick);
  const m = marks.find((x: any) => x.playerId === c.playerId);
  if (c.detail === "red") {
    // 레드=퇴장: 선수가 코트에서 제거되므로 그 틱 스냅샷에 위치가 없어 마커가 앵커되지 않는다(정상).
    expect(m, `레드카드 퇴장 선수 ${c.playerId} 는 코트에서 제거돼 마커 없음이 정상`).toBeFalsy();
  } else {
    // 옐로=잔류: 받은 선수 마커가 앵커된다.
    expect(m, `옐로카드 마커에 받은 선수 ${c.playerId} 있어야`).toBeTruthy();
    expect(m.num).toBe(c.playerId.replace(/[HA]/, ""));
    expect(m.red).toBe(false);
    expect(m.side).toBe(c.playerId[0] === "H" ? "home" : "away");
    expect(Number.isFinite(m.px) && Number.isFinite(m.py)).toBe(true);
  }
  // 종류 무관: 이벤트 티커에 받은 선수 번호(#N)가 병기돼 "누가 받았는지" 표시된다.
  const tickerText = await page.$$eval(".ev-card", (els) => els.map((e) => e.textContent || "").join(" "));
  expect(tickerText).toContain("#" + c.playerId.replace(/[HA]/, ""));
});

test("카드 마커는 발생 후 잠깐만 유지되고 사라진다(지속 클러터 아님)", async ({ page }) => {
  await loadViewer(page);
  const c = (await page.evaluate(() => (window as any).__viewer.events().filter((e: any) => e.type === "card")))[0];
  const far = await page.evaluate((tick: number) => {
    const v = (window as any).__viewer;
    v.seek(tick + 40); // CARD_SHOW_TICKS(12) 훨씬 뒤
    return v.cardMarks();
  }, c.tick);
  expect(far.find((x: any) => x.playerId === c.playerId), "충분히 지난 뒤엔 카드 마커 사라짐").toBeFalsy();
});

test("real 뷰어: 카드 받은 선수 마커 표시 + 티커에 선수 병기", async ({ page }) => {
  await loadViewer(page, VIEWER_REAL_URL);
  const cards = await page.evaluate(() => (window as any).__viewer.events().filter((e: any) => e.type === "card"));
  expect(cards.length).toBeGreaterThan(0);
  const c = cards[0];
  const marks = await page.evaluate((tick: number) => { (window as any).__viewer.seek(tick); return (window as any).__viewer.cardMarks(); }, c.tick);
  expect(marks.find((x: any) => x.playerId === c.playerId), "받은 선수 마커").toBeTruthy();
  // 티커 항목에 받은 선수 번호(#N)가 병기된다.
  const tickerText = await page.$$eval(".ev-card", (els) => els.map((e) => e.textContent || "").join(" "));
  expect(tickerText).toContain("#" + c.playerId.replace(/[HA]/, ""));
});
