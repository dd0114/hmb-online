import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useAdminUserDetail, useAdminUsers, useGrantPoints } from "../api/admin-hooks";
import type { AdminUserRow } from "../api/p3";
import { Layout } from "../common/Layout";
import { ErrorToast } from "../common/ErrorToast";
import { Modal } from "../common/Modal";
import { EconomyOpsPanel } from "./EconomyOpsPanel";
import { NoticesPanel } from "./NoticesPanel";
import { CharBundlePanel } from "./CharBundlePanel";
import {
  formatRecord,
  formatSignedDelta,
  formatStamp,
  needsLargeConfirm,
  validateGrant,
} from "./admin-logic";
import { AdminUnitsSection } from "./AdminUnitsSection";
import { useCurrency } from "../common/Amount";
import { CURRENCY_POINT, formatAmount, withEulReul } from "../common/currency";
import styles from "./AdminPage.module.css";
import u from "./AdminUnits.module.css";

/** 운영자 페이지의 섹션 — 유저 운영(기존) / 유닛 카탈로그(#207 웨이브2-C) / 공지(#248). */
export type AdminTab = "users" | "units" | "economy" | "notices" | "chars";

/** 검색 입력 → 질의 반영 지연(ms). 타이핑마다 요청하지 않기 위한 값. */
const SEARCH_DEBOUNCE_MS = 250;
/** 서버 403(AC-C2) 안내를 보여준 뒤 로비로 되돌리기까지의 시간(ms). */
export const FORBIDDEN_REDIRECT_MS = 1800;

function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message || fallback : fallback;
}

/**
 * 운영자 페이지 (PRD-v4 §C, AC-C1/AC-C2) — 테스터 운영 최소 기능:
 * 유저 목록·검색 / 유저 상세(보유·덱·전적) / 포인트 지급·차감(사유 필수) / 원장(감사 로그).
 *
 * 서버 계약은 `src/api/p3.ts` 의 admin 섹션(잠정 SoT). 서버 미완 구간은 route-mock E2E 로 검증한다.
 */
export function AdminPage() {
  const navigate = useNavigate();
  // 운영 화면의 재화 이름·심볼도 서버 표기 메타를 따른다 (#232) — admin 만 예외로 두면
  // 운영자가 보는 값과 유저가 보는 값이 갈린다.
  const pointCurrency = useCurrency(CURRENCY_POINT);

  const [tab, setTab] = useState<AdminTab>("users");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [deltaRaw, setDeltaRaw] = useState("");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [confirmDelta, setConfirmDelta] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setTerm(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [q]);

  const list = useAdminUsers(term);
  const detail = useAdminUserDetail(selected);
  const grant = useGrantPoints();

  // AC-C2: 클라 가드를 우회해 /admin URL 로 직접 들어와도 서버가 403 이면 화면을 열지 않는다.
  const forbidden =
    isForbidden(list.error) || isForbidden(detail.error) || isForbidden(grant.error);

  useEffect(() => {
    if (!forbidden) return;
    const id = setTimeout(() => navigate("/home", { replace: true }), FORBIDDEN_REDIRECT_MS);
    return () => clearTimeout(id);
  }, [forbidden, navigate]);

  const validation = validateGrant(deltaRaw, reason);
  const canSubmit = validation.valid && Boolean(selected) && !grant.isPending;

  function submitGrant(delta: number, why: string) {
    if (!selected) return;
    grant.mutate(
      { userId: selected, body: { delta, reason: why } },
      {
        onSuccess: (res) => {
          setDeltaRaw("");
          setReason("");
          setTouched(false);
          setConfirmDelta(null);
          setNotice(
            `${formatSignedDelta(res.entry.delta)} 반영 — 잔액 ${formatAmount(pointCurrency, res.points)}`,
          );
        },
        onError: (err) => {
          setConfirmDelta(null);
          if (!isForbidden(err)) setError(errMessage(err, `${pointCurrency.name} 처리에 실패했습니다`));
        },
      },
    );
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setNotice(null);
    if (!validation.valid || validation.delta === null || !selected) return;
    if (needsLargeConfirm(validation.delta)) {
      setConfirmDelta(validation.delta);
      return;
    }
    submitGrant(validation.delta, validation.reason);
  }

  const header = (
    <div className={styles.headerRow}>
      <button type="button" className={styles.back} onClick={() => navigate("/home")}>
        ← 홈
      </button>
      <h1 className={styles.pageTitle}>운영자</h1>
      <span className={styles.badge}>ADMIN</span>
    </div>
  );

  if (forbidden) {
    return (
      <Layout header={header} nav>
        <div className={styles.forbidden} role="alert" data-testid="admin-forbidden">
          <p className={styles.forbiddenTitle}>접근 권한이 없습니다</p>
          <p className={styles.forbiddenBody}>
            운영자 전용 페이지입니다. 잠시 후 로비로 이동합니다.
          </p>
          <button
            type="button"
            className={styles.primary}
            data-testid="admin-forbidden-lobby"
            onClick={() => navigate("/home", { replace: true })}
          >
            로비로 이동
          </button>
        </div>
      </Layout>
    );
  }

  const users: AdminUserRow[] = list.data?.users ?? [];
  const selectedRow = detail.data?.user ?? users.find((u) => u.userId === selected) ?? null;

  return (
    <Layout header={header} nav>
      <div data-testid="admin-page">
        {error && <ErrorToast message={error} onDismiss={() => setError(null)} />}

        {/* 운영 화면 섹션 전환. 라우트를 늘리지 않고 탭 하나만 추가한다(#207 웨이브2-C). */}
        <div className={u.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "users"}
            className={`${u.tab} ${tab === "users" ? u.tabActive : ""}`}
            data-testid="admin-tab-users"
            onClick={() => setTab("users")}
          >
            유저 운영
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "units"}
            className={`${u.tab} ${tab === "units" ? u.tabActive : ""}`}
            data-testid="admin-tab-units"
            onClick={() => setTab("units")}
          >
            유닛 카탈로그
          </button>
          {/* #209 B안 — 재배포 없이 스타터 최상위 후보를 갈아끼우는 운영. 유저·유닛과 성격이
              달라(설정 파일 교체 + 감사 원장) 탭을 하나 더 둔다. */}
          <button
            type="button"
            role="tab"
            aria-selected={tab === "economy"}
            className={`${u.tab} ${tab === "economy" ? u.tabActive : ""}`}
            data-testid="admin-tab-economy"
            onClick={() => setTab("economy")}
          >
            스타터 지급
          </button>
          {/* #248 — 공지는 DB 데이터 그 자체라 쓰면 곧 반영된다(economy 처럼 리로드 호출이 없다). */}
          <button
            type="button"
            role="tab"
            aria-selected={tab === "notices"}
            className={`${u.tab} ${tab === "notices" ? u.tabActive : ""}`}
            data-testid="admin-tab-notices"
            onClick={() => setTab("notices")}
          >
            공지
          </button>
          {/* #309 W2 — 유닛 **등록**은 이미 무배포였고(#207 파트 A) 남아 있던 건 **아트**였다.
              번들을 올려 켜면 웹 재배포 없이 그림이 바뀐다. 성격이 공지와 달라(파일 트리 교체 +
              롤백 포인터) 탭을 하나 더 둔다. */}
          <button
            type="button"
            role="tab"
            aria-selected={tab === "chars"}
            className={`${u.tab} ${tab === "chars" ? u.tabActive : ""}`}
            data-testid="admin-tab-chars"
            onClick={() => setTab("chars")}
          >
            유닛 아트
          </button>
        </div>

        {tab === "units" && <AdminUnitsSection />}

        {tab === "economy" && <EconomyOpsPanel />}

        {tab === "notices" && <NoticesPanel />}

        {tab === "chars" && <CharBundlePanel />}

        {tab === "users" && (
          <>
        <section className={styles.section}>
          <label className={styles.searchLabel} htmlFor="admin-search-input">
            유저 검색 (닉네임 / 아이디)
          </label>
          <input
            id="admin-search-input"
            className={styles.search}
            data-testid="admin-search"
            type="search"
            value={q}
            placeholder="닉네임 또는 유저 ID"
            onChange={(e) => setQ(e.target.value)}
          />

          {list.isError && !forbidden && (
            <p className={styles.muted}>유저 목록을 불러오지 못했습니다</p>
          )}
          {list.isLoading && <p className={styles.muted}>불러오는 중…</p>}
          {!list.isLoading && !list.isError && users.length === 0 && (
            <p className={styles.muted} data-testid="admin-users-empty">
              조건에 맞는 유저가 없습니다
            </p>
          )}

          {users.length > 0 && (
            <div className={styles.tableScroll}>
              <table className={styles.table} data-testid="admin-users">
                <thead>
                  <tr>
                    <th scope="col">닉네임</th>
                    <th scope="col">provider</th>
                    <th scope="col">{pointCurrency.name}</th>
                    <th scope="col">전적</th>
                    <th scope="col">가입일</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr
                      key={u.userId}
                      className={u.userId === selected ? styles.rowActive : undefined}
                      data-testid={`admin-user-row-${u.userId}`}
                      data-selected={u.userId === selected ? "true" : undefined}
                    >
                      <td>
                        <button
                          type="button"
                          className={styles.linkBtn}
                          data-testid={`admin-user-select-${u.userId}`}
                          onClick={() => {
                            setSelected(u.userId);
                            setNotice(null);
                          }}
                        >
                          {u.nickname}
                        </button>
                      </td>
                      <td>{u.provider}</td>
                      <td className={styles.num}>{u.points.toLocaleString("en-US")}</td>
                      <td className={styles.nowrap}>{formatRecord(u.wins, u.draws, u.losses)}</td>
                      <td className={styles.nowrap}>{formatStamp(u.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {selected && (
          <section className={styles.section} data-testid="admin-user-detail">
            <h2 className={styles.sectionTitle}>
              {selectedRow?.nickname ?? selected}
              <span className={styles.idHint}>{selected}</span>
            </h2>

            {detail.isLoading && <p className={styles.muted}>상세 불러오는 중…</p>}
            {detail.isError && !forbidden && (
              <p className={styles.muted}>상세 정보를 불러오지 못했습니다</p>
            )}

            {detail.data && (
              <dl className={styles.stats}>
                <div className={styles.stat}>
                  <dt>{pointCurrency.name}</dt>
                  <dd data-testid="admin-detail-points">
                    {detail.data.user.points.toLocaleString("en-US")}
                  </dd>
                </div>
                <div className={styles.stat}>
                  <dt>보유 선수</dt>
                  <dd data-testid="admin-detail-owned">{detail.data.ownedPlayers}</dd>
                </div>
                <div className={styles.stat}>
                  <dt>덱 포메이션</dt>
                  <dd data-testid="admin-detail-formation">{detail.data.deckFormation ?? "—"}</dd>
                </div>
                <div className={styles.stat}>
                  <dt>선발</dt>
                  <dd data-testid="admin-detail-starters">{detail.data.deckStarters}</dd>
                </div>
                <div className={styles.stat}>
                  <dt>전적</dt>
                  <dd data-testid="admin-detail-record">
                    {formatRecord(
                      detail.data.user.wins,
                      detail.data.user.draws,
                      detail.data.user.losses,
                    )}
                  </dd>
                </div>
              </dl>
            )}

            <form className={styles.grantForm} data-testid="admin-grant-form" onSubmit={onSubmit}>
              <h3 className={styles.formTitle}>{pointCurrency.name} 지급 / 차감</h3>
              <div className={styles.field}>
                <label htmlFor="admin-grant-delta-input">증감값 (음수 = 차감)</label>
                <input
                  id="admin-grant-delta-input"
                  data-testid="admin-grant-delta"
                  className={styles.input}
                  inputMode="numeric"
                  value={deltaRaw}
                  placeholder="예: 500 또는 -300"
                  onChange={(e) => setDeltaRaw(e.target.value)}
                  onBlur={() => setTouched(true)}
                />
                {touched && validation.errors.delta && (
                  <p className={styles.fieldError} data-testid="admin-grant-delta-error">
                    {validation.errors.delta}
                  </p>
                )}
              </div>

              <div className={styles.field}>
                <label htmlFor="admin-grant-reason-input">사유 (필수 — 원장에 기록)</label>
                <input
                  id="admin-grant-reason-input"
                  data-testid="admin-grant-reason"
                  className={styles.input}
                  value={reason}
                  placeholder="예: 충전 요청 수동 처리"
                  onChange={(e) => setReason(e.target.value)}
                  onBlur={() => setTouched(true)}
                />
                {touched && validation.errors.reason && (
                  <p className={styles.fieldError} data-testid="admin-grant-reason-error">
                    {validation.errors.reason}
                  </p>
                )}
              </div>

              <button
                type="submit"
                className={styles.primary}
                data-testid="admin-grant-submit"
                disabled={!canSubmit}
              >
                {grant.isPending ? "처리 중…" : "적용"}
              </button>

              {notice && (
                <p className={styles.notice} role="status" data-testid="admin-grant-notice">
                  {notice}
                </p>
              )}
            </form>

            <h3 className={styles.formTitle}>원장 (감사 로그)</h3>
            <div className={styles.tableScroll}>
              <table className={styles.table} data-testid="admin-ledger">
                <thead>
                  <tr>
                    <th scope="col">증감</th>
                    <th scope="col">사유</th>
                    <th scope="col">actor</th>
                    <th scope="col">시각</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.data?.recentLedger ?? []).map((e) => (
                    <tr key={e.id} data-testid={`admin-ledger-row-${e.id}`}>
                      <td className={e.delta >= 0 ? styles.plus : styles.minus}>
                        {formatSignedDelta(e.delta)}
                      </td>
                      <td>{e.reason}</td>
                      <td className={styles.nowrap}>{e.actor}</td>
                      <td className={styles.nowrap}>{formatStamp(e.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {detail.data && detail.data.recentLedger.length === 0 && (
              <p className={styles.muted} data-testid="admin-ledger-empty">
                기록된 원장이 없습니다
              </p>
            )}
          </section>
        )}

        {confirmDelta !== null && (
          <Modal
            onClose={() => setConfirmDelta(null)}
            labelledBy="admin-grant-confirm-title"
            overlayClassName={styles.overlay}
            className={styles.dialog}
            testId="admin-grant-confirm"
          >
            <h2 id="admin-grant-confirm-title" className={styles.dialogTitle}>
              큰 금액입니다
            </h2>
            <p className={styles.dialogBody}>
              <strong>{formatSignedDelta(confirmDelta)}</strong> {withEulReul(pointCurrency.name)}{" "}
              {selectedRow?.nickname ?? selected} 에게 적용합니다. 계속할까요?
            </p>
            <div className={styles.dialogActions}>
              <button
                type="button"
                className={styles.ghost}
                data-testid="admin-grant-confirm-cancel"
                onClick={() => setConfirmDelta(null)}
              >
                취소
              </button>
              <button
                type="button"
                className={styles.primary}
                data-testid="admin-grant-confirm-ok"
                onClick={() => submitGrant(confirmDelta, validation.reason)}
              >
                적용
              </button>
            </div>
          </Modal>
        )}
          </>
        )}
      </div>
    </Layout>
  );
}
