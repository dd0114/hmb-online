/**
 * 튜토리얼 순수 로직 (PRD-v4 §B) — DOM/스토리지 접근 없음. 전부 유닛 테스트 대상.
 *  - 시작 여부 판정(서버 값 우선, 없으면 로컬)
 *  - 대상 요소 사용 가능 판정(부재/화면 밖 → 스킵)
 *  - 말풍선 배치 계산(AC-B2: 대상을 가리키고 화면 밖으로 안 나감)
 */
import type { TutorialStep } from "./tutorial-steps";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 실행 대상 스텝(=enabled). 정의만 남긴 stub 은 여기서 빠진다. */
export function enabledSteps(steps: readonly TutorialStep[]): TutorialStep[] {
  return steps.filter((s) => s.enabled);
}

/**
 * 지금 화면에서 **보여줄 수 있는** 스텝인가 = 라우트 힌트가 없거나 현재 경로와 같다.
 *
 * 힌트 없는 스텝(레거시·화면 무관 요소)은 언제나 후보다 — 즉 이 함수는 기존 동작을
 * 좁히기만 하고 넓히지 않는다. 반대로 힌트가 붙은 스텝은 그 화면에 실제로 도착해야
 * 후보가 되므로, 다른 화면에서 헛되이 '대상 부재 스킵'을 소모하지 않는다.
 */
export function stepOnRoute(step: TutorialStep, pathname: string): boolean {
  return step.route === undefined || step.route === pathname;
}

/**
 * 하이라이트할 수 있는 대상인가.
 * 부재(null)·크기 0(display:none 등)·뷰포트 완전 이탈이면 false → 그 스텝은 건너뛴다.
 */
export function isTargetUsable(rect: Rect | null, viewport: Size): boolean {
  if (!rect) return false;
  if (rect.width <= 0 || rect.height <= 0) return false;
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  return right > 0 && bottom > 0 && rect.left < viewport.width && rect.top < viewport.height;
}

export type BubblePlacement = "below" | "above";

export interface BubbleLayout {
  left: number;
  top: number;
  placement: BubblePlacement;
  /** 말풍선 좌측 기준 화살표 x — 대상 중심을 가리킨다(말풍선 안으로 clamp). */
  arrowLeft: number;
}

export interface BubbleLayoutOptions {
  /** 화면 가장자리 여백. */
  margin?: number;
  /** 대상과 말풍선 사이 간격. */
  gap?: number;
  /** 화살표가 말풍선 모서리에 붙지 않도록 하는 최소 인셋. */
  arrowInset?: number;
}

function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(Math.max(v, lo), hi);
}

/**
 * 말풍선 위치 계산 (뷰포트 좌표, position:fixed 용).
 * - 기본은 대상 아래. 아래 공간이 부족하고 위가 더 넓으면 위로 뒤집는다.
 * - 좌우는 대상 중심 정렬 후 화면 안으로 clamp → **가로 오버플로 0**(AC-B2).
 * - 화살표는 대상 중심을 따라가되 말풍선 폭 안으로 clamp → 항상 대상을 가리킨다.
 */
export function computeBubbleLayout(
  target: Rect,
  viewport: Size,
  bubble: Size,
  options: BubbleLayoutOptions = {},
): BubbleLayout {
  const margin = options.margin ?? 8;
  const gap = options.gap ?? 12;
  const arrowInset = options.arrowInset ?? 16;

  const targetBottom = target.top + target.height;
  const spaceBelow = viewport.height - targetBottom - gap - margin;
  const spaceAbove = target.top - gap - margin;
  const placement: BubblePlacement =
    spaceBelow >= bubble.height || spaceBelow >= spaceAbove ? "below" : "above";

  const rawTop = placement === "below" ? targetBottom + gap : target.top - gap - bubble.height;
  const top = clamp(rawTop, margin, Math.max(margin, viewport.height - bubble.height - margin));

  const centerX = target.left + target.width / 2;
  const left = clamp(
    centerX - bubble.width / 2,
    margin,
    Math.max(margin, viewport.width - bubble.width - margin),
  );

  const arrowLeft = clamp(
    centerX - left,
    Math.min(arrowInset, bubble.width / 2),
    Math.max(bubble.width - arrowInset, bubble.width / 2),
  );

  return { left, top, placement, arrowLeft };
}

export interface TutorialDoneInputs {
  /**
   * 서버 값(`GET /api/me` → `user.tutorialDone`). **미발행**이라 지금은 대부분 undefined.
   * TODO(openapi-v3): p3srv 가 필드를 내면 이 값이 SoT 가 되고 로컬은 폴백으로만 남는다.
   */
  serverDone?: boolean | null;
  /** localStorage(userId 별) 값. */
  localDone: boolean;
}

/**
 * 완료 여부 = **서버 true 이거나 로컬 true**.
 *
 * ⚠️ 서버 `false` 는 로컬 `true` 를 덮지 않는다. 완료를 서버에 알리는 PATCH 가 아직 없어서
 * (tutorial-storage TODO(openapi-v3)) 서버는 "이 유저가 이미 끝냈다"는 사실을 **알 수가 없고**,
 * 그 상태에서 서버 false 를 신뢰하면 이미 완료한 유저 전원에게 재노출된다.
 * PATCH 가 붙어 서버가 진짜 SoT 가 되면 그때 서버 값을 단독 우선으로 되돌린다.
 */
export function resolveTutorialDone({ serverDone, localDone }: TutorialDoneInputs): boolean {
  return serverDone === true || localDone;
}

export interface StartInputs extends TutorialDoneInputs {
  /** 이번 세션에서 신규 가입/로그인(`isNew`) 신호를 받았는가. */
  pending: boolean;
}

/**
 * 자동 시작 여부.
 * - 이미 완료(서버 우선)면 절대 시작하지 않는다 → 재로그인해도 재노출 0 (AC-B1).
 * - 시작 트리거는 `isNew`(pending) **또는** 서버가 명시적으로 tutorialDone=false 를 준 경우.
 *   (서버 필드 미발행 상태에서 기존 유저에게 튀어나오지 않도록 undefined 는 트리거가 아니다.)
 */
export function shouldStartTutorial({ serverDone, localDone, pending }: StartInputs): boolean {
  if (resolveTutorialDone({ serverDone, localDone })) return false;
  return pending || serverDone === false;
}
