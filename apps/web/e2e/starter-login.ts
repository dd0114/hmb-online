import { expect, type Page } from "@playwright/test";
import { skipSplash } from "./splash-mock";

/**
 * 게스트 로그인 + **스타터 팩 연출이 끝날 때까지** 기다린다 (#471 AC4).
 *
 * 왜 헬퍼인가: 세 스펙(`match-flow`·`league-season`·`w3-viewer-smoke`)이 같은 6줄을 복붙하고 있었고,
 * 그 6줄이 **연출을 안 기다렸다** — `계속` 직후 곧바로 `확인` 을 누른다. 실서버 로컬 스택(#471)에서
 * 콜드로 돌리면 그게 그대로 드러난다:
 *   · 카드를 받은 유저는 모달이 **`카드 공개`** 단계라 `확인` 이 없어 300초를 기다리다 죽고,
 *   · 운 좋게 `확인` 을 누른 경우에도 연출 중 클릭이라 모달이 닫히지 않고 **`/login` 에 남는다**
 *     (실측: `34 × unexpected value "http://localhost:31199/login"`, 그 시점 스냅샷에 `확인` 이 그대로 있다).
 * 데모 서버에서 우연히 통과하던 타이밍이라, 스택을 바꾸자 세 스펙이 **같은 뿌리로** 무너졌다.
 *
 * ⚠️ 규약은 **한 곳**에만 둔다 — `gacha-reveal-settle.ts` 가 같은 이유로 남긴 교훈이다(2R 검증 m-1):
 * 복붙하면 정착 신호가 바뀔 때 한쪽만 고쳐도 green 이라 조용히 갈라진다.
 */
export async function loginGuestAndSettleStarter(page: Page, nickname: string): Promise<void> {
  // #479 스플래시 우회는 **여기가 소유한다** — `addInitScript` 라 반드시 `goto` 전이어야 하는데,
  // 그 순서 제약을 호출자에게 맡기면 조용히 어긋난다(그때 증상은 "폼이 안 뜬다"). 이 헬퍼가
  // goto 를 소유하므로 그 앞의 init 도 같이 소유하는 것이 맞다. 호출자가 따로 부를 필요 없다.
  await skipSplash(page);
  await page.goto("/login");
  await page.getByTestId("provider-guest").click();
  await page.getByPlaceholder("2~16자").fill(nickname);
  await page.getByRole("button", { name: "계속" }).click();

  const dialog = page.getByRole("dialog", { name: "스타터 팩 지급" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });

  // 모달은 상태가 둘이고(공개 전 / 공개 후) 그 사이에 **연출 시간**이 있다. 그래서 "공개 클릭 → 확인 클릭"
  // 같은 고정 순서로는 못 지난다 — 실측에서 같은 코드가 어떤 유저에겐 통과하고 어떤 유저에겐 30초를
  // 기다리다 죽었다(카드 등급에 따라 연출 길이가 다르다).
  //
  // 그래서 순서를 정하지 않고 **끝 상태로 수렴시킨다**: 확인이 있으면 누르고, 없으면 공개를 누르고,
  // 될 때까지 반복한다. 계약은 모달 내부 상태가 아니라 **"로그인이 끝났는가"(URL)** 다.
  //
  // ⚠️ "카드 공개" 이름의 버튼이 **둘**(카드 자체 + 버튼)이라 strict mode 위반이 난다 — 그래서 인덱스로
  //    집는다. 초판은 `isVisible()` 의 그 예외를 `.catch(() => false)` 로 삼켜 **공개를 건너뛴 채 조용히
  //    진행**했다(그 다음 단언이 30초 뒤에 죽어서야 드러났다).
  const confirm = dialog.getByRole("button", { name: "확인" });
  const reveals = dialog.getByRole("button", { name: "카드 공개" });

  await expect(async () => {
    if (await confirm.count()) {
      await confirm.click({ timeout: 5_000 });
    } else {
      const n = await reveals.count();
      for (let i = 0; i < n; i++) await reveals.nth(i).click({ timeout: 5_000 }).catch(() => {});
    }
    await expect(page).toHaveURL(/\/home$/, { timeout: 5_000 });
  }).toPass({ timeout: 120_000, intervals: [1_000] });
}
