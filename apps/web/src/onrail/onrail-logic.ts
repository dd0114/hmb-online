/**
 * #493 W7-v3 — 온레일 판정(**순수 함수만**).
 *
 * 프로바이더가 얇아지도록 "어느 스텝인가 · 이 화면이 맞나 · 무엇을 겨누나"를 전부 여기서 정한다.
 * 화면에 조건을 다시 적으면 규칙이 두 벌이 된다(`common/deckless.ts` 와 같은 규율).
 */
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
   * ⚠️ 서버가 이 값을 **안 알려 준다** — `hmb.tutorial.starter.card-id`(현재 P122)는 서버 설정일
   * 뿐 `/api/config` 에도 `/api/me` 에도 없다. 그래서 web 은 "XP 프리필로 대기 중인 3지선다"의
   * 주인을 그 카드로 읽는다(`useTutorialCard`). 못 읽으면 `fallbackTestId` 로 착지한다.
   */
  tutorialCardId?: string | null;
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
