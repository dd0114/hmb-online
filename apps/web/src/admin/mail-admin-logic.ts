/**
 * 우편 발송 운영 **순수 로직** (#323 W4). 화면(`MailsPanel`)은 이 값을 그리기만 한다.
 *
 * 여기 있는 규칙의 요점 하나: **폼이 서버 검증을 흉내내지 않는다.** 상한·카탈로그 실재는 서버가
 * SoT 이고(`hmb.mail.*`, players 표) 클라가 같은 숫자를 적으면 두 곳이 갈라진다 — 여기서 막는 것은
 * **되돌릴 수 없는 오조작의 형태**(대상 미지정·사유 누락·숫자가 아닌 입력)뿐이고, 나머지는 서버
 * 4xx 문구를 그대로 보여준다.
 */

export interface MailFormValues {
  audience: "ALL" | "USERS";
  /** 줄바꿈·쉼표로 구분한 유저 id. audience=USERS 일 때만 쓴다. */
  userIds: string;
  title: string;
  body: string;
  points: string;
  gems: string;
  /** "P001:2, P010" 형태. 개수 생략 = 1장. */
  players: string;
  /** 비우면 무기한(hero 확정 ③). */
  expiresInDays: string;
  reason: string;
}

export const EMPTY_MAIL_FORM: MailFormValues = {
  audience: "USERS",
  userIds: "",
  title: "",
  body: "",
  points: "",
  gems: "",
  players: "",
  expiresInDays: "",
  reason: "",
};

export function parseUserIds(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface PlayerGrantInput {
  playerId: string;
  count: number;
}

/** "P001:2, P010" → [{P001,2},{P010,1}]. 형식이 깨진 조각은 `null`(호출부가 오류로 만든다). */
export function parsePlayers(raw: string): PlayerGrantInput[] | null {
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: PlayerGrantInput[] = [];
  for (const part of parts) {
    const [id, countRaw] = part.split(":");
    if (!id) return null;
    const count = countRaw === undefined ? 1 : Number(countRaw);
    if (!Number.isInteger(count) || count <= 0) return null;
    out.push({ playerId: id, count });
  }
  return out;
}

function parseAmount(raw: string): number | null {
  if (raw.trim() === "") return 0;
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

export interface MailFormValidation {
  ok: boolean;
  /** 필드별 첫 오류. 없으면 undefined. */
  errors: Partial<Record<keyof MailFormValues, string>>;
}

export function validateMailForm(form: MailFormValues): MailFormValidation {
  const errors: MailFormValidation["errors"] = {};

  if (!form.title.trim()) errors.title = "제목은 필수입니다";
  if (!form.body.trim()) errors.body = "본문은 필수입니다";
  if (!form.reason.trim()) errors.reason = "운영 사유는 필수입니다(감사 원장에 남습니다)";

  if (form.audience === "USERS" && parseUserIds(form.userIds).length === 0) {
    errors.userIds = "대상 유저 id 를 한 명 이상 넣으세요";
  }
  if (parseAmount(form.points) === null) errors.points = "0 이상의 정수만 넣으세요";
  if (parseAmount(form.gems) === null) errors.gems = "0 이상의 정수만 넣으세요";
  if (parsePlayers(form.players) === null) errors.players = "형식: P001:2, P010 (개수 생략 = 1장)";
  if (form.expiresInDays.trim() !== "") {
    const d = Number(form.expiresInDays);
    if (!Number.isInteger(d) || d <= 0) errors.expiresInDays = "1 이상의 정수이거나 비워 두세요(무기한)";
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

export interface MailSendRequestBody {
  audience: "ALL" | "USERS";
  userIds?: string[];
  title: string;
  body: string;
  attachments: { points: number; gems: number; players: PlayerGrantInput[] };
  expiresInDays?: number;
  reason: string;
}

/** 폼 → 서버 바디. **검증을 통과한 폼만** 넣는다(그렇지 않으면 던진다 — 조용히 0을 보내지 않는다). */
export function toSendBody(form: MailFormValues): MailSendRequestBody {
  const points = parseAmount(form.points);
  const gems = parseAmount(form.gems);
  const players = parsePlayers(form.players);
  if (points === null || gems === null || players === null) {
    throw new Error("검증되지 않은 폼으로 발송 바디를 만들 수 없습니다");
  }
  const body: MailSendRequestBody = {
    audience: form.audience,
    title: form.title.trim(),
    body: form.body,
    attachments: { points, gems, players },
    reason: form.reason.trim(),
  };
  if (form.audience === "USERS") body.userIds = parseUserIds(form.userIds);
  // ⚠️ 빈 문자열을 0 으로 보내지 않는다 — 서버는 `expiresInDays >= 1` 만 받고, 없으면 **무기한**이다.
  if (form.expiresInDays.trim() !== "") body.expiresInDays = Number(form.expiresInDays);
  return body;
}

/**
 * 한 번 더 물어야 하는 발송인가. 전체 발송은 물론이고 **지정 발송도 다수면** 오타의 대가가 같다
 * (독립검증 m10). 임계는 화면이 아니라 여기 하나 — 바꿀 때 두 곳을 고치게 두지 않는다.
 */
export const CONFIRM_TARGET_THRESHOLD = 10;

export function needsConfirm(form: MailFormValues): boolean {
  if (form.audience === "ALL") return true;
  return parseUserIds(form.userIds).length >= CONFIRM_TARGET_THRESHOLD;
}

/** 대상이 몇 명인지 — [보내기] 옆에 붙는 확인 문구용. ALL 은 서버만 아는 수라 null. */
export function targetSummary(form: MailFormValues): { label: string; count: number | null } {
  if (form.audience === "ALL") {
    return { label: "전체 유저(발송 시점 기준)", count: null };
  }
  const n = parseUserIds(form.userIds).length;
  return { label: `지정 ${n}명`, count: n };
}

export interface AdminMailCampaignRow {
  id: string;
  audience: string;
  title: string;
  body: string;
  attachments: { points: number; gems: number; players: { playerId: string; count: number }[] };
  expiresAt: string | null;
  revokedAt: string | null;
  targetCount: number;
  claimedCount: number;
  readCount: number;
  reason: string;
  actor: string;
  createdAt: string;
}

/** 서버 응답을 그대로 믿지 않는다 — 여기서 던지면 admin 페이지 전체가 흰 화면이 된다. */
export function normalizeCampaigns(raw: unknown): AdminMailCampaignRow[] {
  const data = (raw ?? {}) as { campaigns?: unknown };
  const list = Array.isArray(data.campaigns) ? data.campaigns : [];
  return list
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
    .filter((c) => typeof c.id === "string")
    .map((c) => {
      const att = (c.attachments ?? {}) as Record<string, unknown>;
      return {
        id: c.id as string,
        audience: typeof c.audience === "string" ? c.audience : "",
        title: typeof c.title === "string" ? c.title : "",
        body: typeof c.body === "string" ? c.body : "",
        attachments: {
          points: typeof att.points === "number" ? att.points : 0,
          gems: typeof att.gems === "number" ? att.gems : 0,
          players: Array.isArray(att.players)
            ? (att.players as { playerId: string; count: number }[])
            : [],
        },
        expiresAt: typeof c.expiresAt === "string" ? c.expiresAt : null,
        revokedAt: typeof c.revokedAt === "string" ? c.revokedAt : null,
        targetCount: typeof c.targetCount === "number" ? c.targetCount : 0,
        claimedCount: typeof c.claimedCount === "number" ? c.claimedCount : 0,
        readCount: typeof c.readCount === "number" ? c.readCount : 0,
        reason: typeof c.reason === "string" ? c.reason : "",
        actor: typeof c.actor === "string" ? c.actor : "",
        createdAt: typeof c.createdAt === "string" ? c.createdAt : "",
      };
    });
}

/** 수령률 한 줄 — 0명 대상일 때 NaN% 를 만들지 않는다. */
export function claimRateText(row: AdminMailCampaignRow): string {
  if (row.targetCount === 0) return "대상 0명";
  const pct = Math.round((row.claimedCount / row.targetCount) * 100);
  return `${row.claimedCount}/${row.targetCount}명 수령 (${pct}%)`;
}

/**
 * 발송 실패 문구. 서버가 준 message 를 **그대로** 쓴다 — 409(같은 키 다른 내용)·400(상한·없는 유저)
 * 모두 서버 문구가 복구 경로를 담고 있다. 클라가 지어내면 그 정보가 사라진다.
 */
export function mailOpErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
