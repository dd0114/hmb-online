/**
 * 유닛 아트 번들 훅 (#309 W2). 공지 이미지 훅과 같은 규율 —
 * **성공·실패 모두**(`onSettled`) 캐시를 턴다(실패가 화면에서 사라지면 원장의 의미가 없다).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { useToken } from "../auth/TokenContext";
import {
  ADMIN_CHAR_BUNDLES_HISTORY_PATH,
  ADMIN_CHAR_BUNDLES_PATH,
  type CharBundleListResponse,
} from "./char-bundles";
import type { AdminNoticeAuditEntry } from "./notices";

export function useAdminCharBundles(enabled: boolean = true) {
  const { token } = useToken();
  return useQuery<CharBundleListResponse>({
    queryKey: ["admin", "chars", "bundles"],
    queryFn: () => apiFetch<CharBundleListResponse>(ADMIN_CHAR_BUNDLES_PATH),
    enabled: Boolean(token) && enabled,
  });
}

/** 이력은 공지와 같은 원장(V18)이라 같은 행 모양을 쓴다. */
export function useAdminCharBundleHistory(enabled: boolean = true) {
  const { token } = useToken();
  return useQuery<AdminNoticeAuditEntry[]>({
    queryKey: ["admin", "chars", "bundles", "history"],
    queryFn: () => apiFetch<AdminNoticeAuditEntry[]>(ADMIN_CHAR_BUNDLES_HISTORY_PATH),
    enabled: Boolean(token) && enabled,
  });
}

export function useCharBundleOps() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
  };

  /** zip 업로드 — **활성화하지 않는다**(올리는 것과 켜는 것은 별개). */
  const upload = useMutation({
    mutationFn: ({ file, note, reason }: { file: File; note: string; reason: string }) => {
      // FormData — apiFetch 가 감지해 Content-Type 을 설정하지 않는다(boundary 는 브라우저가 붙인다).
      const form = new FormData();
      form.append("file", file);
      const query = `?reason=${encodeURIComponent(reason)}&note=${encodeURIComponent(note)}`;
      return apiFetch<unknown>(`${ADMIN_CHAR_BUNDLES_PATH}${query}`, { method: "POST", body: form });
    },
    onSettled: invalidate,
  });

  /**
   * 활성 리비전 전환. `revisionId: null` = **전부 끄기**(구운 폴백으로 롤백).
   *
   * ⚠️ 아트가 바뀌면 이미 로드된 에셋 캐시가 낡는다 — 그래서 성공 시 **새로고침을 안내**하는 건
   * 화면 몫이고, 여기서는 서버 상태만 다시 읽는다(모듈 싱글턴 캐시를 훅이 건드리지 않는다).
   */
  const setActive = useMutation({
    mutationFn: ({ revisionId, reason }: { revisionId: string | null; reason: string }) =>
      apiFetch<unknown>(`${ADMIN_CHAR_BUNDLES_PATH}/active`, {
        method: "POST",
        body: { revisionId, reason },
      }),
    onSettled: invalidate,
  });

  return { upload, setActive };
}
