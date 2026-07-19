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
 * 두 레이어를 한 번에 계산한다 — **미리보기와 전송 문자열의 유일한 출처**(#106 R2).
 *
 * A안의 핵심 전달물은 `AI에 전달될 지시문` 블록이 "칩에서 합성된 문장 + 내가 쓴 문장"을 **구분해**
 * 보여주는 것이다. 미리보기와 실제 전송값이 다른 순간 A안은 거짓말이 되므로, UI 는 이 함수가 준
 * `directiveText`/`ownText` 만 그리고 서버로는 같은 호출의 `text` 를 보낸다.
 *
 * 불변식: `[directiveText, ownText].filter(Boolean).join("\n") === text` (directives.test.ts 가 박제).
 */
export interface ComposedPrompt {
  /** 역할·칩에서 합성된 문장(= "선택지에서") */
  directiveText: string;
  /** 감독의 한마디(= "내가 쓴 문장"), 앞뒤 공백 제거 후 */
  ownText: string;
  /** 서버로 전송되는 최종 promptText */
  text: string;
}

export function composeLayers(state: DirectiveState, freeText: string): ComposedPrompt {
  const directiveText = synthesizeDirectiveText(state);
  const ownText = freeText.trim();
  const text = [directiveText, ownText].filter(Boolean).join("\n");
  return { directiveText, ownText, text };
}

/**
 * Compose the full player prompt = directive layer + free "감독의 한마디".
 * Both layers are visible separately in the UI but sent as one promptText string.
 */
export function composePrompt(state: DirectiveState, freeText: string): string {
  return composeLayers(state, freeText).text;
}

export interface ParsedPrompt {
  state: DirectiveState;
  freeText: string;
}

/** 카탈로그 문구 → (role|chip) 역인덱스. 문구는 고정 상수라 결정론적으로 되짚을 수 있다. */
function phraseIndex(): Map<string, { kind: "role" | "chip"; id: string }> {
  const map = new Map<string, { kind: "role" | "chip"; id: string }>();
  for (const r of ROLE_OPTIONS) if (r.phrase) map.set(r.phrase, { kind: "role", id: r.id });
  for (const c of DIRECTIVE_CHIPS) map.set(c.phrase, { kind: "chip", id: c.id });
  return map;
}

/**
 * 영속된 promptText 를 두 레이어로 되돌린다(재진입/새로고침 시 레일 복원용).
 *
 * 이게 없으면 저장된 프롬프트가 통째로 "내가 쓴 문장"으로 들어가, 칩을 하나만 눌러도 합성문이
 * **중복 누적**된다(미리보기 ≠ 실제 전송의 주 원인). 첫 줄이 카탈로그 문구들로 **완전히** 설명될
 * 때만 지시 레이어로 인정하고, 아니면 전부 자유 문장으로 둔다(보수적).
 *
 * 왕복 보장: `parseDirectiveText(composePrompt(s, f))` → 같은 s(정규화)·f. 반대로 사용자가 우연히
 * 카탈로그 문구와 똑같이 써도 `composePrompt` 결과 문자열은 동일하므로 **전송값은 변하지 않는다**.
 */
export function parseDirectiveText(promptText: string | null | undefined): ParsedPrompt {
  const raw = (promptText ?? "").trim();
  if (!raw) return { state: emptyDirectiveState(), freeText: "" };

  const nl = raw.indexOf("\n");
  const head = (nl === -1 ? raw : raw.slice(0, nl)).trim();
  const rest = nl === -1 ? "" : raw.slice(nl + 1);

  const index = phraseIndex();
  const fragments = head.split(".").map((s) => s.trim());
  // 합성문은 항상 "…." 로 끝나므로 마지막 조각은 빈 문자열이어야 한다.
  if (fragments.length < 2 || fragments[fragments.length - 1] !== "") {
    return { state: emptyDirectiveState(), freeText: raw };
  }
  const parts = fragments.slice(0, -1);

  const state = emptyDirectiveState();
  for (const part of parts) {
    const hit = index.get(part);
    if (!hit) return { state: emptyDirectiveState(), freeText: raw }; // 하나라도 모르면 자유 문장
    if (hit.kind === "role") state.role = hit.id;
    else if (!state.chipIds.includes(hit.id)) state.chipIds.push(hit.id);
  }
  return { state, freeText: rest.trim() };
}
