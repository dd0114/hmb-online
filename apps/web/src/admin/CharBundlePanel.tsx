import { useRef, useState } from "react";
import {
  useAdminCharBundleHistory,
  useAdminCharBundles,
  useCharBundleOps,
} from "../api/char-bundle-hooks";
import type { CharBundleRow } from "../api/char-bundles";
import { formatStamp } from "./admin-logic";
import {
  activateWarning,
  activeArtSummary,
  activeRevisionOf,
  normalizeCharBundleRows,
  summaryLine,
} from "./char-bundle-logic";
import { formatAssetSize, noticeOpErrorMessage } from "./notice-admin-logic";
import styles from "./AdminPage.module.css";
import n from "./NoticesPanel.module.css";

/**
 * 유닛 아트 운영 패널 (#309 W2) — 번들 업로드 · 리비전 목록 · 활성 전환(롤백 포함).
 *
 * **여기서 하는 일이 "재배포 없이 아트 교체"의 전부다.** 로컬 파이프라인이 만든 `/chars` 트리를
 * zip 으로 올리고, 확인한 뒤 켠다. 잘못됐으면 이전 리비전으로 옮기거나 전부 꺼서 **웹 빌드에
 * 구운 기본 아트**로 되돌린다.
 *
 * ⚠️ **삭제 버튼이 없다**(공지 이미지와 같은 철학) — 되돌릴 것이 항상 있어야 한다.
 */
export function CharBundlePanel() {
  const list = useAdminCharBundles();
  const history = useAdminCharBundleHistory();
  const { upload, setActive } = useCharBundleOps();

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const rows = normalizeCharBundleRows(list.data);
  const activeRevision = activeRevisionOf(list.data);
  const entries = Array.isArray(history.data) ? history.data : [];
  const busy = upload.isPending || setActive.isPending;

  function fail(err: unknown, fallback: string) {
    setError(noticeOpErrorMessage(err, fallback));
    setNotice(null);
  }

  function done(message: string) {
    setNotice(message);
    setError(null);
  }

  function onPickFile(file: File | null) {
    if (!file) return;
    const why = window.prompt("업로드 사유를 입력하세요(이력에 남습니다)", `${file.name} 업로드`);
    if (!why || !why.trim()) {
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    const note = window.prompt("메모(어느 파이프라인 산출물인가 — 비워도 됩니다)") ?? "";
    upload.mutate(
      { file, note, reason: why.trim() },
      {
        // 업로드는 **켜지 않는다** — 요약을 확인한 뒤 켜는 것이 이 화면의 흐름이다.
        onSuccess: () => done("번들을 올렸습니다 — 요약을 확인한 뒤 [이 리비전 켜기] 를 누르세요"),
        onError: (err) => fail(err, "번들 업로드에 실패했습니다"),
        onSettled: () => {
          if (fileInput.current) fileInput.current.value = "";
        },
      },
    );
  }

  function activate(target: CharBundleRow | null) {
    if (!window.confirm(activateWarning(target))) return;
    const why = window.prompt(target ? "적용 사유(이력에 남습니다)" : "롤백 사유(이력에 남습니다)");
    if (!why || !why.trim()) return;
    setActive.mutate(
      { revisionId: target?.id ?? null, reason: why.trim() },
      {
        onSuccess: () =>
          done(
            target
              ? "적용했습니다 — 유저 브라우저는 새로고침 뒤 새 아트를 봅니다"
              : "구운 기본 아트로 되돌렸습니다",
          ),
        onError: (err) => fail(err, "적용에 실패했습니다"),
      },
    );
  }

  return (
    <section className={styles.panel} data-testid="admin-chars-panel">
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>유닛 아트</h2>
      </div>

      {/* 무엇이 지금 나가고 있는가 — "올렸는데 왜 안 바뀌지"의 답이 여기 있어야 한다. */}
      <p className={styles.muted} data-testid="admin-chars-active">
        {activeArtSummary(activeRevision)}
      </p>

      <div className={n.uploadRow}>
        <button
          type="button"
          className={n.mini}
          data-testid="admin-chars-pick"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {upload.isPending ? "올리는 중…" : "번들(zip) 업로드"}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          hidden
          data-testid="admin-chars-input"
          onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
        />
        {activeRevision && (
          <button
            type="button"
            className={n.mini}
            data-testid="admin-chars-rollback"
            disabled={busy}
            onClick={() => activate(null)}
          >
            구운 기본 아트로 되돌리기
          </button>
        )}
      </div>

      <p className={styles.muted}>
        로컬 아트 파이프라인 산출물(<code>/chars</code> 트리)을 <b>통짜 zip</b> 으로 올립니다 —
        매니페스트·아틀라스·매핑이 서로를 참조하므로 파일 단위로 올리면 좌표가 어긋난 그림이 나옵니다.
        업로드는 <b>켜지 않습니다</b>; 요약을 확인한 뒤 적용하세요.
      </p>

      {list.isLoading && <p className={styles.muted}>불러오는 중…</p>}
      {!list.isLoading && rows.length === 0 && (
        <p className={styles.muted} data-testid="admin-chars-empty">
          올라온 번들이 없습니다 — 구운 기본 아트로 서비스 중입니다
        </p>
      )}

      {rows.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="admin-chars-table">
            <thead>
              <tr>
                <th>리비전</th>
                <th>요약</th>
                <th>파일</th>
                <th>크기</th>
                <th>올린 시각</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`admin-chars-row-${row.id}`}>
                  <td className={styles.nowrap}>
                    <span
                      className={`${n.pill} ${row.active ? n.live : n.off}`}
                      data-testid={`admin-chars-state-${row.id}`}
                      data-active={row.active ? "1" : "0"}
                    >
                      {row.active ? "서빙중" : "대기"}
                    </span>{" "}
                    {row.id}
                  </td>
                  <td data-testid={`admin-chars-summary-${row.id}`}>
                    {summaryLine(row.summary)}
                    {row.note ? ` — ${row.note}` : ""}
                  </td>
                  <td className={styles.num}>{row.fileCount}</td>
                  <td className={styles.nowrap}>{formatAssetSize(row.byteSize)}</td>
                  <td className={styles.nowrap}>{formatStamp(row.createdAt ?? "")}</td>
                  <td className={styles.nowrap}>
                    {!row.active && (
                      <button
                        type="button"
                        className={n.mini}
                        data-testid={`admin-chars-activate-${row.id}`}
                        disabled={busy}
                        onClick={() => activate(row)}
                      >
                        이 리비전 켜기
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {notice && (
        <p className={styles.notice} data-testid="admin-chars-notice">
          {notice}
        </p>
      )}
      {error && (
        <p className={styles.error} data-testid="admin-chars-error">
          {error}
        </p>
      )}

      <h3 className={styles.subTitle}>변경 이력</h3>
      {entries.length === 0 ? (
        <p className={styles.muted} data-testid="admin-chars-history-empty">
          변경 이력이 없습니다
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="admin-chars-history">
            <thead>
              <tr>
                <th>시각</th>
                <th>액터</th>
                <th>액션</th>
                <th>결과</th>
                <th>사유</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} data-testid={`admin-chars-history-${entry.result}`}>
                  <td className={styles.nowrap}>{formatStamp(entry.createdAt)}</td>
                  <td className={styles.nowrap}>{entry.actor}</td>
                  <td>{entry.action}</td>
                  {/* 실패도 숨기지 않는다 — 시도 자체가 이력이다(V18 정책). */}
                  <td className={entry.result === "ok" ? undefined : styles.error}>{entry.result}</td>
                  <td>{entry.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
