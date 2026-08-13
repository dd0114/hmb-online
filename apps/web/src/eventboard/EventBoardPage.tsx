import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useAdminEventFunnel, useAdminEvents } from "../api/event-hooks";
import { Layout } from "../common/Layout";
import { formatStamp } from "../admin/admin-logic";
import { FORBIDDEN_REDIRECT_MS } from "../admin/AdminPage";
import {
  DEFAULT_EVENT_FILTER,
  EVENT_TYPES,
  EVENT_LABELS,
  FUNNEL_LABELS,
  FUNNEL_STAGES,
  asList,
  eventLabel,
  funnelRows,
  furthestLabel,
  modeOf,
  pagerView,
  reachedCount,
  setEventFilterEvent,
  setEventFilterOffset,
  setEventFilterUser,
  summarizeProps,
  userOptions,
} from "./event-board-logic";
import type { EventFilter, EventRow, EventType } from "./event-board-logic";
import styles from "./EventBoardPage.module.css";

/**
 * `/event-board` — 어드민 전용 관측 화면 (에픽 #492, 승인안 = B + D6).
 *
 * hero 가 밝힌 목적은 *"심사위원들이 게임을 어디까지 플레이해봤나"* 이므로 **1급 산출물은
 * 이벤트 총량이 아니라 유저별 도달 지점**이다 — 그래서 퍼널 그리드가 위, 스트림이 아래다.
 * 순서를 뒤집지 마라(그러면 "총 뽑기 37회" 같은, 아무도 안 묻는 숫자가 화면의 주인공이 된다).
 *
 * ── 가드는 두 층 (`/admin` 과 동일) ────────────────────────────────────────
 * L1 클라: `RequireAuth` → `RequireAdmin`(`admin-logic.adminGuardDecision`) — App.tsx 라우트.
 * L2 서버: admin API 가 403 이면 데이터를 **한 조각도 안 그리고** 배너 후 `/home`.
 *   ⚠️ L1 은 UX 가드일 뿐 보안 경계가 아니다 — URL 직접 진입으로 통과해도 L2 가 닫는다.
 *
 * ⚠️ 이 라우트는 `LOCKED_ROUTES`(#217 매치 잠금)에 **넣지 않는다** — `/admin` 과 같은 이유로
 * 운영 화면은 경기 진행과 무관하게 열려야 한다.
 */
export function EventBoardPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<EventFilter>(DEFAULT_EVENT_FILTER);
  const streamRef = useRef<HTMLElement | null>(null);

  const funnel = useAdminEventFunnel();
  const stream = useAdminEvents(filter);

  // L2 — 서버 게이트. 어느 한쪽이라도 403 이면 화면을 열지 않는다.
  const forbidden = isForbidden(funnel.error) || isForbidden(stream.error);
  useEffect(() => {
    if (!forbidden) return;
    const id = setTimeout(() => navigate("/home", { replace: true }), FORBIDDEN_REDIRECT_MS);
    return () => clearTimeout(id);
  }, [forbidden, navigate]);

  const rows = useMemo(() => funnelRows(funnel.data), [funnel.data]);
  const items = asList<EventRow>(stream.data?.items);
  const pager = pagerView(
    stream.data?.total ?? 0,
    stream.data?.limit ?? filter.limit,
    stream.data?.offset ?? filter.offset,
    items.length,
  );
  const options = userOptions(rows, filter.userId);

  /** 퍼널 행 클릭 = "이 사람이 뭘 했는지 보자" — 스트림을 그 유저로 좁히고 표로 데려간다. */
  function focusUser(userId: string) {
    setFilter((f) => setEventFilterUser(f, userId));
    streamRef.current?.scrollIntoView({ block: "start" });
  }

  const header = (
    <div className={styles.headerRow}>
      <button type="button" className={styles.back} onClick={() => navigate("/home")}>
        ← 홈
      </button>
      <h1 className={styles.pageTitle}>이벤트 보드</h1>
      <span className={styles.badge}>ADMIN</span>
    </div>
  );

  if (forbidden) {
    return (
      <Layout header={header} nav>
        <div className={styles.forbidden} role="alert" data-testid="event-board-forbidden">
          <p className={styles.forbiddenTitle}>접근 권한이 없습니다</p>
          <p className={styles.forbiddenBody}>운영자 전용 페이지입니다. 잠시 후 홈으로 이동합니다.</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout header={header} nav>
      <div data-testid="event-board-page">
        {/* ── ① 유저 퍼널 — 이 화면의 주인공 ───────────────────────────── */}
        <section className={styles.section} data-testid="event-funnel-section">
          <h2 className={styles.sectionTitle}>
            유저 도달 지점
            {funnel.data?.generatedAt && (
              <span className={styles.muted}>{formatStamp(funnel.data.generatedAt)} 기준</span>
            )}
          </h2>

          {funnel.isLoading && <p className={styles.muted}>불러오는 중…</p>}
          {!funnel.isLoading && funnel.isError && (
            <p className={styles.muted} data-testid="event-funnel-error">
              퍼널을 불러오지 못했습니다
            </p>
          )}
          {!funnel.isLoading && !funnel.isError && rows.length === 0 && (
            <p className={styles.muted} data-testid="event-funnel-empty">
              아직 기록된 유저가 없습니다
            </p>
          )}

          {rows.length > 0 && (
            /* 그리드가 넓다 — 가로 스크롤은 **이 컨테이너 안에서만**. 페이지 body 가로 오버플로 0. */
            <div className={styles.tableScroll}>
              <table className={styles.table} data-testid="event-funnel-table">
                <thead>
                  <tr>
                    <th scope="col">유저</th>
                    {FUNNEL_STAGES.map((stage) => (
                      <th key={stage} scope="col" className={styles.stageHead}>
                        {FUNNEL_LABELS[stage]}
                      </th>
                    ))}
                    <th scope="col">도달</th>
                    <th scope="col">완료 경기</th>
                    <th scope="col">이벤트</th>
                    <th scope="col">마지막 활동</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.userId}
                      className={filter.userId === row.userId ? styles.rowActive : undefined}
                      data-testid={`funnel-row-${row.userId}`}
                      data-reached={reachedCount(row)}
                    >
                      <th scope="row" className={styles.userCell}>
                        <button
                          type="button"
                          className={styles.userBtn}
                          data-testid={`funnel-select-${row.userId}`}
                          onClick={() => focusUser(row.userId)}
                          title="이 유저의 이벤트만 보기"
                        >
                          {row.nickname}
                        </button>
                      </th>
                      {FUNNEL_STAGES.map((stage) => (
                        <td
                          key={stage}
                          className={styles.stageCell}
                          data-testid={`funnel-cell-${row.userId}-${stage}`}
                          data-reached={row.reached[stage] ? "true" : "false"}
                          aria-label={`${FUNNEL_LABELS[stage]} ${row.reached[stage] ? "도달" : "미도달"}`}
                        >
                          {row.reached[stage] ? "●" : "·"}
                        </td>
                      ))}
                      <td data-testid={`funnel-furthest-${row.userId}`}>{furthestLabel(row)}</td>
                      <td className={styles.num}>{row.matchesFinished}</td>
                      <td className={styles.num}>{row.eventCount}</td>
                      <td className={styles.muted}>
                        {row.lastSeenAt ? formatStamp(row.lastSeenAt) : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── ② 이벤트 스트림 ───────────────────────────────────────────── */}
        <section
          className={styles.section}
          data-testid="event-stream-section"
          ref={(el) => {
            streamRef.current = el;
          }}
        >
          <h2 className={styles.sectionTitle}>이벤트 스트림</h2>

          <div className={styles.filters}>
            <select
              className={styles.select}
              data-testid="event-filter-type"
              aria-label="이벤트 종류 필터"
              value={filter.event}
              onChange={(e) => setFilter((f) => setEventFilterEvent(f, e.target.value as EventType | ""))}
            >
              <option value="">종류 전체</option>
              {EVENT_TYPES.map((ev) => (
                <option key={ev} value={ev}>
                  {EVENT_LABELS[ev]}
                </option>
              ))}
            </select>
            <select
              className={styles.select}
              data-testid="event-filter-user"
              aria-label="유저 필터"
              value={filter.userId}
              onChange={(e) => setFilter((f) => setEventFilterUser(f, e.target.value))}
            >
              <option value="">유저 전체</option>
              {options.map((o) => (
                <option key={o.userId} value={o.userId}>
                  {o.label}
                </option>
              ))}
            </select>
            {(filter.event || filter.userId) && (
              <button
                type="button"
                className={styles.rowBtn}
                data-testid="event-filter-reset"
                onClick={() => setFilter(DEFAULT_EVENT_FILTER)}
              >
                필터 해제
              </button>
            )}
          </div>

          {stream.isLoading && <p className={styles.muted}>불러오는 중…</p>}
          {!stream.isLoading && stream.isError && (
            <p className={styles.muted} data-testid="event-stream-error">
              이벤트를 불러오지 못했습니다
            </p>
          )}
          {!stream.isLoading && !stream.isError && items.length === 0 && (
            <p className={styles.muted} data-testid="event-stream-empty">
              조건에 맞는 이벤트가 없습니다
            </p>
          )}

          {items.length > 0 && (
            <>
              <div className={styles.tableScroll}>
                <table className={styles.table} data-testid="event-stream-table">
                  <thead>
                    <tr>
                      <th scope="col">시각</th>
                      <th scope="col">종류</th>
                      <th scope="col">유저</th>
                      <th scope="col">상세</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const mode = modeOf(item.props);
                      return (
                        <tr key={item.id} data-testid={`event-row-${item.id}`} data-event={item.event}>
                          <td className={styles.muted}>{formatStamp(item.occurredAt)}</td>
                          <td>
                            {eventLabel(item.event)}
                            {mode && <span className={styles.modeBadge}>{mode}</span>}
                          </td>
                          <td>
                            <button
                              type="button"
                              className={styles.userBtn}
                              data-testid={`event-user-${item.id}`}
                              onClick={() => focusUser(item.userId)}
                              title="이 유저의 이벤트만 보기"
                            >
                              {item.nickname || item.userId}
                            </button>
                          </td>
                          <td className={styles.props}>{summarizeProps(item.props)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className={styles.pager}>
                <button
                  type="button"
                  className={styles.rowBtn}
                  data-testid="event-page-prev"
                  disabled={!pager.canPrev}
                  onClick={() => setFilter((f) => setEventFilterOffset(f, pager.prevOffset))}
                >
                  ← 이전
                </button>
                <span className={styles.muted} data-testid="event-page-range">
                  {pager.rangeLabel}
                </span>
                <button
                  type="button"
                  className={styles.rowBtn}
                  data-testid="event-page-next"
                  disabled={!pager.canNext}
                  onClick={() => setFilter((f) => setEventFilterOffset(f, pager.nextOffset))}
                >
                  다음 →
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </Layout>
  );
}

function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}
