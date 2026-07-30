/**
 * 우편함 **순수 로직** (#323). 화면(`MailCenter`)은 이 값을 그리기만 한다.
 *
 * 여기 있는 규칙은 딱 둘이다:
 *  1. **서버 응답 형태를 믿지 않는다** — 구 서버·프록시의 200 `{}` 하나가 홈 헤더를 죽이지 못하게.
 *  2. **상태를 다시 계산하지 않는다** — 만료 판정은 서버 값(`state`)을 그대로 옮긴다.
 *     화면이 `expiresAt < now` 를 계산하면 **기기 시계가 진실**이 된다(폰 시계가 하루 빠른 유저에게
 *     멀쩡한 보상이 만료로 보인다). 공지(`notice-logic.ts`)가 남긴 규율과 같다.
 */
import type { Mail, MailAttachments, MailState } from "../api/mails";

const STATES: MailState[] = ["UNREAD", "READ", "CLAIMED", "EXPIRED"];

export interface MailsView {
  mails: Mail[];
  /** 뱃지 수 — **서버 값**이다. 목록에서 세지 않는다(목록 상한 밖의 우편물이 조용히 빠진다). */
  unread: number;
}

function normalizeAttachments(raw: unknown): MailAttachments {
  const a = (raw ?? {}) as Partial<MailAttachments>;
  return {
    points: typeof a.points === "number" ? a.points : 0,
    gems: typeof a.gems === "number" ? a.gems : 0,
    players: Array.isArray(a.players)
      ? a.players.filter(
          (p): p is { playerId: string; count: number } =>
            Boolean(p) && typeof p.playerId === "string" && typeof p.count === "number",
        )
      : [],
  };
}

/**
 * 원시 응답 → 그릴 수 있는 값. **모르는 상태는 버리지 않고 UNREAD 로도 만들지 않는다** —
 * 서버가 상태를 하나 늘렸을 때 화면이 그것을 "안 읽음"으로 오해하면 뱃지와 목록이 어긋난다.
 * 알 수 없는 값은 그대로 두고(문자열), 표시만 중립으로 떨어진다.
 */
export function normalizeMails(raw: unknown): MailsView {
  const data = (raw ?? {}) as { mails?: unknown; unread?: unknown };
  const list = Array.isArray(data.mails) ? data.mails : [];
  const mails = list
    .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
    .filter((m) => typeof m.id === "string")
    .map((m) => ({
      id: m.id as string,
      title: typeof m.title === "string" ? m.title : "",
      body: typeof m.body === "string" ? m.body : "",
      attachments: normalizeAttachments(m.attachments),
      sentAt: typeof m.sentAt === "string" ? m.sentAt : "",
      expiresAt: typeof m.expiresAt === "string" ? m.expiresAt : null,
      readAt: typeof m.readAt === "string" ? m.readAt : null,
      claimedAt: typeof m.claimedAt === "string" ? m.claimedAt : null,
      state: typeof m.state === "string" ? m.state : "READ",
    }));
  return {
    mails,
    unread: typeof data.unread === "number" && data.unread > 0 ? data.unread : 0,
  };
}

export function hasAttachments(a: MailAttachments): boolean {
  return a.points > 0 || a.gems > 0 || a.players.length > 0;
}

/** 받을 수 있는가 — 서버 상태만 본다(기간 재계산 금지). */
export function canClaim(mail: Mail): boolean {
  return mail.state !== "CLAIMED" && mail.state !== "EXPIRED" && hasAttachments(mail.attachments);
}

export function isKnownState(state: string): state is MailState {
  return (STATES as string[]).includes(state);
}

/**
 * 목록 행에 붙는 상태 라벨. **만료도 목록에 남는다**(hero 확정 ④) — 놓쳤다는 사실이 보여야
 * 다음엔 안 놓친다. 그 대신 뱃지에는 세지 않으므로(서버 `unread`) 끌 수 없는 숫자는 남지 않는다.
 */
export function stateLabel(mail: Mail): string | null {
  switch (mail.state) {
    case "CLAIMED":
      return "수령 완료";
    case "EXPIRED":
      return "만료됨 — 수령 기간이 지났습니다";
    default:
      return hasAttachments(mail.attachments) ? "받기" : null;
  }
}

/**
 * 첨부를 그릴 조각으로 편다. <b>여기서 심볼을 조립하지 않는다</b> — 재화 표기는 서버 config 가
 * SoT 이고(#232) 화면은 `<Amount code=… value=… />` 로만 그린다. 문자열을 만들어 돌려주면
 * 다음 사람이 `${n} P` 를 적게 되고, 그게 30군데가 됐던 경위다.
 */
export type AttachmentChip =
  | { key: string; kind: "points" | "gems"; value: number }
  | { key: string; kind: "player"; playerId: string; count: number };

export function attachmentChips(a: MailAttachments): AttachmentChip[] {
  const chips: AttachmentChip[] = [];
  if (a.points > 0) {
    chips.push({ key: "points", kind: "points", value: a.points });
  }
  if (a.gems > 0) {
    chips.push({ key: "gems", kind: "gems", value: a.gems });
  }
  for (const p of a.players) {
    chips.push({ key: `player:${p.playerId}`, kind: "player", playerId: p.playerId, count: p.count });
  }
  return chips;
}

/** 보낸 시각 한 줄. 값이 없으면 문장을 지어내지 않는다(조각을 뺀다). */
export function sentLine(mail: Mail): string {
  const bits: string[] = ["운영팀"];
  if (mail.sentAt) {
    bits.push(mail.sentAt.slice(0, 10));
  }
  return bits.join(" · ");
}
