/**
 * 덱셋팅(`/deck`) **책갈피 탭 레이아웃** 헬퍼 — #455 A1.
 *
 * ## 왜 이 파일이 생겼나
 * A1 이 덱셋팅 화면을 `layout="tabs"` 로 바꾸면서 **경기장이 세로를 68 상한까지 먹고**,
 * 그 아래에 책갈피 탭 `[📣 전체 지시][👥 후보 N][⚙ 세부 전술]` 이 들어왔다.
 * 그래서 예전에 보드 하단 바에 상주하던 것들이 **탭 뒤로** 들어갔다:
 *
 * | 손잡이 | 예전(=지금도 경기전·감독시간) | 지금 `/deck` |
 * |---|---|---|
 * | `pool-sheet-open` (보유 선수) | 보드 하단 바 — 항상 보임 | **[👥 후보] 탭 안** |
 * | `board-reset` (초기화) | 보드 하단 바 — 항상 보임 | **[👥 후보] 탭 안** |
 * | `board-bench-section` (벤치) | 보드 안 | **[👥 후보] 탭 안**(포털) |
 * | `team-tactics-panel` (전술 다이얼) | `team-tune-toggle` ⚙ 뒤 | **[⚙ 세부 전술] 탭 = 그 접힘 자체** |
 *
 * ⚠️ `team-tune-toggle` 은 `/deck` 에 **없다**. 탭이 곧 접힘이라 토글을 또 두면 접힘이 2겹이 된다
 * (#244 "프롬프트 1급 · 세부조정은 뒤" 는 오히려 더 강해졌다 — 이제 탭 하나를 더 넘겨야 나온다).
 * 경기전(`BriefingPanel`)·감독시간(`HalftimePanel`)은 **`layout="stack"` 그대로**라 ⚙ 토글이 살아 있다.
 * 그 화면 스펙은 이 헬퍼를 쓰지 마라 — 쓰면 없는 탭을 찾다 죽는다.
 *
 * ## 왜 헬퍼인가
 * `getByTestId("deck-tab-sub").click()` 한 줄을 15군데에 흩뿌리면, 다음에 탭 구성이 바뀔 때
 * 15군데가 각자 낡는다. 화면의 진실은 한 곳에 적어 두고 스펙은 **의도**만 말하게 한다.
 */
import { expect, type Page } from "@playwright/test";

export type DeckPanel = "team" | "sub" | "tune";

/**
 * `/deck` 의 해당 탭을 열고 그 패널이 실제로 화면에 있는지까지 확인한다.
 * (`hidden` 속성 패널은 `display:none` 이라 `toBeVisible()` 로 갈린다.)
 */
export async function openDeckPanel(page: Page, panel: DeckPanel): Promise<void> {
  const tab = page.getByTestId(`deck-tab-${panel}`);
  await expect(tab, `/deck 책갈피 탭 [${panel}] 이 없다 — stack 화면에서 부른 건 아닌가?`).toHaveCount(1);
  await tab.click();
  await expect(page.locator(`#deck-tabpanel-${panel}`)).toBeVisible();
}

/** `[👥 후보]` — 보유 선수 시트 열기·초기화·벤치가 사는 탭. */
export const openCandidatesTab = (page: Page) => openDeckPanel(page, "sub");

/**
 * 덱셋팅·경기전을 **둘 다 태우는 공용 헬퍼**용 — 탭이 있으면 열고, 없으면 그냥 지나간다.
 *
 * ⚠️ 스펙 본문에서는 쓰지 마라. "있으면 연다"는 탭이 통째로 사라져도 조용히 통과하므로,
 * 화면이 하나로 정해진 자리에서는 단언하는 `openCandidatesTab` 을 써야 결함이 죽는다.
 * 여기서 느슨한 것이 맞는 이유는 **호출자가 두 레이아웃을 오가기 때문**이다(경기전 = stack).
 */
export async function openCandidatesTabIfPresent(page: Page): Promise<void> {
  if ((await page.getByTestId("deck-tab-sub").count()) > 0) await openCandidatesTab(page);
}

/** `[⚙ 세부 전술]` — 전술 다이얼(라인·압박·템포·폭)이 사는 탭. */
export const openTuneTab = (page: Page) => openDeckPanel(page, "tune");
