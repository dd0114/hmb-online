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

/**
 * 보드의 선수를 **지시 대상으로 고른다** — #455 A2 이후 화면마다 경로가 다르다.
 *
 * | 화면 | 토큰 탭이 하는 일 |
 * |---|---|
 * | 폰 덱셋팅(`data-layout="tabs"`) | **선수 메뉴 시트** → `[한마디 쓰기]` 를 눌러야 지시 칸으로 간다 |
 * | 경기전 · 감독시간 · 데스크탑 덱(`stack`) | 예전 그대로 — 탭이 곧 그 선수 지시 |
 *
 * ⚠️ **"있으면 거친다"가 아니다.** 화면이 스스로 선언한 축(`deck-editor[data-layout]`)을 읽고
 * **그 화면에서 참이어야 하는 것을 단언**한다 — tabs 인데 메뉴가 없으면 red, stack 인데 메뉴가
 * 있어도 red. 그래서 "메뉴를 모든 화면에 켠다"·"메뉴를 통째로 없앤다" 두 변이가 **양쪽에서** 죽는다.
 * (느슨한 `…IfPresent` 를 쓰면 둘 다 조용히 통과한다 — 위 헬퍼 주석과 같은 이유.)
 *
 * `touch` = 실터치(`.tap()`)로 밟는다. 폰 제스처 계약(#442)은 `page.mouse` 를 쓰면 그 부류를
 * 구조적으로 못 잡으므로 그 파일들이 켠다.
 */
export async function selectBoardPlayer(
  page: Page,
  playerId: string,
  opts: { touch?: boolean } = {},
): Promise<void> {
  const token = page.getByTestId(`token-${playerId}`);
  await (opts.touch ? token.tap() : token.click());
  await passPlayerMenu(page, opts);
}

/**
 * 토큰을 **이미 눌렀다**는 전제에서, 그 화면이 선수 메뉴를 쓰면 `[한마디 쓰기]` 까지 밟는다.
 *
 * 토큰을 셀렉터가 아니라 **순서(nth)** 로 고르는 스펙(`p286-w3`)이 있어서 위 헬퍼와 갈랐다 —
 * 그쪽에 맞추려고 그 스펙이 자기 손으로 메뉴를 밟게 두면, "메뉴가 어느 화면에 있나"라는 사실이
 * 스펙마다 복사돼 다음 번에 각자 낡는다.
 */
export async function passPlayerMenu(page: Page, opts: { touch?: boolean } = {}): Promise<void> {
  const editor = page.getByTestId("deck-editor");
  await expect(editor, "보드가 있는 화면이 아니다").toHaveCount(1);
  const layout = await editor.getAttribute("data-layout");
  if (layout === "tabs") {
    await expect(
      page.getByTestId("player-menu"),
      "폰 덱셋팅에서 토큰 탭은 선수 메뉴를 열어야 한다(#455 A2 ①)",
    ).toHaveCount(1);
    const say = page.getByTestId("pmenu-say");
    await (opts.touch ? say.tap() : say.click());
    await expect(page.getByTestId("player-menu"), "고르면 메뉴는 닫힌다").toHaveCount(0);
  } else {
    await expect(
      page.getByTestId("player-menu"),
      `이 화면(layout=${layout})에는 선수 메뉴가 없다 — 토큰 탭이 곧 지시다`,
    ).toHaveCount(0);
  }
}
