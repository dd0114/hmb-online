/**
 * 관전 화면 셸의 순수 상태 로직 (P4-E1 S1, #169).
 * 설계 = docs/plan-v5/layout-game-screen.md §2·§3.
 *
 * 두 종류의 패널을 구분한다 — 이 구분이 "기본은 경기장면만"(AC-W1-1)을 지키는 핵심이다.
 *  · **토글 패널**(stats/log/brief): 유저 소유. 기본 off, localStorage 로 기억.
 *  · **상태 패널**(halftime/result): 매치 상태 소유. 유저가 지금 해야 하는 일(교체·후반시작·결과확인)
 *    이라 상태가 되면 자동으로 열린다. 토글 3개는 이때도 여전히 off.
 */

export type ToggleKey = "stats" | "log" | "brief";
export type StatePanelKey = "halftime" | "result";
export type TabKey = ToggleKey | StatePanelKey;

export const TOGGLE_KEYS: readonly ToggleKey[] = ["stats", "log", "brief"];

export type Toggles = Record<ToggleKey, boolean>;

/** 기본 = 경기장면만(AC-W1-1). */
export const DEFAULT_TOGGLES: Toggles = { stats: false, log: false, brief: false };

export const TOGGLE_STORAGE_KEY = "hmb.stage.toggles";

export const TAB_LABELS: Record<TabKey, string> = {
  stats: "📊 통계",
  log: "📜 로그",
  brief: "📝 후반 지시",
  halftime: "🧑‍🏫 감독",
  result: "🏆 결과",
};

/** 저장값 파싱 — 손상/구버전/부분 저장 전부 기본값으로 흡수(화면이 깨지지 않게). */
export function parseToggles(raw: string | null | undefined): Toggles {
  if (!raw) return { ...DEFAULT_TOGGLES };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_TOGGLES };
    const rec = parsed as Record<string, unknown>;
    const out = { ...DEFAULT_TOGGLES };
    for (const k of TOGGLE_KEYS) if (typeof rec[k] === "boolean") out[k] = rec[k];
    return out;
  } catch {
    return { ...DEFAULT_TOGGLES };
  }
}

export function serializeToggles(t: Toggles): string {
  return JSON.stringify({ stats: t.stats, log: t.log, brief: t.brief });
}

/** 매치 상태가 소유하는 패널(없으면 null). */
export function statePanelFor(state: string | undefined): StatePanelKey | null {
  if (state === "H1_BREAK") return "halftime";
  if (state === "FINISHED") return "result";
  return null;
}

/** 이 상태에서 무대가 재생할 하프. */
export function halfForState(state: string | undefined): 1 | 2 {
  return state === "FINISHED" ? 2 : 1;
}

/**
 * 시트에 뜰 탭 목록. 상태 패널이 먼저(유저가 해야 할 일), 그 뒤 켜진 토글이 고정 순서로.
 * 빈 배열이면 시트 자체가 없다(무대만).
 */
export function tabsFor(toggles: Toggles, statePanel: StatePanelKey | null): TabKey[] {
  const tabs: TabKey[] = [];
  if (statePanel) tabs.push(statePanel);
  for (const k of TOGGLE_KEYS) if (toggles[k]) tabs.push(k);
  return tabs;
}

/**
 * 활성 탭 결정 — 유저가 고른 탭이 아직 살아 있으면 유지, 아니면 첫 탭(=상태 패널 우선).
 * 탭이 없으면 null.
 */
export function resolveActiveTab(tabs: readonly TabKey[], preferred: TabKey | null): TabKey | null {
  if (tabs.length === 0) return null;
  if (preferred && tabs.includes(preferred)) return preferred;
  return tabs[0] ?? null;
}

/**
 * 시트 높이 등급 — **콘텐츠와 무관**하다(내용이 쌓여도 높이가 안 변한다). 탭 종류로만 갈린다:
 *  · info(통계·로그·후반지시) = 낮게 → 무대를 크게 본다(관전이 주목적).
 *  · state(감독·결과) = 높게 → 실제로 조작해야 하는 폼/표라 볼 게 많다.
 * 실제 픽셀은 CSS 가 정한다(데스크탑만 구분, 모바일은 무대가 폭으로 정해져 남는 높이를 시트가 가짐).
 */
export function sheetHeight(tab: TabKey | null): "info" | "state" | null {
  if (!tab) return null;
  return tab === "halftime" || tab === "result" ? "state" : "info";
}
