/**
 * 우편함 API 계약 (#323). 서버 SoT = `docs/plan-v2/api/openapi.yaml` (tag `mails`) +
 * 설계 문서 `docs/plan-v5/mailbox.md`.
 *
 * 별도 파일로 둔 이유는 `notices.ts` 와 같다 — `p3.ts` 는 여러 세션이 만지는 공용 계약 파일이라
 * 새 표면을 격리한다.
 *
 * ⚠️ **공지와 달리 인증이 필요하다.** 공지는 유저 데이터가 0인 방송이라 공개지만, 우편함은
 * 정의상 내 것이다.
 */

export const MAILS_PATH = "/api/mails";

export function mailReadPath(id: string): string {
  return `/api/mails/${encodeURIComponent(id)}/read`;
}

export function mailClaimPath(id: string): string {
  return `/api/mails/${encodeURIComponent(id)}/claim`;
}

/**
 * 상태는 **서버가 판정한다**. 화면이 `expiresAt < now` 를 다시 계산하면 기기 시계가 진실이 되고
 * (폰 시계가 하루 빠른 유저에게 멀쩡한 보상이 만료로 보인다), 규칙이 바뀔 때 조용히 어긋난다 —
 * 공지(`notice-logic.ts` 머리말)가 남긴 규율과 같다.
 */
export type MailState = "UNREAD" | "READ" | "CLAIMED" | "EXPIRED";

export interface MailAttachments {
  points: number;
  gems: number;
  players: { playerId: string; count: number }[];
}

export interface Mail {
  id: string;
  title: string;
  body: string;
  attachments: MailAttachments;
  sentAt: string;
  expiresAt: string | null;
  readAt: string | null;
  claimedAt: string | null;
  state: MailState | string;
}

export interface MailListResponse {
  mails: Mail[];
  /** 뱃지 수 = 안 읽음 **또는** (첨부가 있는데 미수령). 만료·회수 제외. */
  unread: number;
}

/**
 * `GET /api/me` 에 실려 오는 요약 — 홈 헤더가 목록을 받지 않고도 그릴 수 있는 최소값.
 * `unread` = 뱃지 숫자, `total` = **진입점을 그릴지**(0 이면 헤더에 아무것도 안 그린다).
 */
export interface MeMailSummary {
  unread: number;
  total: number;
}

export interface MailClaimResult {
  id: string;
  claimed: boolean;
  /** false = 이미 수령한 우편물이라 아무것도 바뀌지 않았다(잔액은 현재값). */
  applied: boolean;
  granted: {
    points: number;
    gems: number;
    players: { playerId: string; count: number; isNew: boolean }[];
  };
  wallet: { points: number; gems: number };
}
