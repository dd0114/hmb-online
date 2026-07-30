/**
 * 공지사항 API 계약 (#248). 서버 SoT = 이슈 #248 §2 (server-java 가 openapi 를 발행하면 생성 타입으로 교체).
 *
 * 별도 파일로 둔 이유 = `p3.ts` 는 여러 세션이 만지는 공용 계약 파일이라 새 표면을 격리한다
 * (admin-hooks.ts 가 같은 이유로 분리돼 있다).
 */

/** 유저 조회 — **인증 불필요(공개)**. 서버가 기간·활성·삭제로 걸러 정렬까지 마쳐서 준다. */
export const NOTICES_ACTIVE_PATH = "/api/notices/active";

/**
 * 단건 조회 — **인증 불필요(공개)**, 공유 딥링크가 쓴다(#297/#298).
 *
 * 상태별 코드는 서버가 판정한다: LIVE 200 / EXPIRED·OFF **410** / SCHEDULED·DELETED·없는id **404**.
 * ⚠️ 화면이 기간을 다시 계산해 만료를 판정하면 **기기 시계가 진실이 된다**(notice-logic.ts 머리말과
 * 같은 이유) — 410/404 는 받아서 문구로 옮기기만 한다.
 */
export function noticeByIdPath(id: string): string {
  return `/api/notices/${encodeURIComponent(id)}`;
}

export const ADMIN_NOTICES_PATH = "/api/admin/notices";
export const ADMIN_NOTICES_HISTORY_PATH = "/api/admin/notices/history";
/** 공지 이미지 업로드·목록·노출 스위치 (#309 W1). **삭제 경로는 없다**(아래 참조). */
export const ADMIN_NOTICE_ASSETS_PATH = "/api/admin/notices/assets";

/** 목록 한 행 — `status` 는 **서버가 판정**한다(화면이 active × 기간을 다시 합치지 않는다). */
export type AdminNoticeStatus = "LIVE" | "SCHEDULED" | "OFF" | "EXPIRED" | "DELETED";

export interface AdminNoticeRow {
  id: string;
  title: string;
  body: string;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
  priority: number;
  revision: number;
  status: AdminNoticeStatus | string;
  createdAt?: string | null;
  updatedAt?: string | null;
  deletedAt?: string | null;
}

export interface AdminNoticeListResponse {
  notices: AdminNoticeRow[];
}

/** 생성·수정이 공유하는 내용 필드. 시각은 **오프셋을 포함한 ISO-8601**(서버가 없으면 400). */
interface NoticeContentFields {
  title: string;
  body: string;
  startsAt: string | null;
  endsAt: string | null;
  priority: number;
  /** 필수 — 성공·실패 모두 `admin_ops_audit` 에 남는다. */
  reason: string;
}

/** 생성 — `active`(초기 노출 여부)는 **여기서만** 의미가 있다. */
export interface NoticeCreateRequest extends NoticeContentFields {
  active: boolean;
}

/**
 * 수정 — `active` 가 **타입에 없다**.
 *
 * ⚠️ 서버는 수정 바디에 `active` 가 실려 오면 **400 으로 거절**한다("전체 치환인데 한 필드만 조용히
 * 무시"가 최악의 비대칭이라, 무시 대신 명시적 거부를 택했다). 노출 전환은 전용 엔드포인트
 * (`POST /api/admin/notices/{id}/active`) 몫이다.
 *
 * `active?: never` 는 장식이 아니라 **컴파일 가드**다 — 생성 바디(`active: boolean`)를 실수로 수정에
 * 넘기면 타입이 막는다. 한 타입에 optional 로 두면 다음 사람이 같은 실수를 반복하고, 그때 증상은
 * "운영자가 오탈자를 영영 못 고친다"로 나타난다(#248 blocker-1 이 정확히 그것이었다).
 */
export interface NoticeUpdateRequest extends NoticeContentFields {
  active?: never;
}

export interface NoticeActiveRequest {
  active: boolean;
  reason: string;
}

/**
 * 업로드된 공지 이미지 한 건 (#309 W1).
 *
 * ⚠️ `url` 은 **상대경로**(`/api/notices/assets/{id}`)다 — 절대 URL 이 아니다. 백엔드가 터널 뒤라
 * 주소가 바뀌므로, 본문에 절대 URL 을 굽는 순간 과거 공지 이미지가 전부 깨진다. 화면에 그릴 때는
 * `resolveNoticeUrl`(`common/notice-asset-url.ts`)을 통과시켜라.
 *
 * ⚠️ **삭제 필드도 삭제 API 도 없다**(hero 확정 2026-07-30). 내리기는 `active` 스위치로만 —
 * 삭제는 오조작이 곧 영구 소실이고 참조하던 공지의 그림을 되살릴 방법이 없다.
 */
export interface AdminNoticeAssetRow {
  id: string;
  /** 본문에 붙일 상대경로. 서버가 만든다(클라가 조립하지 않는다). */
  url: string;
  originalName: string | null;
  contentType: string;
  byteSize: number;
  active: boolean;
  /** 이 그림을 본문에서 참조하는 **살아 있는 공지 수**. 노출을 끄기 전 경고의 근거. */
  usedBy: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface AdminNoticeAssetListResponse {
  assets: AdminNoticeAssetRow[];
}

/** `admin_ops_audit` 한 줄(economy 이력과 같은 모양 — V18 범용 테이블). */
export interface AdminNoticeAuditEntry {
  id: string;
  actor: string;
  action: string;
  result: string;
  reason: string | null;
  detailJson?: string | null;
  createdAt: string;
}
