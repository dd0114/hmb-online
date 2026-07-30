import { useRef, useState } from "react";
import {
  useAdminNoticeAssets,
  useAdminNoticeHistory,
  useAdminNotices,
  useNoticeAssetOps,
  useNoticeOps,
} from "../api/notice-hooks";
import type { AdminNoticeAssetRow, AdminNoticeRow } from "../api/notices";
import { NoticeBody } from "../common/NoticeBody";
import { noticeAssetMarkup, resolveNoticeUrl } from "../common/notice-asset-url";
import { formatStamp } from "./admin-logic";
import {
  assetToggleWarning,
  EMPTY_NOTICE_FORM,
  formatAssetSize,
  formFromRow,
  formatNoticeWindow,
  NOTICE_PRIORITY_MAX,
  NOTICE_PRIORITY_MIN,
  NOTICE_REASON_MAX,
  noticeActionLabel,
  noticeOpErrorMessage,
  noticeStatusLabel,
  noticeStatusTone,
  normalizeNoticeAssetRows,
  normalizeNoticeRows,
  validateNoticeForm,
  type NoticeFormValues,
} from "./notice-admin-logic";
import styles from "./AdminPage.module.css";
import n from "./NoticesPanel.module.css";

/**
 * 공지 운영 패널 (#248) — 목록 · 작성/수정 · 변경 이력.
 *
 * economy(#209)와 다른 점 하나: **리로드 호출이 없다.** 공지는 발행물의 파생이 아니라 운영자가
 * 만드는 데이터 그 자체라 DB 에 쓰면 곧 다음 조회에 반영된다. 같은 점: admin 게이트 · **사유 필수** ·
 * **성공·실패 모두 이력** · 재배포 0.
 */
export function NoticesPanel() {
  const list = useAdminNotices();
  const history = useAdminNoticeHistory();
  const assetList = useAdminNoticeAssets();
  const { create, update, setActive, remove } = useNoticeOps();
  const { upload, setAssetActive } = useNoticeAssetOps();

  const [form, setForm] = useState<NoticeFormValues>(EMPTY_NOTICE_FORM);
  const [editing, setEditing] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // 서버 응답을 그대로 믿지 않는다 — 여기서 던지면 admin 페이지 전체가 흰 화면이 된다.
  const rows = normalizeNoticeRows(list.data);
  const assets = normalizeNoticeAssetRows(assetList.data);
  const entries = Array.isArray(history.data) ? history.data : [];

  const validation = validateNoticeForm(form);
  const busy =
    create.isPending || update.isPending || setActive.isPending || remove.isPending
    || upload.isPending || setAssetActive.isPending;

  function set<K extends keyof NoticeFormValues>(key: K, value: NoticeFormValues[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  /**
   * 실패 표시. 400 뿐 아니라 **404(이미 삭제됨)·409(동시 수정에서 짐)** 도 그대로 보여준다 —
   * 서버가 복구 경로를 담은 문구를 주므로 흘리기만 하면 된다. 캐시 무효화는 `useNoticeOps` 가
   * **성공·실패 가리지 않고**(`onSettled`) 하므로, 이 문구가 뜰 때 목록은 이미 다시 조회된다
   * (404/409 는 "화면이 낡았다"는 신호라 재조회가 특히 중요하다).
   */
  function fail(err: unknown, fallback: string) {
    setError(noticeOpErrorMessage(err, fallback));
    setNotice(null);
  }

  function done(message: string) {
    setNotice(message);
    setError(null);
  }

  function resetForm() {
    setForm(EMPTY_NOTICE_FORM);
    setEditing(null);
    setTouched(false);
  }

  function submit() {
    setTouched(true);
    if (!validation.valid || busy) return;
    if (editing) {
      // ⚠️ **수정 바디에는 `active` 를 싣지 않는다.** 서버가 400 으로 거절하고, 그러면 운영자는
      //    잘못 올라간 공지의 문구를 영영 못 고친다(#248 blocker-1). 노출 전환은 목록 버튼이 한다.
      if (!validation.updatePayload) return;
      update.mutate(
        { id: editing, body: validation.updatePayload },
        {
          onSuccess: () => {
            done("수정했습니다 — 내용이 바뀌었으면 revision 이 올라 24시간 억제가 풀립니다");
            resetForm();
          },
          onError: (err) => fail(err, "수정에 실패했습니다"),
        },
      );
      return;
    }
    if (!validation.createPayload) return;
    create.mutate(validation.createPayload, {
      onSuccess: () => {
        done("게시했습니다 — 다음 조회부터 즉시 반영됩니다(재배포·리로드 없음)");
        resetForm();
      },
      onError: (err) => fail(err, "게시에 실패했습니다"),
    });
  }

  function toggleActive(row: AdminNoticeRow) {
    const why = window.prompt(
      row.active ? "내리는 사유를 입력하세요(이력에 남습니다)" : "올리는 사유를 입력하세요(이력에 남습니다)",
    );
    if (!why || !why.trim()) return;
    setActive.mutate(
      { id: row.id, body: { active: !row.active, reason: why.trim() } },
      {
        onSuccess: () => done(row.active ? "노출을 중지했습니다" : "다시 노출합니다"),
        onError: (err) => fail(err, "노출 전환에 실패했습니다"),
      },
    );
  }

  // ── 공지 이미지 (#309 W1) ───────────────────────────────────────────────

  /** 본문 끝에 마크업을 잇는다. 빈 본문이면 그대로, 아니면 새 줄에서 시작한다. */
  function appendToBody(markup: string) {
    setForm((f) => ({ ...f, body: f.body ? `${f.body.replace(/\s*$/, "")}\n\n${markup}` : markup }));
  }

  /**
   * 업로드 → **본문에 마크업 자동 삽입**. 올려 두고 운영자가 경로를 손으로 옮겨 적게 하면
   * 오타 한 글자가 깨진 이미지가 되고, 그 오타는 게시 후에야 보인다.
   *
   * 서버가 준 `url`(상대경로)을 그대로 쓴다 — 경로 규칙을 클라가 조립하지 않는다.
   */
  function onPickFile(file: File | null) {
    if (!file) return;
    const why = window.prompt("업로드 사유를 입력하세요(이력에 남습니다)", `${file.name} 업로드`);
    if (!why || !why.trim()) {
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    upload.mutate(
      { file, reason: why.trim() },
      {
        onSuccess: (asset) => {
          appendToBody(noticeAssetMarkup(asset.id, file.name.replace(/\.[^.]+$/, "")));
          done("이미지를 올리고 본문에 넣었습니다 — 재배포 없이 바로 반영됩니다");
        },
        onError: (err) => fail(err, "이미지 업로드에 실패했습니다"),
        onSettled: () => {
          // 같은 파일을 다시 고를 수 있게 입력을 비운다(change 이벤트가 안 뜨는 함정).
          if (fileInput.current) fileInput.current.value = "";
        },
      },
    );
  }

  /**
   * 노출 ON/OFF = **내리기의 전부**(#309 D9, hero 확정). 삭제 버튼은 없다 — 삭제는 오조작이
   * 곧 영구 소실이고 참조하던 공지의 그림을 되살릴 방법이 없다.
   */
  function toggleAsset(asset: AdminNoticeAssetRow) {
    if (!window.confirm(assetToggleWarning(asset))) return;
    const why = window.prompt(
      asset.active ? "노출을 끄는 사유(이력에 남습니다)" : "다시 켜는 사유(이력에 남습니다)",
    );
    if (!why || !why.trim()) return;
    setAssetActive.mutate(
      { id: asset.id, active: !asset.active, reason: why.trim() },
      {
        onSuccess: () => done(asset.active ? "이미지 노출을 껐습니다(되돌릴 수 있습니다)" : "다시 노출합니다"),
        onError: (err) => fail(err, "이미지 노출 전환에 실패했습니다"),
      },
    );
  }

  function softDelete(row: AdminNoticeRow) {
    const why = window.prompt("삭제 사유를 입력하세요(이력 보존 — soft delete 입니다)");
    if (!why || !why.trim()) return;
    remove.mutate(
      { id: row.id, reason: why.trim() },
      {
        onSuccess: () => done("삭제했습니다(이력은 남습니다)"),
        onError: (err) => fail(err, "삭제에 실패했습니다"),
      },
    );
  }

  return (
    <section className={styles.panel} data-testid="admin-notices-panel">
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>공지 목록</h2>
      </div>

      {list.isLoading && <p className={styles.muted}>불러오는 중…</p>}
      {!list.isLoading && rows.length === 0 && (
        <p className={styles.muted} data-testid="admin-notices-empty">
          등록된 공지가 없습니다
        </p>
      )}

      {rows.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="admin-notices-table">
            <thead>
              <tr>
                <th>상태</th>
                <th>제목</th>
                <th>기간</th>
                <th>rev</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`admin-notice-row-${row.id}`}>
                  <td>
                    {/* 상태는 **서버가 판정**한 값을 번역만 한다 — 화면이 다시 계산하지 않는다. */}
                    <span
                      className={`${n.pill} ${n[noticeStatusTone(row.status)]}`}
                      data-testid={`admin-notice-status-${row.id}`}
                      data-status={row.status}
                    >
                      {noticeStatusLabel(row.status)}
                    </span>
                  </td>
                  <td>{row.title}</td>
                  <td className={styles.nowrap}>{formatNoticeWindow(row.startsAt, row.endsAt)}</td>
                  <td className={styles.num} data-testid={`admin-notice-rev-${row.id}`}>
                    {row.revision}
                  </td>
                  <td className={styles.nowrap}>
                    <button
                      type="button"
                      className={n.mini}
                      data-testid={`admin-notice-edit-${row.id}`}
                      disabled={busy}
                      onClick={() => {
                        setForm(formFromRow(row));
                        setEditing(row.id);
                        setTouched(false);
                        setNotice(null);
                      }}
                    >
                      수정
                    </button>{" "}
                    <button
                      type="button"
                      className={n.mini}
                      data-testid={`admin-notice-toggle-${row.id}`}
                      disabled={busy}
                      onClick={() => toggleActive(row)}
                    >
                      {row.active ? "내리기" : "올리기"}
                    </button>{" "}
                    <button
                      type="button"
                      className={n.mini}
                      data-testid={`admin-notice-delete-${row.id}`}
                      disabled={busy}
                      onClick={() => softDelete(row)}
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className={styles.subTitle} data-testid="admin-notice-form-title">
        {editing ? "공지 수정" : "공지 작성"}
      </h3>

      <label className={styles.field}>
        <span>제목 (≤100자)</span>
        <input
          type="text"
          value={form.title}
          data-testid="admin-notice-title"
          onChange={(e) => set("title", e.target.value)}
          onBlur={() => setTouched(true)}
          disabled={busy}
        />
      </label>

      <label className={styles.field}>
        <span>본문 (≤2000자 — **굵게** · *기울임* · `- 목록` · [문구](url) · ![설명](url))</span>
        <textarea
          rows={5}
          className={n.textarea}
          value={form.body}
          data-testid="admin-notice-body"
          onChange={(e) => set("body", e.target.value)}
          onBlur={() => setTouched(true)}
          disabled={busy}
        />
      </label>

      {/* 이미지 업로드 (#309 W1) — 여기가 "재배포 없이 공지에 그림 넣기"의 입구다. */}
      <div className={n.uploadRow}>
        <button
          type="button"
          className={n.mini}
          data-testid="admin-notice-asset-pick"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {upload.isPending ? "올리는 중…" : "이미지 업로드"}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          data-testid="admin-notice-asset-input"
          onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
        />
        <span className={styles.muted}>
          올리면 <b>본문 끝에 자동으로 삽입</b>됩니다. PNG · JPEG · WebP · GIF (SVG 는 보안상 불가).
        </span>
      </div>

      <p className={styles.muted}>
        업로드한 이미지는 <b>서버에 저장</b>되어 재배포 없이 반영됩니다. 외부 URL 도 계속 쓸 수 있지만,
        그 호스트가 죽으면 이미지가 사라집니다(글·레이아웃은 유지).
      </p>

      {/* 미리보기는 **팝업과 같은 렌더러**를 쓴다 — 따로 만들면 조용히 갈라져 미리보기가 거짓말이 된다. */}
      <div className={n.preview} data-testid="admin-notice-preview">
        <span className={n.previewLabel}>미리보기</span>
        <p className={n.previewTitle}>{form.title || "(제목 없음)"}</p>
        <NoticeBody body={form.body} testId="admin-notice-preview-body" />
      </div>

      <div className={n.two}>
        <label className={styles.field}>
          <span>시작 (비우면 즉시)</span>
          <input
            type="datetime-local"
            value={form.startsAt}
            data-testid="admin-notice-starts"
            onChange={(e) => set("startsAt", e.target.value)}
            disabled={busy}
          />
        </label>
        <label className={styles.field}>
          <span>종료 (비우면 무기한)</span>
          <input
            type="datetime-local"
            value={form.endsAt}
            data-testid="admin-notice-ends"
            onChange={(e) => set("endsAt", e.target.value)}
            disabled={busy}
          />
        </label>
      </div>

      <div className={n.two}>
        {/* 상한을 화면에 적고 입력에도 건다 — 서버 400 을 왕복해서야 알게 되면 미러가 아니다(m3). */}
        <label className={styles.field}>
          <span>
            우선순위 (클수록 앞 · {NOTICE_PRIORITY_MIN} ~ {NOTICE_PRIORITY_MAX})
          </span>
          <input
            type="number"
            min={NOTICE_PRIORITY_MIN}
            max={NOTICE_PRIORITY_MAX}
            value={form.priority}
            data-testid="admin-notice-priority"
            onChange={(e) => set("priority", e.target.value)}
            disabled={busy}
          />
        </label>
        {/* ⚠️ 수정 시엔 잠근다 — 노출 전환은 전용 엔드포인트가 받는다(목록의 [내리기]/[올리기]).
            서버의 PUT 은 `active` 를 **무시하지 않고 400 으로 거절**한다("전체 치환인데 한 필드만
            조용히 무시"가 최악의 비대칭이라). 그래서 잠그는 것만으로는 부족했고 — 체크박스를 잠가도
            폼 값은 그대로 전송돼 **수정이 100% 400 이었다** — 수정 payload 에서 키 자체를 뺐다
            (`NoticeUpdateRequest.active?: never` 가 컴파일로 강제). 이 표시는 그 사실의 UI 반영일 뿐이다. */}
        <label className={`${styles.field} ${n.checkField}`}>
          <span>{editing ? "노출 (목록의 내리기/올리기로 변경)" : "노출"}</span>
          <input
            type="checkbox"
            checked={form.active}
            data-testid="admin-notice-active"
            onChange={(e) => set("active", e.target.checked)}
            disabled={busy || Boolean(editing)}
          />
        </label>
      </div>

      <label className={styles.field}>
        <span>사유 (필수 · {NOTICE_REASON_MAX}자 이하 — 변경 이력에 남습니다)</span>
        <input
          type="text"
          maxLength={NOTICE_REASON_MAX}
          value={form.reason}
          data-testid="admin-notice-reason"
          onChange={(e) => set("reason", e.target.value)}
          onBlur={() => setTouched(true)}
          disabled={busy}
        />
      </label>

      {touched && validation.error && (
        <p className={styles.error} data-testid="admin-notice-invalid">
          {validation.error}
        </p>
      )}

      <div className={styles.panelActions}>
        <button
          type="button"
          className={styles.primary}
          data-testid="admin-notice-submit"
          disabled={busy}
          onClick={submit}
        >
          {editing ? "수정 저장" : "게시"}
        </button>
        {editing && (
          <button
            type="button"
            className={styles.ghost}
            data-testid="admin-notice-cancel"
            disabled={busy}
            onClick={resetForm}
          >
            취소
          </button>
        )}
      </div>

      {notice && (
        <p className={styles.notice} data-testid="admin-notice-notice">
          {notice}
        </p>
      )}
      {error && (
        <p className={styles.error} data-testid="admin-notice-error">
          {error}
        </p>
      )}

      {/* 업로드한 이미지 (#309 W1). **삭제 열이 없는 것이 설계다** — 내리기는 노출 스위치로만. */}
      <h3 className={styles.subTitle}>업로드한 이미지</h3>
      {assets.length === 0 ? (
        <p className={styles.muted} data-testid="admin-notice-assets-empty">
          업로드한 이미지가 없습니다
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="admin-notice-assets">
            <thead>
              <tr>
                <th>미리보기</th>
                <th>이름</th>
                <th>크기</th>
                <th>사용 중</th>
                <th>노출</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => (
                <tr key={asset.id} data-testid={`admin-notice-asset-row-${asset.id}`}>
                  <td>
                    {/* 노출을 꺼도 운영자에겐 보여야 한다(무엇을 되돌리는지 알아야 하므로) —
                        그런데 서빙이 404 라 여기서도 안 뜬다. 그건 정직한 상태다: "지금 유저에게
                        안 보이는 그림"이 운영자 화면에서도 안 보인다. */}
                    <img
                      className={n.assetThumb}
                      src={resolveNoticeUrl(asset.url)}
                      alt=""
                      loading="lazy"
                      data-testid={`admin-notice-asset-thumb-${asset.id}`}
                    />
                  </td>
                  <td>{asset.originalName ?? asset.id}</td>
                  <td className={styles.nowrap}>{formatAssetSize(asset.byteSize)}</td>
                  <td className={styles.num} data-testid={`admin-notice-asset-used-${asset.id}`}>
                    {asset.usedBy}
                  </td>
                  <td>
                    <span
                      className={`${n.pill} ${asset.active ? n.live : n.off}`}
                      data-testid={`admin-notice-asset-state-${asset.id}`}
                      data-active={asset.active ? "1" : "0"}
                    >
                      {asset.active ? "ON" : "OFF"}
                    </span>
                  </td>
                  <td className={styles.nowrap}>
                    <button
                      type="button"
                      className={n.mini}
                      data-testid={`admin-notice-asset-insert-${asset.id}`}
                      disabled={busy}
                      onClick={() => {
                        appendToBody(noticeAssetMarkup(asset.id, asset.originalName ?? ""));
                        done("본문에 넣었습니다");
                      }}
                    >
                      본문에 넣기
                    </button>{" "}
                    <button
                      type="button"
                      className={n.mini}
                      data-testid={`admin-notice-asset-toggle-${asset.id}`}
                      disabled={busy}
                      onClick={() => toggleAsset(asset)}
                    >
                      {asset.active ? "노출 끄기" : "다시 켜기"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className={styles.subTitle}>변경 이력</h3>
      <div className={styles.tableWrap}>
        <table className={styles.table} data-testid="admin-notice-history">
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
              <tr key={entry.id} data-testid={`admin-notice-history-${entry.result}`}>
                <td className={styles.nowrap}>{formatStamp(entry.createdAt)}</td>
                <td className={styles.nowrap}>{entry.actor}</td>
                <td>{noticeActionLabel(entry.action)}</td>
                {/* 실패도 숨기지 않는다 — 시도 자체가 이력이다(V18 정책). */}
                <td className={entry.result === "ok" ? undefined : styles.error}>{entry.result}</td>
                <td>{entry.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {entries.length === 0 && (
        <p className={styles.muted} data-testid="admin-notice-history-empty">
          변경 이력이 없습니다
        </p>
      )}
    </section>
  );
}
