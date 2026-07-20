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
  /**
   * **추론된** 항목 키(`role:<id>` / `chip:<id>`) — 저장된 promptText 를 되짚어(parseDirectiveText)
   * 켠 것들이며, 사용자가 이번 세션에 직접 누른 게 아니다.
   *
   * 왜 필요한가(#106 R3a m1): 저장 포맷은 단일 문자열이라 "칩에서 합성된 문장"과 "사용자가 우연히
   * 똑같이 쓴 문장"이 **글자 단위로 구별 불가능**하다. 그래서 추론된 항목을 끌 때는 사라지는 문장을
   * 되돌릴 수 있게 UI 에 넘긴다 — 유저 문장이 **소리 없이** 사라지지 않게 하는 유일한 방법이다.
   * 전송값에는 영향이 없다(synthesize/compose 는 이 필드를 보지 않는다).
   */
  inferred?: string[];
}

export function emptyDirectiveState(): DirectiveState {
  return { role: DEFAULT_ROLE, chipIds: [], inferred: [] };
}

export function toggleChip(state: DirectiveState, chipId: string): DirectiveState {
  return applyChipToggle(state, chipId).state;
}

export type DirectiveItemKind = "role" | "chip";

/** 추론 항목 키 — 상태 안에서 role/chip 을 한 목록으로 다룬다. */
export function itemKey(kind: DirectiveItemKind, id: string): string {
  return `${kind}:${id}`;
}

function phraseOf(kind: DirectiveItemKind, id: string): string {
  const src =
    kind === "role" ? ROLE_OPTIONS.find((r) => r.id === id) : DIRECTIVE_CHIPS.find((c) => c.id === id);
  return src?.phrase ?? "";
}

/** 편집 결과 + (있다면) 이 편집으로 프롬프트에서 **사라지는 추론된 문장**. */
export interface DirectiveEdit {
  state: DirectiveState;
  /**
   * 끄는 순간 프롬프트에서 없어지는데 **원래 사용자가 쓴 문장이었을 수도 있는** 문구.
   * null 이면 사용자가 이번 세션에 직접 켠 것이라 되돌릴 게 없다.
   */
  droppedInferred: string | null;
}

function withoutInferred(state: DirectiveState, key: string): string[] {
  return (state.inferred ?? []).filter((k) => k !== key);
}

/** 칩 토글 — 끄는 대상이 추론된 항목이면 그 문장을 함께 돌려준다(복구 제안용). */
export function applyChipToggle(state: DirectiveState, chipId: string): DirectiveEdit {
  const has = state.chipIds.includes(chipId);
  const key = itemKey("chip", chipId);
  if (!has) {
    // 켜는 건 손실이 없다. 사용자가 직접 켰으므로 추론 딱지도 뗀다.
    return {
      state: { ...state, chipIds: [...state.chipIds, chipId], inferred: withoutInferred(state, key) },
      droppedInferred: null,
    };
  }
  const wasInferred = (state.inferred ?? []).includes(key);
  return {
    state: {
      ...state,
      chipIds: state.chipIds.filter((c) => c !== chipId),
      inferred: withoutInferred(state, key),
    },
    droppedInferred: wasInferred ? phraseOf("chip", chipId) || null : null,
  };
}

/** 역할 변경 — 이전 역할이 추론된 것이었다면 사라지는 그 문장을 돌려준다. */
export function applyRole(state: DirectiveState, roleId: string): DirectiveEdit {
  if (state.role === roleId) return { state, droppedInferred: null };
  const prevKey = itemKey("role", state.role);
  const wasInferred = (state.inferred ?? []).includes(prevKey);
  return {
    state: {
      ...state,
      role: roleId,
      // 이전 역할(사라짐)도, 새로 고른 역할(직접 고름)도 더는 추론 항목이 아니다.
      inferred: (state.inferred ?? []).filter((k) => k !== prevKey && k !== itemKey("role", roleId)),
    },
    droppedInferred: wasInferred ? phraseOf("role", state.role) || null : null,
  };
}

/**
 * 사라질 뻔한 문장을 **내가 쓴 문장(감독의 한마디)** 맨 앞줄로 되돌린다.
 * 합성문과 같은 표기(마침표)로 넣어 화면·전송 문자열이 원래 프롬프트와 같은 문장 집합을 유지한다.
 */
export function restoreSentence(freeText: string, phrase: string): string {
  const line = phrase.trim().endsWith(".") ? phrase.trim() : `${phrase.trim()}.`;
  return [line, freeText.trim()].filter(Boolean).join("\n");
}

/**
 * ── 편집 = **손실 없는 레이어 이동** (R3a 재검증 blocker-2) ────────────────────────────────
 *
 * 처음엔 "끄면 사라지고, 배너로 되돌릴 기회를 준다"로 만들었는데 배너가 소비되지 않는 경로
 * (연속 해제로 덮어씀 / 레일 닫고 복귀)에서 문장이 영구 소실됐다. **보고**가 아니라 **손실 자체**를
 * 없앤다: 추론된 항목을 끄면 그 문장을 즉시 **감독의 한마디로 옮긴다**. 배너는 안내일 뿐이라
 * 놓치거나 덮여도 데이터가 사라지지 않는다(원치 않으면 사용자가 지우면 되는, 되돌릴 수 있는 방향).
 */
export interface DirectiveEditResult {
  state: DirectiveState;
  freeText: string;
  /** 감독의 한마디로 **옮겨진** 문장(안내용). null 이면 옮긴 게 없다. */
  moved: string | null;
}

function withRestore(edit: DirectiveEdit, freeText: string): DirectiveEditResult {
  if (!edit.droppedInferred) return { state: edit.state, freeText, moved: null };
  return {
    state: edit.state,
    freeText: restoreSentence(freeText, edit.droppedInferred),
    moved: edit.droppedInferred,
  };
}

/** 칩 토글 — 추론 항목을 끄면 그 문장이 자유 문장으로 이동한다(소실 없음). */
export function toggleChipSafely(
  state: DirectiveState,
  freeText: string,
  chipId: string,
): DirectiveEditResult {
  return withRestore(applyChipToggle(state, chipId), freeText);
}

/** 역할 변경 — 밀려나는 추론 역할 문장이 자유 문장으로 이동한다(소실 없음). */
export function setRoleSafely(
  state: DirectiveState,
  freeText: string,
  roleId: string,
): DirectiveEditResult {
  return withRestore(applyRole(state, roleId), freeText);
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
 * ⚠️ **왕복 검증**(R3a 재검증 blocker-1): 문구를 하나씩 되짚는 것만으로는 부족하다. 같은 문구가
 * 두 번 나오거나(`"압박한다. 압박한다."`) 역할이 둘이거나(`"공격…. 수비…."`) 카탈로그 순서가
 * 아니면, 되짚은 상태를 다시 합성했을 때 **원문보다 짧아진다** — 그 차이만큼 유저 문장이
 * 로드 시점에 조용히 소멸했다(토글 전이라 복구 경로도 못 탄다). 그래서 되짚은 상태를 **다시
 * 합성해 원문 첫 줄과 글자 단위로 같을 때만** 지시 레이어로 인정하고, 아니면 그 줄 전체를 자유
 * 문장으로 둔다 → 파싱 단계 손실이 **구조적으로 0**.
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
  const inferred: string[] = [];
  for (const part of parts) {
    const hit = index.get(part);
    if (!hit) return { state: emptyDirectiveState(), freeText: raw }; // 하나라도 모르면 자유 문장
    if (hit.kind === "role") state.role = hit.id;
    else if (!state.chipIds.includes(hit.id)) state.chipIds.push(hit.id);
    // 이 항목이 "칩에서 온 문장"인지 "사용자가 우연히 똑같이 쓴 문장"인지는 문자열만으로 알 수 없다.
    // 그래서 전부 **추론**으로 표시해 두고, 끌 때 문장을 되돌릴 기회를 준다(#106 R3a m1).
    if (!inferred.includes(itemKey(hit.kind, hit.id))) inferred.push(itemKey(hit.kind, hit.id));
  }
  // 되짚은 상태를 다시 합성해 **원문 첫 줄과 완전히 같아야만** 지시로 인정한다.
  // (중복 문구·역할 2개·비카탈로그 순서 = 재구성 불가 → 그 줄은 유저가 쓴 문장으로 남긴다.)
  if (synthesizeDirectiveText({ ...state, inferred: [] }) !== head) {
    return { state: emptyDirectiveState(), freeText: raw };
  }
  return { state: { ...state, inferred }, freeText: rest.trim() };
}
