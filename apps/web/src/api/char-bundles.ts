/**
 * 유닛 아트 번들 운영 API 계약 (#309 W2).
 *
 * **무엇을 푸나**: 유닛 *등록*은 이미 무배포였다(#207 파트 A). 남은 배포 의존은 **아트**였다 —
 * 아틀라스·카드 PNG, 매니페스트 3종, player-chars 매핑이 전부 웹 빌드에 구워져 있어서 새 유닛에
 * 그림을 붙이려면 웹을 다시 배포해야 했다.
 *
 * ⚠️ **파일 단위가 아니라 통짜 zip 이다.** 셋은 서로를 참조하므로(매니페스트가 아틀라스 타일
 * 좌표를, 매핑이 유닛 id 를 가리킨다) 파일별로 올리면 "매니페스트는 새것, PNG 는 옛것"인 중간
 * 상태가 생기고, 그때 화면은 **깨진 그림이 아니라 좌표가 어긋난 그림**을 그린다.
 *
 * ⚠️ **삭제가 없다.** 리비전은 쌓이고 활성 포인터만 옮긴다. 전부 끄면 web 이 구운 폴백으로
 * 돌아간다 = 아트 배포 이전 상태 (#309 W1 D9 와 같은 철학 — 되돌릴 것이 항상 있어야 한다).
 */

export const ADMIN_CHAR_BUNDLES_PATH = "/api/admin/chars/bundles";
export const ADMIN_CHAR_BUNDLES_HISTORY_PATH = "/api/admin/chars/bundles/history";

/** 업로드된 리비전 한 건. */
export interface CharBundleRow {
  id: string;
  fileCount: number;
  byteSize: number;
  /** 매니페스트에서 서버가 뽑은 요약(유닛 수·매핑 버전 등) — 켜기 전에 확인하라고 있는 값. */
  summary: Record<string, unknown>;
  note: string | null;
  active: boolean;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface CharBundleListResponse {
  bundles: CharBundleRow[];
  /** 지금 서빙 중인 리비전. `null` 이면 **구운 폴백 중**(= 아트 배포 이전 상태). */
  activeRevision: string | null;
  /** 보관소 경로(운영 진단 — 어디에 쌓이는지 운영자가 알아야 한다). */
  storageRoot?: string | null;
}

/** `revisionId` 가 비어 있으면 **전부 끈다** = 구운 폴백으로 롤백. */
export interface CharBundleActivateRequest {
  revisionId: string | null;
  reason: string;
}
