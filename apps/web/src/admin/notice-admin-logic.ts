/**
 * 공지 운영 패널의 **순수 로직** (#248) — 정규화·표시 문구·폼 검증.
 *
 * 규율은 economy 패널(#209)과 같다:
 *  - **서버 응답을 그대로 믿지 않는다.** 이 패널은 admin 페이지 안에 있어서 여기서 던지면
 *    페이지 전체가 흰 화면이 된다(구버전 서버·부분 실패에서 `{}` 가 실제로 온다).
 *  - **서버만 아는 판정을 흉내 내지 않는다.** 노출 상태(LIVE/SCHEDULED/OFF/EXPIRED/DELETED)는
 *    서버가 `active` × 기간 × 삭제를 합쳐 준 값을 **그대로 표시**한다 — 화면이 다시 계산하면
 *    규칙이 바뀔 때 조용히 어긋난다(#217 원칙).
 *  여기서 보는 것은 **형태**뿐이다.
 */
import { ApiError } from "../api/client";
import type {
  AdminNoticeRow,
  NoticeCreateRequest,
  NoticeUpdateRequest,
} from "../api/notices";

export const NOTICE_TITLE_MAX = 100;
export const NOTICE_BODY_MAX = 2000;
/**
 * 서버 검증(`AdminNoticeService`)의 미러. **숫자가 서버와 어긋나면 미러가 아니라 거짓말**이 된다.
 * 여기 값이 느슨하면 운영자는 왕복 한 번을 하고 나서야 400 을 본다(m3).
 */
export const NOTICE_REASON_MAX = 500;
export const NOTICE_PRIORITY_MIN = -1000;
export const NOTICE_PRIORITY_MAX = 1000;

/** 목록 응답 → 행 배열. `{notices:[…]}` 도 맨 배열도 받고, 아니면 빈 배열. */
export function normalizeNoticeRows(raw: unknown): AdminNoticeRow[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { notices?: unknown }).notices)
      ? ((raw as { notices: unknown[] }).notices)
      : null;
  if (!list) return [];
  const out: AdminNoticeRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const n = item as Record<string, unknown>;
    const id = typeof n.id === "string" ? n.id : "";
    if (!id) continue;
    out.push({
      id,
      title: typeof n.title === "string" ? n.title : "",
      body: typeof n.body === "string" ? n.body : "",
      startsAt: typeof n.startsAt === "string" ? n.startsAt : null,
      endsAt: typeof n.endsAt === "string" ? n.endsAt : null,
      active: n.active !== false,
      priority: typeof n.priority === "number" ? n.priority : 0,
      revision: typeof n.revision === "number" ? n.revision : 1,
      // 서버가 상태를 안 주면 **추측하지 않는다** — 빈 값이 "모른다"를 정직하게 드러낸다.
      status: typeof n.status === "string" ? n.status : "",
      createdAt: typeof n.createdAt === "string" ? n.createdAt : null,
      updatedAt: typeof n.updatedAt === "string" ? n.updatedAt : null,
      deletedAt: typeof n.deletedAt === "string" ? n.deletedAt : null,
    });
  }
  return out;
}

/** 상태 뱃지 문구 — 서버 판정값의 번역일 뿐, 재계산이 아니다. */
export function noticeStatusLabel(status: string): string {
  switch (status) {
    case "LIVE":
      return "노출중";
    case "SCHEDULED":
      return "예약";
    case "OFF":
      return "중지";
    case "EXPIRED":
      return "만료";
    case "DELETED":
      return "삭제됨";
    default:
      return status || "알 수 없음";
  }
}

/** 뱃지 색 계열(CSS 클래스 키). 모르는 상태는 중립. */
export function noticeStatusTone(status: string): "live" | "sched" | "off" | "gone" {
  switch (status) {
    case "LIVE":
      return "live";
    case "SCHEDULED":
      return "sched";
    case "EXPIRED":
    case "DELETED":
      return "gone";
    default:
      return "off";
  }
}

/** 감사 이력 액션의 사람 읽는 문구. */
export function noticeActionLabel(action: string): string {
  switch (action) {
    case "notice_create":
      return "공지 생성";
    case "notice_update":
      return "공지 수정";
    case "notice_active":
      return "노출 전환";
    case "notice_delete":
      return "공지 삭제";
    default:
      return action;
  }
}

/** "07-29 → 07-31" · 비어 있으면 즉시/무기한. */
export function formatNoticeWindow(startsAt: string | null, endsAt: string | null): string {
  const day = (iso: string | null, fallback: string) => {
    if (!iso) return fallback;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  return `${day(startsAt, "즉시")} → ${day(endsAt, "무기한")}`;
}

/** ISO → `<input type="datetime-local">` 값(로컬 시각). 없으면 빈 문자열. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `<input type="datetime-local">` 값 → ISO(UTC). 비었으면 null(= 즉시/무기한). */
export function fromLocalInput(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

export interface NoticeFormValues {
  title: string;
  body: string;
  /** datetime-local 문자열(빈 값 허용). */
  startsAt: string;
  endsAt: string;
  priority: string;
  active: boolean;
  reason: string;
}

export interface NoticeFormValidation {
  valid: boolean;
  error: string | null;
  /**
   * 생성 바디 — `active` 포함.
   *
   * ⚠️ **수정에 이걸 쓰면 안 된다.** 서버는 수정 바디의 `active` 를 400 으로 거절한다. 하나의
   * payload 를 두 경로가 공유하던 것이 #248 blocker-1 이었고(운영자가 오탈자를 못 고쳤다),
   * 그래서 여기서부터 둘로 갈라 둔다 — 타입이 오용을 막는다.
   */
  createPayload: NoticeCreateRequest | null;
  /** 수정 바디 — `active` 가 **없다**. */
  updatePayload: NoticeUpdateRequest | null;
}

/**
 * 폼 검증 — 서버 검증(400)의 **형태 미러**. 왕복을 아끼려는 게 아니라 운영자가 무엇이 잘못됐는지
 * 그 자리에서 알게 하려는 것이다. 데이터 판정(중복·참조 등)은 서버 몫으로 남긴다.
 */
export function validateNoticeForm(v: NoticeFormValues): NoticeFormValidation {
  const invalid = (error: string): NoticeFormValidation => ({
    valid: false,
    error,
    createPayload: null,
    updatePayload: null,
  });

  const title = v.title.trim();
  const body = v.body.trim();
  if (!title) return invalid("제목은 필수입니다");
  if (title.length > NOTICE_TITLE_MAX) return invalid(`제목은 ${NOTICE_TITLE_MAX}자 이하여야 합니다`);
  if (!body) return invalid("본문은 필수입니다");
  if (body.length > NOTICE_BODY_MAX) return invalid(`본문은 ${NOTICE_BODY_MAX}자 이하여야 합니다`);

  if (v.startsAt.trim() && Number.isNaN(Date.parse(v.startsAt.trim()))) {
    return invalid("시작 시각 형식이 올바르지 않습니다");
  }
  if (v.endsAt.trim() && Number.isNaN(Date.parse(v.endsAt.trim()))) {
    return invalid("종료 시각 형식이 올바르지 않습니다");
  }
  const startsAt = fromLocalInput(v.startsAt);
  const endsAt = fromLocalInput(v.endsAt);
  if (startsAt && endsAt && Date.parse(startsAt) >= Date.parse(endsAt)) {
    return invalid("종료 시각은 시작 시각보다 뒤여야 합니다");
  }

  const priority = Number(v.priority.trim() === "" ? "0" : v.priority);
  if (!Number.isInteger(priority)) return invalid("우선순위는 정수여야 합니다");
  if (priority < NOTICE_PRIORITY_MIN || priority > NOTICE_PRIORITY_MAX) {
    return invalid(`우선순위는 ${NOTICE_PRIORITY_MIN} ~ ${NOTICE_PRIORITY_MAX} 사이여야 합니다`);
  }

  const reason = v.reason.trim();
  if (!reason) return invalid("사유는 필수입니다(변경 이력에 남습니다)");
  if (reason.length > NOTICE_REASON_MAX) {
    return invalid(`사유는 ${NOTICE_REASON_MAX}자 이하여야 합니다`);
  }

  const content = { title, body, startsAt, endsAt, priority, reason };
  return {
    valid: true,
    error: null,
    createPayload: { ...content, active: v.active },
    // `active` 를 빼는 것이 아니라 **애초에 넣지 않는다** — 나중에 지우는 방식이면
    // 필드가 하나 늘 때마다 누락이 재발한다.
    updatePayload: content,
  };
}

/**
 * 운영 액션 실패 문구. **서버 메시지가 1순위**다 — 서버가 복구 경로까지 담아 주기 때문이다
 * (409 = "목록을 새로고침한 뒤 다시 시도하세요"). 여기서 문구를 새로 지어내면 그 안내가 사라진다.
 *
 * 상태코드별 폴백은 **서버가 메시지를 안 줬을 때만** 쓴다:
 *  - `409 CONFLICT` — 동시 수정에서 졌거나(revision CAS) 대상이 그 사이에 바뀌었다. 화면의 목록이
 *    낡았다는 신호라 재조회 후 재시도가 정답이다.
 *  - `404` — 이미 삭제된 공지다. 계속 눌러도 되살아나지 않으므로 목록을 다시 본다는 사실을 알린다.
 *
 * 두 경우 모두 호출부가 `onSettled` 로 캐시를 무효화하므로, 이 문구를 읽을 때 목록은 이미 갱신 중이다.
 */
export function noticeOpErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  const fromServer = (err.message ?? "").trim();
  if (fromServer) return fromServer;
  if (err.status === 409) {
    return "다른 운영자가 먼저 바꿨습니다 — 목록을 새로고침한 뒤 다시 시도하세요";
  }
  if (err.status === 404) {
    return "이미 삭제된 공지입니다 — 목록을 다시 불러왔습니다";
  }
  return fallback;
}

export const EMPTY_NOTICE_FORM: NoticeFormValues = {
  title: "",
  body: "",
  startsAt: "",
  endsAt: "",
  priority: "0",
  active: true,
  reason: "",
};

/** 수정 버튼 → 폼 초기값. 사유는 **매번 새로 받는다**(직전 사유가 재사용되면 원장이 거짓말한다). */
export function formFromRow(row: AdminNoticeRow): NoticeFormValues {
  return {
    title: row.title,
    body: row.body,
    startsAt: toLocalInput(row.startsAt),
    endsAt: toLocalInput(row.endsAt),
    priority: String(row.priority),
    active: row.active,
    reason: "",
  };
}
