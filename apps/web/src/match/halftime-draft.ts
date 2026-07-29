import type { DeckDraft } from "../deck/deck-logic";

/**
 * 후반 지시 **미리작성 초안** (#284).
 *
 * ── 왜 2층인가 (로컬 초안 + 서버 저장) ──────────────────────────────────────────────────────
 * 후반 지시는 `POST /matches/{id}/prompts{phase:halftime}` 로 서버에 저장되고, **후반에 반영되는
 * 권위는 서버**가 갖는다. 그런데 **읽는 API 가 없다** — `MatchDetail` 에 저장된 프롬프트 필드가
 * 없어서(#253 이 남긴 것과 같은 구멍) 화면이 "내가 뭘 적었더라"를 서버에서 되읽을 수 없다.
 * 그래서 화면 복원용 사본을 로컬에 둔다. 서버가 읽기를 열어주면 이 층을 갈아끼우면 된다.
 *
 * ⚠️ 로컬 사본이라 **기기 간 이어쓰기는 안 된다**(폰에서 적고 데스크탑에서 감독시간을 열면 칸이
 * 비어 보인다). 그래도 **후반 반영은 된다** — 서버에는 이미 저장돼 있기 때문이다. 화면이 비어
 * 보이는 것과 지시가 사라진 것은 다르다.
 *
 * ── 왜 `sent` 를 따로 들고 있나 ─────────────────────────────────────────────────────────────
 * 감독시간 [후반 시작] 은 화면의 문장을 서버로 보낸다. 전반에 이미 자동 저장된 12개(팀+선수 11)를
 * 매번 다시 보내면 **순차 POST 12번**이 [후반 시작] 앞에 붙는다. `sent` 와 비교해 **달라진 것만**
 * 보내면 보통 0~2건이다. 값이 같은 재전송은 서버 UPSERT 라 무해하지만, 느린 건 무해하지 않다.
 *
 * ── 서버가 빈 문자열을 거부한다 (알려진 한계) ──────────────────────────────────────────────
 * `MatchService` 가 `text.isBlank()` 를 400 으로 막는다 → 한 번 저장한 지시를 **완전히 지우는 것은
 * 불가능**하고 덮어쓰기만 된다. 그래서 `pendingSaves` 는 빈 문장을 후보에서 뺀다(보내봐야 400).
 * 화면이 그 사실을 말해야 한다 — 조용히 버리면 "지웠는데 후반에 그대로 나온다"가 된다.
 */

/** 한쪽 면(현재 문장 / 서버에 올라간 문장). key = playerId, 팀은 별도 필드. */
export interface DraftSide {
  team: string;
  players: Record<string, string>;
}

export interface HalftimeDraft {
  /** 지금 화면에 있는 문장. */
  cur: DraftSide;
  /** 서버 저장에 성공한 문장 — 이것과 같으면 다시 보내지 않는다. */
  sent: DraftSide;
}

/** 저장 대상 — `null` = 팀 전체, 문자열 = 그 선수. */
export type PromptTarget = string | null;

export const HALFTIME_DRAFT_KEY_PREFIX = "hmb.match.halftime-draft.";

export function halftimeDraftKey(matchId: string): string {
  return `${HALFTIME_DRAFT_KEY_PREFIX}${matchId}`;
}

const emptySide = (): DraftSide => ({ team: "", players: {} });

export function emptyHalftimeDraft(): HalftimeDraft {
  return { cur: emptySide(), sent: emptySide() };
}

/** 손상·구버전·부분 저장을 전부 빈 초안으로 흡수한다(화면이 깨지지 않게 — parseToggles 선례). */
export function parseHalftimeDraft(raw: string | null | undefined): HalftimeDraft {
  if (!raw) return emptyHalftimeDraft();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyHalftimeDraft();
    const rec = parsed as Record<string, unknown>;
    return { cur: parseSide(rec.cur), sent: parseSide(rec.sent) };
  } catch {
    return emptyHalftimeDraft();
  }
}

function parseSide(raw: unknown): DraftSide {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptySide();
  const rec = raw as Record<string, unknown>;
  const team = typeof rec.team === "string" ? rec.team : "";
  const players: Record<string, string> = {};
  const p = rec.players;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    for (const [id, text] of Object.entries(p as Record<string, unknown>)) {
      if (typeof text === "string") players[id] = text;
    }
  }
  return { team, players };
}

export function serializeHalftimeDraft(d: HalftimeDraft): string {
  return JSON.stringify({ cur: d.cur, sent: d.sent });
}

export function draftTextOf(d: HalftimeDraft, target: PromptTarget): string {
  return target === null ? d.cur.team : (d.cur.players[target] ?? "");
}

export function sentTextOf(d: HalftimeDraft, target: PromptTarget): string {
  return target === null ? d.sent.team : (d.sent.players[target] ?? "");
}

function withSide(side: DraftSide, target: PromptTarget, text: string): DraftSide {
  return target === null
    ? { ...side, team: text }
    : { ...side, players: { ...side.players, [target]: text } };
}

/** 타이핑 반영(현재 문장만 갱신 — 저장 성공은 `withSent` 가 기록한다). */
export function withDraftText(d: HalftimeDraft, target: PromptTarget, text: string): HalftimeDraft {
  return { ...d, cur: withSide(d.cur, target, text) };
}

/** 서버 저장 성공 기록. */
export function withSent(d: HalftimeDraft, target: PromptTarget, text: string): HalftimeDraft {
  return { ...d, sent: withSide(d.sent, target, text) };
}

/**
 * 아직 서버에 안 올라간 것들. 빈 문장은 **후보가 아니다**(서버 400 — 위 헤더 참조).
 * 팀이 먼저, 선수는 안정적인 순서(키 정렬)로 — 순서가 흔들리면 계약이 흔들린다.
 */
export function pendingSaves(d: HalftimeDraft): { target: PromptTarget; text: string }[] {
  const out: { target: PromptTarget; text: string }[] = [];
  const push = (target: PromptTarget) => {
    const text = draftTextOf(d, target).trim();
    if (!text) return;
    if (text === sentTextOf(d, target).trim()) return;
    out.push({ target, text });
  };
  push(null);
  for (const id of Object.keys(d.cur.players).sort()) push(id);
  return out;
}

/**
 * 저장했다가 **지운** 대상 — 서버에 값이 남아 있는데 화면은 비어 있다. 되돌릴 수단이 없으므로
 * 화면이 그 사실을 말해야 한다(조용히 넘어가면 "지웠는데 후반에 그대로 나온다"가 된다).
 */
export function clearedAfterSave(d: HalftimeDraft): PromptTarget[] {
  const out: PromptTarget[] = [];
  const check = (target: PromptTarget) => {
    if (!draftTextOf(d, target).trim() && sentTextOf(d, target).trim()) out.push(target);
  };
  check(null);
  for (const id of Object.keys(d.sent.players).sort()) check(id);
  return out;
}

/** 무언가 적힌 대상인가 — 칩의 점 표시·요약 카운트가 이걸 본다. */
export function hasText(d: HalftimeDraft, target: PromptTarget): boolean {
  return draftTextOf(d, target).trim().length > 0;
}

/** 적어둔 선수 수(팀은 별도) — "적어둠 — 팀 + 선수 2명" 문구용. */
export function writtenPlayerCount(d: HalftimeDraft): number {
  return Object.keys(d.cur.players).filter((id) => hasText(d, id)).length;
}

/**
 * "어디까지 적었나" 한 줄. 저장 버튼이 없는 화면이라 이 문장이 **유일한 진행 표시**다 —
 * 아무것도 안 적었을 때 침묵하면 유저는 이 자리가 되는 자리인지조차 모른다.
 */
export function writtenSummary(d: HalftimeDraft): string {
  const team = hasText(d, null);
  const players = writtenPlayerCount(d);
  if (!team && players === 0) return "적으면 자동으로 저장됩니다";
  const parts = [team ? "팀" : null, players > 0 ? `선수 ${players}명` : null].filter(Boolean);
  return `적어둠 — ${parts.join(" + ")}`;
}

/**
 * 감독시간 에디터 초기값에 초안을 얹는다 (#284 프리필).
 *
 * ⚠️ 슬롯이 아니라 **playerId** 로 맞춘다 — #276 이 감독시간에 자리 바꾸기·포메이션 변경을 열었으므로
 * 슬롯 인덱스는 움직인다. 사람에게 한 말이 자리를 따라가면 안 된다.
 */
export function applyDraftPrompts(base: DeckDraft, d: HalftimeDraft): DeckDraft {
  return {
    ...base,
    slots: base.slots.map((s) => {
      const text = d.cur.players[s.playerId]?.trim();
      return text ? { ...s, promptText: d.cur.players[s.playerId]! } : s;
    }),
  };
}

// ── 저장소 (localStorage 접근 실패는 전부 삼킨다 — 사파리 프라이빗 모드 등) ──────────────

export function readHalftimeDraft(matchId: string): HalftimeDraft {
  try {
    return parseHalftimeDraft(window.localStorage?.getItem(halftimeDraftKey(matchId)));
  } catch {
    return emptyHalftimeDraft();
  }
}

export function writeHalftimeDraft(matchId: string, d: HalftimeDraft): void {
  try {
    window.localStorage?.setItem(halftimeDraftKey(matchId), serializeHalftimeDraft(d));
  } catch {
    // 저장 실패는 이번 세션 화면 상태만 잃는다 — 서버 저장(권위)은 그대로 진행된다.
  }
}
