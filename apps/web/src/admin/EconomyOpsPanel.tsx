import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { useAdminEconomy, useAdminEconomyHistory, useEconomyOps } from "../api/admin-hooks";
import {
  actionLabel,
  formatPool,
  isFullReplacement,
  normalizeEconomyView,
  sourceLabel,
  validateStarterTop,
} from "./economy-logic";
import { formatStamp } from "./admin-logic";
import styles from "./AdminPage.module.css";

/**
 * economy 무배포 운영 패널 (#209 B안) — <b>재배포 없이</b> 스타터 최상위 후보를 갈아끼운다.
 *
 * <p>화면이 값만 보여주면 안 된다: 발행물은 이미지에 구워져 있어 서버가 <b>override 파일</b>을
 * 얹는 방식으로 바꾸므로, "지금 먹고 있는 게 발행물인가 override 인가"(출처)가 값만큼 중요하다.
 * 그래서 상단에 항상 출처 뱃지를 띄우고, 롤백(=override 제거) 버튼을 그 옆에 둔다.
 */
export function EconomyOpsPanel() {
  const economy = useAdminEconomy();
  const history = useAdminEconomyHistory();
  const { replaceStarterTop, reload, clearOverride } = useEconomyOps();

  const [poolRaw, setPoolRaw] = useState("");
  const [countRaw, setCountRaw] = useState("1");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ⚠️ 서버 응답을 **그대로 믿지 않는다** — 이 패널은 admin 페이지 안에 있어서 여기서 던지면
  // 페이지 전체가 흰 화면이 된다(부분 실패·구버전 서버). 모양이 아니면 null 로 떨어뜨려 안내만 띄운다.
  const current = normalizeEconomyView(economy.data);

  // 서버 값이 오면 입력창의 출발점으로 채운다 — 운영자가 현재 값을 손으로 옮겨 적지 않게.
  useEffect(() => {
    if (!current) return;
    setPoolRaw(formatPool(current.pool));
    setCountRaw(String(current.count));
  }, [current?.loadedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // 이력도 같은 이유로 방어한다 — 배열이 아닌 응답(`{}`)에 .map 을 걸면 페이지가 통째로 죽는다.
  const entries = Array.isArray(history.data) ? history.data : [];

  const validation = validateStarterTop(poolRaw, countRaw, reason);
  const busy = replaceStarterTop.isPending || reload.isPending || clearOverride.isPending;

  function fail(err: unknown, fallback: string) {
    setError(err instanceof ApiError ? err.message || fallback : fallback);
    setNotice(null);
  }

  function done(message: string) {
    setNotice(message);
    setError(null);
  }

  function submit() {
    setTouched(true);
    if (!validation.valid || busy) return;
    if (
      isFullReplacement(current?.pool ?? [], validation.pool) &&
      !window.confirm("후보를 전부 교체합니다. 다음 가입부터 즉시 적용됩니다. 계속할까요?")
    ) {
      return;
    }
    replaceStarterTop.mutate(
      { pool: validation.pool, count: validation.count, reason: reason.trim() },
      {
        onSuccess: (view) => done(`적용됐습니다 — 지금부터 ${view.starterTop.pool.length}명 중 ${view.starterTop.count}장 지급`),
        onError: (err) => fail(err, "교체에 실패했습니다"),
      },
    );
  }

  return (
    <section className={styles.panel} data-testid="admin-economy-panel">
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>스타터 최상위 후보 (무배포 운영)</h2>
        {current && (
          <span
            className={styles.badge}
            data-testid="admin-economy-source"
            data-source={current.source}
          >
            {sourceLabel(current.source)}
          </span>
        )}
      </div>

      {economy.isLoading && <p className={styles.muted}>불러오는 중…</p>}
      {!economy.isLoading && !current && (
        <p className={styles.muted} data-testid="admin-economy-unavailable">
          economy 설정을 불러오지 못했습니다(서버 응답 형식 확인 필요) — 다른 운영 기능은 그대로 씁니다
        </p>
      )}

      {current && (
        <>
          <p className={styles.muted} data-testid="admin-economy-current">
            {/* 적용된 값의 출처는 위 뱃지가 말하고, 여기서는 "지울 파일이 남아 있는지"를 알린다. */}
            {current.overrideFilePresent && !current.overrideApplied && (
              <strong data-testid="admin-economy-stale-override">
                ⚠ 적용되지 않은 override 파일이 남아 있습니다(롤백으로 정리){" "}
              </strong>
            )}
            현재 후보 {current.pool.length}명 · 지급 {current.count}장 ·
            기본팩 {current.starterPackSize}명 · 적용 {formatStamp(current.loadedAt)}
          </p>

          <label className={styles.field}>
            <span>후보 playerId (콤마·공백 구분)</span>
            <input
              type="text"
              value={poolRaw}
              data-testid="admin-economy-pool"
              onChange={(e) => setPoolRaw(e.target.value)}
              onBlur={() => setTouched(true)}
              disabled={busy}
            />
          </label>

          <label className={styles.field}>
            <span>지급 장수</span>
            <input
              type="number"
              min={1}
              value={countRaw}
              data-testid="admin-economy-count"
              onChange={(e) => setCountRaw(e.target.value)}
              disabled={busy}
            />
          </label>

          <label className={styles.field}>
            <span>사유 (이력에 남습니다)</span>
            <input
              type="text"
              value={reason}
              data-testid="admin-economy-reason"
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              disabled={busy}
            />
          </label>

          {touched && validation.error && (
            <p className={styles.error} data-testid="admin-economy-invalid">
              {validation.error}
            </p>
          )}

          <div className={styles.panelActions}>
            <button
              type="button"
              className={styles.primary}
              data-testid="admin-economy-apply"
              disabled={busy}
              onClick={submit}
            >
              적용
            </button>
            <button
              type="button"
              className={styles.ghost}
              data-testid="admin-economy-reload"
              disabled={busy}
              onClick={() =>
                reload.mutate(reason.trim() || "수동 리로드", {
                  onSuccess: () => done("디스크에서 다시 읽었습니다"),
                  onError: (err) => fail(err, "리로드에 실패했습니다"),
                })
              }
            >
              리로드
            </button>
            <button
              type="button"
              className={styles.ghost}
              data-testid="admin-economy-rollback"
              disabled={busy || !current.overrideFilePresent}
              onClick={() =>
                clearOverride.mutate(reason.trim() || "발행물로 롤백", {
                  onSuccess: () => done("배포 발행물로 되돌렸습니다"),
                  onError: (err) => fail(err, "롤백에 실패했습니다"),
                })
              }
            >
              발행물로 롤백
            </button>
          </div>

          {notice && (
            <p className={styles.notice} data-testid="admin-economy-notice">
              {notice}
            </p>
          )}
          {error && (
            <p className={styles.error} data-testid="admin-economy-error">
              {error}
            </p>
          )}
        </>
      )}

      <h3 className={styles.subTitle}>운영 이력</h3>
      <div className={styles.tableWrap}>
        <table className={styles.table} data-testid="admin-economy-history">
          <thead>
            <tr>
              <th>시각</th>
              <th>액션</th>
              <th>결과</th>
              <th>사유</th>
              <th>운영자</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} data-testid={`admin-economy-history-${entry.result}`}>
                <td className={styles.nowrap}>{formatStamp(entry.createdAt)}</td>
                <td>{actionLabel(entry.action)}</td>
                {/* 실패도 숨기지 않는다 — "왜 반영이 안 됐나"의 답이 여기 있다. */}
                <td className={entry.result === "ok" ? undefined : styles.error}>{entry.result}</td>
                <td>{entry.reason}</td>
                <td className={styles.nowrap}>{entry.actor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {entries.length === 0 && (
        <p className={styles.muted} data-testid="admin-economy-history-empty">
          운영 이력이 없습니다
        </p>
      )}
    </section>
  );
}
