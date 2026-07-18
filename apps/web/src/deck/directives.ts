/**
 * Player-sheet directive catalog (AC-B4) — the "formal tactics" layer that sits above the
 * free "감독의 한마디" prompt. Chips are pre-defined phrases that map to the servants' 지시
 * 카탈로그 6종 (마킹·오버랩·침투·롱볼·압박·템포, p2-servants #95 / P2-D6). Selecting chips
 * synthesizes natural-language directive text which is prepended to the free prompt and sent
 * as the player's promptText (the prompt string stays the SoT — chips are an input aid).
 */

export interface DirectiveChip {
  id: string;
  label: string;
  /** natural-language fragment appended to the synthesized directive sentence */
  phrase: string;
}

/** 6 directive chips aligned 1:1 with the servants directive catalog. */
export const DIRECTIVE_CHIPS: DirectiveChip[] = [
  { id: "marking", label: "마킹", phrase: "상대 핵심 선수를 밀착 마크한다" },
  { id: "overlap", label: "오버랩", phrase: "측면에서 적극적으로 오버랩해 폭을 넓힌다" },
  { id: "runbehind", label: "침투", phrase: "수비 뒷공간으로 침투하는 움직임을 우선한다" },
  { id: "longball", label: "롱볼", phrase: "전방으로 빠른 롱볼 전개를 노린다" },
  { id: "press", label: "압박", phrase: "높은 위치에서 강하게 압박한다" },
  { id: "tempo", label: "템포", phrase: "점유율을 지키며 템포를 조율한다" },
];

export interface RoleOption {
  id: string;
  label: string;
  phrase: string;
}

/** Duty/role select — familiar football roles that bias the player's involvement. */
export const ROLE_OPTIONS: RoleOption[] = [
  { id: "balanced", label: "밸런스", phrase: "" },
  { id: "attack", label: "공격 가담", phrase: "공격 가담을 늘려 전진한다" },
  { id: "defend", label: "수비 안정", phrase: "수비에 집중해 위치를 지킨다" },
  { id: "support", label: "연결고리", phrase: "공수 연결고리 역할로 볼을 배급한다" },
];

export const DEFAULT_ROLE = "balanced";

export interface DirectiveState {
  role: string;
  chipIds: string[];
}

export function emptyDirectiveState(): DirectiveState {
  return { role: DEFAULT_ROLE, chipIds: [] };
}

export function toggleChip(state: DirectiveState, chipId: string): DirectiveState {
  const has = state.chipIds.includes(chipId);
  return {
    ...state,
    chipIds: has ? state.chipIds.filter((c) => c !== chipId) : [...state.chipIds, chipId],
  };
}

/**
 * Synthesize the directive layer into a single sentence group. Order: role phrase first,
 * then chips in catalog order (stable regardless of selection order). Empty phrases skipped.
 */
export function synthesizeDirectiveText(state: DirectiveState): string {
  const parts: string[] = [];
  const role = ROLE_OPTIONS.find((r) => r.id === state.role);
  if (role?.phrase) parts.push(role.phrase);
  for (const chip of DIRECTIVE_CHIPS) {
    if (state.chipIds.includes(chip.id)) parts.push(chip.phrase);
  }
  return parts.map((p) => (p.endsWith(".") ? p : `${p}.`)).join(" ");
}

/**
 * Compose the full player prompt = directive layer + free "감독의 한마디".
 * Both layers are visible separately in the UI but sent as one promptText string.
 */
export function composePrompt(state: DirectiveState, freeText: string): string {
  const directive = synthesizeDirectiveText(state);
  const free = freeText.trim();
  if (directive && free) return `${directive}\n${free}`;
  return directive || free;
}
