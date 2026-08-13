/**
 * #493 W7-v3 — 온레일 판정(**순수 함수만**).
 *
 * 프로바이더가 얇아지도록 "어느 스텝인가 · 이 화면이 맞나 · 무엇을 겨누나"를 전부 여기서 정한다.
 * 화면에 조건을 다시 적으면 규칙이 두 벌이 된다(`common/deckless.ts` 와 같은 규율).
 */
import { LOCKED_ROUTES, shouldForceResume, type ActiveMatchInfo } from "../common/match-lock";
import {
  ANY_SCREEN,
  DECK_PLAYER_TOKEN,
  ONRAIL_FIRST_STEP,
  ONRAIL_SCRIPT,
  TUTORIAL_CARD_TOKEN,
} from "./onrail-script";
import type { OnRailStep, OnRailStepId } from "./onrail-script";

/** 각본에서 스텝을 찾는다. 모르는 id 는 `null` — 저장값이 낡았을 때(각본 개편) 여기로 온다. */
export function stepById(id: OnRailStepId | null): OnRailStep | null {
  if (!id) return null;
  return ONRAIL_SCRIPT.find((s) => s.id === id) ?? null;
}

/**
 * 저장된 stepId 를 **실행 가능한 stepId 로 정규화**한다.
 *
 * 각본이 개편되면 저장된 id 가 사라질 수 있다. 그때 온레일을 통째로 죽이면(=완료 처리) 유저는
 * 보상 경로를 잃고, 아무것도 안 하면 영영 멈춘다 → **처음부터**가 유일하게 안전한 착지다.
 */
export function resolveStepId(id: OnRailStepId | null): OnRailStepId {
  return stepById(id) ? (id as OnRailStepId) : ONRAIL_FIRST_STEP;
}

/** 다음 스텝 id. 마지막이면 `null`(= 완주). */
export function nextStepId(id: OnRailStepId): OnRailStepId | null {
  const i = ONRAIL_SCRIPT.findIndex((s) => s.id === id);
  if (i < 0) return ONRAIL_FIRST_STEP;
  return ONRAIL_SCRIPT[i + 1]?.id ?? null;
}

/** 진행 표시용 — 1-based. 모르는 id 는 0. */
export function stepPosition(id: OnRailStepId): { index: number; total: number } {
  const i = ONRAIL_SCRIPT.findIndex((s) => s.id === id);
  return { index: i < 0 ? 0 : i + 1, total: ONRAIL_SCRIPT.length };
}

/**
 * 이 스텝이 지금 화면에 사는가.
 *
 * `/match` 는 매치 id 가 붙으므로 **접두**로 본다. 쿼리는 보지 않는다 — `/recruit?tab=trade` 와
 * `/recruit` 는 같은 화면이고, 탭 선택은 온레일이 이동시킬 때 붙이는 것이지 판정축이 아니다.
 */
export function onScreen(step: OnRailStep, pathname: string): boolean {
  if (step.screen === ANY_SCREEN) return true;
  if (step.screen === "/match") return pathname.startsWith("/match/");
  return pathname === step.screen;
}

/** 런타임에만 아는 값들 — 각본의 치환 토큰을 채운다. */
export interface OnRailTargets {
  /** 덱 첫 슬롯 선수 id(S2 "지정 선수 1명"). 모르면 null. */
  deckPlayerId?: string | null;
  /**
   * 스타터 고정 튜토리얼 카드 id(S5).
   *
   * 출처는 **`/api/config` 의 `tutorial.starterCardId`**(#493 W9 서버 소웨이브). 그 필드를 모르는
   * 서버에서는 추론으로 내려간다 — `tutorialCardIdFrom` 머리말.
   */
  tutorialCardId?: string | null;
}

/**
 * S5 대상 카드 id — **서버가 말해 준 값이 먼저다** (#493 W9).
 *
 * ⚠️ 구 동작은 추론뿐이었다: 가입 지급이 그 카드에 3지선다를 정확히 하나 대기시켜 두므로
 * "대기 중 선택권의 주인"을 그 카드로 읽었다. **추론이지 계약이 아니라서** 유저가 다른 카드로
 * 경기를 치러 선택권이 하나 더 생기면 순서가 흔들리고, 이미 써 버렸으면 아예 못 찾았다(그때는
 * 그리드로 착지 = 어느 카드를 눌러야 하는지 안 알려 준다). 서버가 `hmb.tutorial.starter.card-id`
 * 를 공개하면 그 자리가 **한 줄로 대체된다** — 그게 W9 이 한 일이다.
 *
 * ⚠️ **추론 가지를 지우지 않는다.** web 이 구 서버에 붙는 창이 항상 있고(배포 순서), 그때
 * 필드는 `undefined` 로 온다. 폴백이 없으면 그 창에서 S5 안내가 통째로 그리드로 내려앉는다.
 */
export function tutorialCardIdFrom(
  declared: string | null | undefined,
  pendingChoices: readonly { playerId?: string | null }[] | null | undefined,
): string | null {
  if (typeof declared === "string" && declared.length > 0) return declared;
  if (!Array.isArray(pendingChoices) || pendingChoices.length === 0) return null;
  return pendingChoices[0]?.playerId ?? null;
}

/**
 * 이 스텝이 실제로 겨눌 `data-testid`.
 *
 * 치환할 값이 없으면 `fallbackTestId` → 그것도 없으면 `null`(대상 없는 전면 안내).
 * ⚠️ **토큰이 남은 문자열을 그대로 돌려주지 않는다** — `token-{deckPlayerId}` 라는 셀렉터는 영영
 * 안 맞고, 그 스텝은 hold 로 조용히 멈춘다(유저에게는 "튜토리얼이 죽었다"로 보인다).
 */
export function resolveTarget(step: OnRailStep, targets: OnRailTargets): string | null {
  const raw = step.targetTestId;
  if (!raw) return null;
  const subs: [string, string | null | undefined][] = [
    [DECK_PLAYER_TOKEN, targets.deckPlayerId],
    [TUTORIAL_CARD_TOKEN, targets.tutorialCardId],
  ];
  let out = raw;
  for (const [token, value] of subs) {
    if (!out.includes(token)) continue;
    if (!value) return step.fallbackTestId ?? null;
    out = out.split(token).join(value);
  }
  return out;
}

/**
 * 이 스텝이 경기 재생을 얼려야 하는가 — `MatchPage` 가 이 한 줄만 본다.
 * 화면이 맞아야 참이다(덱 화면에 있는 동안 경기를 얼릴 이유가 없다).
 */
export function freezesMatch(step: OnRailStep | null, pathname: string): boolean {
  return Boolean(step?.freezeMatch) && Boolean(step && onScreen(step, pathname));
}

/**
 * 오버레이가 지금 화면을 **막아도 되는가**.
 *
 * 남의 다이얼로그(모달)가 떠 있으면 규칙이 갈린다:
 *  · 그 다이얼로그가 **대상을 품고 있다** → 막지 않는다. 모달 자체가 이미 선택지를 좁히고 있고,
 *    딤을 한 겹 더 깔면 모달이 두 번 어두워진다. 말풍선과 링은 그대로 보여 준다(S5 성장 상세).
 *  · 그렇지 않다 → 오버레이를 **통째로 감춘다**. 안 그러면 확인창(잠재 재설정 확인 · 보상 봉투)
 *    위에 말풍선이 남아 그 버튼을 덮는다 — `TutorialOverlay.hasForeignDialog` 가 겪은 그 사고다.
 *
 * 두 규칙을 하나로 합치지 마라. "다이얼로그가 있으면 감춘다"로 뭉치면 성장 상세(모달)에서 온레일이
 * 통째로 사라지고, "있어도 그대로 막는다"로 뭉치면 확인창을 못 누른다.
 */
export type OnRailShield =
  /** 평소 — 딤이 입력을 막고 대상만 뚫린다. */
  | "block"
  /** 모달 안의 대상 — 안내만 얹는다(딤 없음). */
  | "guide-only"
  /** 남의 확인창 — 비켜난다. */
  | "hidden";

export function shieldFor(target: Element | null, dialogs: readonly Element[]): OnRailShield {
  if (dialogs.length === 0) return "block";
  // 대상을 품지 않은 다이얼로그가 하나라도 있으면 그쪽이 지금의 주인공이다.
  const blocking = dialogs.some((d) => !target || !d.contains(target));
  if (blocking) return "hidden";
  return "guide-only";
}

// ── 수행 가능 전제 (#493 W9) ──────────────────────────────────────────────
//
// 온레일의 기본 규율은 **"대상이 없으면 기다린다"** 다(위 머리말). 그 규율이 정확히 반대로
// 작동하는 자리가 있다 — **대상은 렌더되는데 유저가 그걸 수행할 수 없을 때**다. 대상이 있으니
// hold 도 skipIfMissing 도 걸리지 않아 레일이 **영원히** 그 자리를 가리킨다(W8-v3 독립 검증
// blocker B2·B6·B3 이 전부 이 한 부류였다):
//
//   · 쿠폰도 잔액도 없는 유저의 S6 [단축]        → 버튼은 뜨는데 `disabled`
//   · 보유를 다 배치한 유저의 S2 [자동 채우기]    → 버튼은 뜨는데 `disabled`
//   · 진행 중 매치가 있는 유저의 S5 `/players`   → 그 화면에 **갈 수가 없다**(MatchLockGate)
//
// 그래서 스텝마다 "지금 이걸 할 수 있나"를 묻고, **불성립이면 건너뛴다**. 기다림과 건너뜀의
// 경계는 이제 *대상의 유무*가 아니라 **수행 가능성**이다 — 나타날 수 있는 것은 기다리고,
// 이 유저에게 열리지 않는 것은 넘긴다.

/** 무엇 때문에 건너뛰었나 — **닫힌 목록**이고, 그대로 진행 상태에 적힌다(추후 분석용). */
export type OnRailSkipReason =
  /** 대상이 유예 안에 나타나지 않았다(각본이 `skipIfMissing` 으로 그렇게 고른 스텝). */
  | "target-missing"
  /** 대상이 화면에 있는데 **입력을 거절한다**(쿠폰 없음·후보 없음·잔액 부족 …). */
  | "target-disabled"
  /** 그 화면 자체에 갈 수 없다(진행 중 매치가 메타 화면을 잠갔다, #217). */
  | "screen-locked";

export const ONRAIL_SKIP_REASONS: readonly OnRailSkipReason[] = [
  "target-missing",
  "target-disabled",
  "screen-locked",
];

/**
 * 이 요소가 **입력을 거절하는가**.
 *
 * ⚠️ 판정을 화면 규칙의 사본으로 만들지 않는다 — `canFillEmptySlots`·`speedupButtonState` 를
 * 프로바이더가 다시 계산하면 규칙이 두 벌이 되고(모듈 규율), 그 두 벌은 반드시 갈라진다.
 * 화면은 이미 자기 규칙으로 판정해 `disabled` 를 **렌더해 놓았다** — 온레일은 그 결론만 읽는다.
 * 그래서 새 화면에 새 잠금 조건이 생겨도 여기는 고칠 것이 없다.
 */
export function targetRefusesInput(el: Element | null): boolean {
  if (!el) return false;
  return el.matches("[disabled],[aria-disabled='true']");
}

/** 이 경로가 진행 중 매치에 잠기는 화면인가(#217 `LOCKED_ROUTES` 를 **소비**한다). */
export function isLockedScreen(screen: string): boolean {
  return (LOCKED_ROUTES as readonly string[]).includes(screen);
}

/**
 * 이 스텝의 화면에 지금 갈 수 있는가 — 못 가면 `"screen-locked"`.
 *
 * 판정 자체는 하지 않는다: `shouldForceResume` 이 이미 "잠겼고 아직 포기할 수 없다"를 소유하고
 * 있고(그 함수 머리말), 여기서 같은 규칙을 다시 적으면 서버가 바뀔 때 조용히 어긋난다.
 */
export function screenLockedFor(
  step: OnRailStep | null,
  active: ActiveMatchInfo | undefined | null,
): boolean {
  if (!step) return false;
  return isLockedScreen(step.screen) && shouldForceResume(active);
}

/**
 * 건너뛴 뒤 설 스텝. **앞으로만 간다** — 인덱스가 단조 증가하므로 어떤 조합에서도 각본 끝
 * (= 완주 스텝)에 닿는다. 이것이 이 웨이브의 AC 다.
 *
 * 범위는 사유가 정한다:
 *  · `screen-locked` — **연속한 잠긴-화면 스텝을 통째로**. 같은 잠금이 그 스텝들 전부를 막고
 *    있으므로 하나씩 유예를 다시 기다릴 이유가 없다(S5 5스텝 + S6 3스텝 = 8번의 유예가 된다).
 *  · 나머지 — **그 스텝 하나**. S2 에서 AUTO 를 못 눌러도 선수·한마디·저장은 그 유저도 한다.
 */
export function stepAfterSkip(
  id: OnRailStepId,
  reason: OnRailSkipReason,
  script: readonly OnRailStep[] = ONRAIL_SCRIPT,
): OnRailStepId | null {
  const from = script.findIndex((s) => s.id === id);
  if (from < 0) return null;
  let i = from + 1;
  if (reason === "screen-locked") {
    while (i < script.length && isLockedScreen(script[i]!.screen)) i += 1;
  }
  return script[i]?.id ?? null;
}
