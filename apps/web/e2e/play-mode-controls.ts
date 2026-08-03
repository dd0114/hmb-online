import { expect, type Page } from "@playwright/test";

/**
 * **플레이 모드(관객 화면) 재생 컨트롤 바의 금지 목록** — `#148`/`#216` 계약의 단일 출처.
 *
 * <h3>왜 "버튼 개수 0" 이 아닌가 (#406 W9 재범위화)</h3>
 * 원래 계약은 `viewer-controls-halfN` 안의 `button` **개수 == 0** 이었다. 그 대리 지표가
 * 잡으려던 결함은 하나다 — **QA 식 재생 조작 칩이 유저 화면으로 새는 것**(`#216` 은 그중
 * 하이라이트 토글이 켜진 채 라이브 재생이 깨진 경로를 타던 사고였다).
 *
 * 그런데 hero 승인 요구 5-3(**과거 전용 시크바**, 목업 `docs/plan-v5/mock/406-matchux/match-ux.html`
 * §3)이 **바로 그 자리에** 유저용 시간바를 넣었다. 시크바는 트랙 위에 키장면 핀을
 * `<button>` 으로 얹으므로(하프당 수십 개) 개수 단언은 그날부터 **정책이 바뀐 사실만 알리고
 * 결함은 하나도 못 잡는 지표**가 됐다. 그래서 지표를 갈아탄다:
 *
 *  ① **바 안의 `button` 은 전부 시크바 소유다** — 화이트리스트라 *이름을 모르는* 새 칩도 잡는다.
 *  ② **아래 이름들은 바 안에 하나도 없다** — 시크바 **안쪽**에 끼워 넣어 ①을 우회하는 것도 잡는다.
 *
 * ⚠️ **약화가 아니다.** ①은 개수 단언이 잡던 것을 그대로 잡고(그 시절 유일한 위반 = QA 칩), ②는
 * 개수 단언이 **못 잡던 것**(시크바 subtree 안에 숨긴 칩 — 개수가 46 이든 47 이든 아무도 모른다)을
 * 새로 잡는다. 변이 증거는 `#406` W9 보고에 있다.
 *
 * <h3>허용되는 것 = 요구 5-3 시크바뿐</h3>
 * `viewer-seek-bar-halfN` 안의 배지(`⏪ 과거 보는 중`)·`현재로 ▶`·키장면 핀. 이것들은 **재생
 * 조작이 아니다** — 전부 `seek-gate`(`clampSeek`)를 지나 **과거로만** 간다. 그 성질 자체의 계약은
 * `p406-past-seek.spec.ts` 가 진다(여기서 다시 재지 않는다).
 *
 * ⚠️ **적용 대상은 비-admin(관객) 화면이다.** admin 이 모드 토글로 플레이 모드를 미리 보는 상태
 * (`matchui-controls-mock` 의 세 번째 테스트)에는 토글 자체가 **남아 있어야** 한다 — 도구를 뺏는
 * 계약이 아니라 관객에게 새지 않는 계약이기 때문이다. 그 상태에는 이 함수를 쓰지 않는다.
 */
export const QA_TRANSPORT_TESTIDS: readonly string[] = [
  // 풀컨트롤 묶음 자체(있으면 그 안의 전부가 새어 나온 것이다)
  "viewer-admin",
  "viewer-advanced",
  "viewer-review",
  // 재생·정지·처음부터
  "viewer-play-toggle",
  "viewer-restart",
  // 배속(코어 SPEEDS 전량 + 돌려보기 순환)
  "viewer-speed-0.1",
  "viewer-speed-0.25",
  "viewer-speed-0.5",
  "viewer-speed-1",
  "viewer-speed-2",
  "viewer-speed-4",
  "viewer-speed-cycle",
  // 장면 점프(골·슛·이전/다음 장면)
  "viewer-prev-goal",
  "viewer-next-goal",
  "viewer-prev-shot",
  "viewer-next-shot",
  "viewer-prev-scene",
  "viewer-next-scene",
  // 초·프레임 스텝
  "viewer-step-minus5s",
  "viewer-step-minus1s",
  "viewer-step-minus1f",
  "viewer-step-plus1f",
  "viewer-step-plus1s",
  "viewer-step-plus5s",
  // QA 스크럽·mm:ss 점프·QA 시계·QA 타임라인·장면 리스트
  "viewer-scrub",
  "viewer-goto",
  "viewer-clock",
  "viewer-timeline",
  "viewer-scenes",
  // 모드 전환(관객이 QA 화면으로 넘어가는 문)
  "viewer-mode-toggle",
  "viewer-mode-play",
  "viewer-mode-full",
  // 하이라이트 연출 끄기(#216 — 끔 경로 자체가 없다)
  "viewer-highlight-toggle",
  "viewer-highlight-admin",
];

/**
 * 플레이 모드 재생 컨트롤 바에 **QA 재생 조작이 하나도 없다**(위 머리말 ①+②).
 *
 * @param half 하프(testid 접미) — 계약이 재는 화면의 하프를 그대로 준다.
 */
export async function expectNoQaTransport(page: Page, half: 1 | 2 = 1): Promise<void> {
  const bar = page.getByTestId(`viewer-controls-half${half}`);
  await expect(bar, "플레이 모드 재생 컨트롤 바 자체는 있어야 한다").toHaveCount(1);

  // ① 화이트리스트 — 바 안의 button 은 전부 요구 5-3 시크바 소유다(이름을 몰라도 잡힌다).
  const strays = await bar.locator("button").evaluateAll((els, seekId) => {
    const sel = `[data-testid="${seekId}"]`;
    return els
      .filter((el) => !el.closest(sel))
      .map((el) => el.getAttribute("data-testid") ?? `(testid 없음: ${el.textContent?.trim().slice(0, 20)})`);
  }, `viewer-seek-bar-half${half}`);
  expect(
    strays,
    "재생 컨트롤 바에 시크바(요구 5-3) 밖의 버튼이 있다 = QA 재생 조작이 관객 화면으로 샜다",
  ).toEqual([]);

  // ② 이름을 아는 QA 도구는 바 안 어디에도 없다 — 시크바 subtree 안에 숨겨도 걸린다.
  for (const id of QA_TRANSPORT_TESTIDS) {
    await expect(
      bar.getByTestId(`${id}-half${half}`),
      `${id} 는 QA 도구다 — 플레이 모드 바에 있으면 안 된다(#148/#216)`,
    ).toHaveCount(0);
  }
}
