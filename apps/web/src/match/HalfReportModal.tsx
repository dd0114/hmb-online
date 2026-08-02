import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Modal } from "../common/Modal";
import { useHalfLog, usePlayers } from "../api/hooks";
import { buildHalfReportRows, halfReportScore, type HalfReportEventLike, type NameOf } from "./half-report";
import { halfLabelOf } from "./skip-mode";
import { topRatedOfHalf } from "./skip-report-rating";
import type { ScorePair } from "./match-logic";
import styles from "./HalfReportModal.module.css";

/** 뒤에 비치는 카드 최대 장수 — `NoticePopup` 과 같은 값(그 이상은 시각 소음). */
const MAX_BEHIND = 2;

export interface HalfReportModalProps {
  matchId: string;
  /** 리포트가 말하는 하프(스킵한 하프). */
  half: 1 | 2;
  homeName: string;
  awayName: string;
  /** 내가 선 사이드 — 평점 카드의 팀 필터에 쓴다. 모르면 null(양 팀 통합). */
  myTeamSide?: "home" | "away" | null;
  /** 이 하프 앞에 확정된 스코어(#233) — 후반 리포트가 경기 누적을 말하게 한다. */
  baseline?: ScorePair | null;
  onClose: () => void;
}

/**
 * 하프 리포트 팝업 — **"공지사항처럼" 뜨는 카드 스택** (#421 W2, hero 요구).
 *
 * ── 왜 `NoticePopup` 을 일반화하지 않고 새로 만들었나 ──────────────────────────────────
 * 스택 연출(뒤 카드 그림자·페이저·도트·한 장씩 넘김)은 `lobby/NoticePopup` 이 이미 하고 있고
 * **그 연출은 재발명하지 않는다** — 여기 CSS 는 `NoticePopup.module.css` 의 구조를 그대로 따른다
 * (뷰포트 여백 `100lvh − 100svh` #386 · `.stack` 플렉스 #292 포함).
 *
 * 그런데 **컴포넌트 자체를 일반화하지는 않았다**: `NoticePopup` 의 카드는 `Notice`(제목+본문
 * **문자열**)에 묶여 있고 억제 저장소(`notice-logic`)·`NoticeBody` 마크업 렌더까지 한 몸이다.
 * 여기 카드는 문자열 본문이 아니라 **구조화된 목록·스탯**이라, 일반화하려면 그 컴포넌트의 props
 * 모양을 바꿔야 하고 그 순간 로비 공지의 계약 5스펙(p248·p248b·p292·p386·p293)이 전부 사정권에
 * 들어온다. **로비 공지 동작을 깨지 않는 쪽**을 골랐다.
 *
 * 접근성 셸(role=dialog·aria-modal·포커스 트랩/복원·Escape·백드롭)은 `common/Modal` 그대로다 —
 * 그건 재구현하지 않는다.
 *
 * ── 억제("24시간 안 보기")는 이 화면에 없다 ────────────────────────────────────────────
 * 저절로 뜨는 공지가 아니라 **유저가 스킵을 눌러서** 연 화면이다. `suppressible` 개념 자체가
 * 성립하지 않으므로 버튼을 그리지 않는다(선례 = `ShareNoticePage` 의 `suppressible={false}`).
 *
 * ── 평점 카드가 없으면 스택은 1장이다 ─────────────────────────────────────────────────
 * 평점 SoT(#403)는 아직 main 에 없어 `topRatedOfHalf` 가 `null` 을 준다(`skip-report-rating`).
 * 그때 스택은 **타임라인 1장**으로 줄고 페이저·도트도 사라진다 — 모듈이 오기 전에도 스킵
 * 플로우가 깨지지 않는 것이 그 격리막의 목적이다.
 */
export function HalfReportModal({
  matchId,
  half,
  homeName,
  awayName,
  myTeamSide = null,
  baseline = null,
  onClose,
}: HalfReportModalProps) {
  const { data: log, isLoading } = useHalfLog(matchId, half);
  const { data: catalog } = usePlayers();

  /**
   * 선수 이름 조회. **`(team, playerId)` 축을 받는다**(#231/#324 — 같은 선수가 양 팀에 뛴다).
   * 지금 출처(`/api/players` 카탈로그)는 id 하나로 답하지만, 시그니처가 팀을 요구해야 소비자가
   * 그 축을 접지 않는다.
   *
   * ⚠️ **응답 형태를 믿지 않는다** — 구 서버·목이 200 `{}` 를 주면 `.map` 이 던져 리포트가
   * 통째로 흰 화면이 된다(apps/web CLAUDE.md, growth-mock G4 실적). 이름은 부가 정보다.
   */
  const nameOf = useMemo<NameOf>(() => {
    const byId = Array.isArray(catalog)
      ? new Map(catalog.map((p) => [p.id, p.name] as const))
      : new Map<string, string>();
    return (_team, playerId) => (playerId ? byId.get(playerId) : undefined);
  }, [catalog]);

  const events = useMemo(
    () => ((log?.events ?? []) as unknown as HalfReportEventLike[]) ?? [],
    [log],
  );
  const rows = useMemo(() => buildHalfReportRows(events, { nameOf }), [events, nameOf]);
  const score = useMemo(() => halfReportScore(events, baseline), [events, baseline]);
  // 팀 필터 = **우리 팀**이 기본이다(유저가 자기 팀 서사를 읽는 화면). 사이드를 모르면 양 팀 통합.
  const top = useMemo(
    () => topRatedOfHalf(log ?? null, myTeamSide ? { team: myTeamSide } : {}),
    [log, myTeamSide],
  );

  const label = halfLabelOf(half);
  // 팀을 모르는 이벤트에 홈 이름을 붙이지 않는다 — 없는 소속을 지어내면 그게 곧 오독이다.
  const teamNameOf = (team: string | undefined) =>
    team === "home" ? homeName : team === "away" ? awayName : "";

  const cards: { id: string; title: string; body: ReactNode }[] = [
    {
      id: "timeline",
      title: `${label} 리포트`,
      body: (
        <ol className={styles.rows} data-testid="half-report-timeline">
          {rows.map((r) => (
            <li key={r.key} className={styles.row} data-testid={`half-report-row-${r.tick}`} data-kind={r.kind}>
              <span className={styles.clock}>{r.clock}</span>
              <span className={styles.icon} aria-hidden="true">
                {r.icon}
              </span>
              <span className={styles.what}>
                {r.label}
                {r.secondYellow && <span className={styles.tag}>경고 누적</span>}
              </span>
              <span className={styles.who}>
                {r.playerName ?? ""}
                <span className={styles.side}>{teamNameOf(r.team)}</span>
              </span>
            </li>
          ))}
          {rows.length === 0 && (
            <li className={styles.empty} data-testid="half-report-empty">
              {isLoading ? "기록 불러오는 중…" : `${label}에는 골·카드 기록이 없습니다`}
            </li>
          )}
        </ol>
      ),
    },
  ];

  if (top) {
    cards.push({
      id: "top-rated",
      title: `${label} 주요 인물`,
      body: (
        <div className={styles.motm} data-testid="half-report-motm">
          <span className={styles.motmName} data-testid="half-report-motm-name">
            {nameOf(top.team, top.playerId) ?? top.playerId}
          </span>
          <span className={styles.motmTeam}>{teamNameOf(top.team)}</span>
          <span className={styles.motmRating} data-testid="half-report-motm-rating">
            {top.rating.toFixed(1)}
          </span>
        </div>
      ),
    });
  }

  const [index, setIndex] = useState(0);
  const total = cards.length;
  const current = cards[Math.min(index, total - 1)];
  if (!current) return null;

  const remaining = total - index - 1;
  const behind = Math.min(Math.max(remaining, 0), MAX_BEHIND);
  const last = index + 1 >= total;

  /** `NoticePopup` 과 같은 은유 — 주 버튼이 "이 장을 처리하고 다음 장"이다. */
  const advance = () => {
    if (last) onClose();
    else setIndex((i) => i + 1);
  };

  return (
    <Modal
      // 장이 바뀌면 새 카드로 포커스가 옮겨가도록 다시 마운트한다(스크린리더가 새 제목을 읽는다).
      key={current.id}
      onClose={onClose}
      labelledBy="half-report-title"
      overlayClassName={styles.overlay}
      className={styles.stack}
      testId="half-report"
      overlayTestId="half-report-overlay"
      initialFocus='[data-testid="half-report-next"]'
    >
      {Array.from({ length: behind }, (_, i) => (
        <div
          key={`behind-${i}`}
          className={`${styles.behind} ${i === 0 ? styles.behind1 : styles.behind2}`}
          data-testid={`half-report-behind-${i + 1}`}
          aria-hidden="true"
        />
      ))}

      <div className={styles.card} data-testid="half-report-card" data-card={current.id}>
        <div className={styles.top}>
          <span className={styles.kicker}>리포트</span>
          {total > 1 && (
            <span className={styles.pager} data-testid="half-report-pager">
              {index + 1} / {total}
            </span>
          )}
        </div>

        <h2 id="half-report-title" className={styles.title} data-testid="half-report-title">
          {current.title}
        </h2>

        <p className={styles.meta} data-testid="half-report-score">
          {homeName} {score.home} : {score.away} {awayName}
        </p>

        <ReportBody>{current.body}</ReportBody>

        {total > 1 && (
          <div className={styles.dots} data-testid="half-report-dots">
            {cards.map((c, i) => (
              <span
                key={c.id}
                className={`${styles.dot} ${i === index ? styles.dotOn : ""}`}
                data-on={i === index ? "true" : undefined}
              />
            ))}
          </div>
        )}

        <div className={styles.actions}>
          <button type="button" className={styles.primary} data-testid="half-report-next" onClick={advance}>
            {last ? "닫기" : "다음"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * 본문 스크롤 영역 (#292 의 교훈을 그대로 적용).
 *
 * ⚠️ **"스크롤바를 넣었다"는 폰에서 보장되지 않는다** — iOS 사파리는 `::-webkit-scrollbar` 를 아예
 * 안 그리고 모바일 크롬은 오버레이라 폭이 0 이다. 실제로 일하는 신호는 **하단 페이드**라서, 넘칠
 * 때만 켜고 **끝에 닿으면 끈다**(남아 있으면 그것대로 거짓 신호다). 골이 많이 난 하프면 목록이
 * 카드 높이를 넘는다 — 그때 접힌 것을 알 방법이 이것뿐이다.
 */
function ReportBody({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const overflow = el.scrollHeight - el.clientHeight;
    // 1px 여유 — 소수점 레이아웃에서 끝에 닿아도 0 이 되지 않는다.
    setMore(overflow > 1 && el.scrollTop < overflow - 1);
  }, []);

  useEffect(() => {
    measure();
    const el = scrollRef.current;
    if (!el) return;
    // 마운트 때 한 번만 재면 목록이 늦게 채워질 때(로그 도착) 신호가 안 붙는다.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    const content = el.firstElementChild;
    if (content) ro?.observe(content);
    return () => ro?.disconnect();
  }, [measure, children]);

  return (
    <div className={styles.bodyArea} data-more={more ? "true" : "false"} data-testid="half-report-body-area">
      <div
        ref={scrollRef}
        className={styles.body}
        data-testid="half-report-body"
        onScroll={measure}
        // 키보드만 쓰는 사용자도 본문을 내릴 수 있어야 한다(버튼 하나만 포커서블이면 갇힌다).
        tabIndex={0}
        role="group"
        aria-label="리포트 본문"
      >
        {children}
      </div>
    </div>
  );
}
