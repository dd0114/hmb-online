// 재생 컨트롤 모드 판정 — 순수 로직만(React/DOM 의존 0, 단위검증 대상). #148
//
// 문제(hero): 경기 진행 화면에 컨트롤이 너무 많아 "게임이 아니라 녹화본 보는 느낌".
// 해법: 컨트롤을 **관객용(play)** 과 **검수용(full)** 두 모드로 가른다.
//   - play : 업계 표준(FM/FIFA) — 진행 위주. 재생/일시정지 + 배속 몇 단계뿐.
//            되감기·프레임 점프·타임라인 스크럽·배율(zoom)·디버그 토글은 **숨김**.
//   - full : 뷰어(QA dev-viewer) 자체 컨트롤 전부 노출 — admin 계정(#119) 또는 QA 플래그.
//
// 판정 우선순위: QA 오버라이드(쿼리 > localStorage) > 계정(admin ? full : play).

export type ControlMode = "play" | "full";

/** 플레이 모드에서 제공하는 배속 단계(진행 방향만 — 슬로우/되감기 없음). */
export const PLAY_SPEEDS = [1, 2, 4] as const;
export type PlaySpeed = (typeof PLAY_SPEEDS)[number];

/** QA 오버라이드 쿼리 키 (`?viewerControls=full|play`, 단축 `?qa=1`). */
export const CONTROL_MODE_PARAM = "viewerControls";
/** QA 오버라이드 localStorage 키(세션 간 유지용 — 값은 쿼리와 동일 어휘). */
export const CONTROL_MODE_STORAGE_KEY = "hmb.viewerControls";

/** 뷰어로 보낼 배속인지(화이트리스트 밖 값은 브리지로 흘리지 않는다). */
export function isPlaySpeed(v: unknown): v is PlaySpeed {
  return typeof v === "number" && (PLAY_SPEEDS as readonly number[]).includes(v);
}

/** 저장된 QA 오버라이드를 지우는 값들(`?viewerControls=reset`) — 고착 해제용 탈출구. */
const RESET_VALUES = ["reset", "off", "clear", "default"];

/** `?viewerControls=reset` 처럼 저장된 오버라이드를 지우라는 요청인가. */
export function isControlModeReset(input: string | null | undefined): boolean {
  if (!input) return false;
  const params = new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
  const v = (params.get(CONTROL_MODE_PARAM) ?? "").trim().toLowerCase();
  return RESET_VALUES.includes(v);
}

function normalize(raw: string | null | undefined): ControlMode | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "full" || v === "qa" || v === "admin" || v === "debug") return "full";
  if (v === "play" || v === "simple") return "play";
  return null;
}

/**
 * 오버라이드 파싱. 입력은 `location.search`(쿼리) 또는 저장값(단일 토큰) 둘 다 받는다.
 * 알 수 없는 값은 null — 오타가 조용히 컨트롤을 열지 않게(안전한 기본 = 계정 기준).
 */
export function parseControlOverride(input: string | null | undefined): ControlMode | null {
  if (!input) return null;
  if (!input.includes("=") && !input.startsWith("?")) return normalize(input);
  const params = new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
  const explicit = normalize(params.get(CONTROL_MODE_PARAM));
  if (explicit) return explicit;
  const qa = params.get("qa");
  if (qa === "1" || qa === "true") return "full";
  return null;
}

export interface ControlModeInput {
  /** /api/me 의 isAdmin (#119). */
  isAdmin: boolean;
  /** location.search. */
  search: string | null | undefined;
  /** localStorage 저장 오버라이드(없으면 null). */
  stored: string | null | undefined;
}

/** 이 사용자에게 보일 초기 컨트롤 모드. reset 요청이면 저장값을 무시한다. */
export function resolveControlMode({ isAdmin, search, stored }: ControlModeInput): ControlMode {
  const saved = isControlModeReset(search) ? null : parseControlOverride(stored);
  return parseControlOverride(search) ?? saved ?? (isAdmin ? "full" : "play");
}

/**
 * 모드 전환 토글 노출 자격. admin 계정이거나 QA 가 명시적으로 full 을 켠 경우만.
 * (일반 유저가 URL 로 play 를 적었다고 자격이 생기진 않는다 — 노출 확대 금지.)
 */
export function canSwitchControlMode({ isAdmin, search, stored }: ControlModeInput): boolean {
  if (isAdmin) return true;
  if (parseControlOverride(search) === "full") return true;
  return !isControlModeReset(search) && parseControlOverride(stored) === "full";
}
