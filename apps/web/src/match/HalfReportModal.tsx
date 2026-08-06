import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Modal } from "../common/Modal";
import { useHalfLog, usePlayers } from "../api/hooks";
import { usePlayerNames } from "../common/player-names";
import { buildHalfReportRows, halfReportScore, type HalfReportEventLike, type NameOf } from "./half-report";
import { halfLabelOf } from "./skip-mode";
import { highlightStatsOf, topRatedOfHalf } from "./skip-report-rating";
import { playerKey } from "./player-stats";
import { buildRosterMeta, gkKeysOf, positionsOf, ratingTier } from "./player-stats-view";
import type { ScorePair } from "./match-logic";
import styles from "./HalfReportModal.module.css";

/** 뒤에 비치는 카드 최대 장수 — `NoticePopup` 과 같은 값(그 이상은 시각 소음). */
const MAX_BEHIND = 2;

/**
 * 스택의 카드 한 장. #424 가 **브릿지 카드를 이 스택에 얹기 위해** 뽑아낸 모양이다 —
 * 리포트와 브릿지가 **하나의 카드 스택 · 하나의 닫기**여야 z-index·포커스 트랩 싸움이 생기지 않는다
 * (설계 §5: 레이어 분리안 기각).
 */
export interface ReportStackCard {
  id: string;
  title: string;
  body: ReactNode;
  /** 카드 상단 kicker. 기본은 `리포트`. */
  kicker?: string;
  /** 이 장이 마지막일 때 주 버튼 라벨. 기본은 `닫기`. */
  ctaLabel?: string;
  /** 카드 시각 강조(조정 포인트 §11-10) — 호출부 CSS 모듈의 클래스를 그대로 얹는다. */
  className?: string;
}

export interface HalfReportModalProps {
  matchId: string;
  /**
   * 리포트가 말하는 하프(스킵한 하프). **`null` 이면 리포트 카드가 없다** — 스킵 없이 열린 브릿지가
   * 이 스택을 그대로 쓰는 경로다(그때 카드는 `extraCards` 뿐이고 하프 로그도 조회하지 않는다).
   */
  half: 1 | 2 | null;
  homeName: string;
  awayName: string;
  /** 내가 선 사이드 — 평점 카드의 팀 필터에 쓴다. 모르면 null(양 팀 통합). */
  myTeamSide?: "home" | "away" | null;
  /** 이 하프 앞에 확정된 스코어(#233) — 후반 리포트가 경기 누적을 말하게 한다. */
  baseline?: ScorePair | null;
  /** 리포트 카드 **뒤에** 붙는 카드들(#424 브릿지). 기본 = 없음 → 현행 동작 그대로. */
  extraCards?: readonly ReportStackCard[];
  /**
   * 스코어 줄 값. `half == null`(로그를 안 읽는 경로)에서만 쓰인다 —
   * **`null` 이면 줄을 그리지 않는다**(0 : 0 을 지어내지 않는다).
   */
  score?: ScorePair | null;
  /**
   * testid 접두. 기본 `half-report`(=리포트 스택). 리포트가 없는 브릿지 전용 스택은 다른 이름을
   * 받아야 한다 — 안 그러면 "리포트가 뜨지 않는다"를 단언하는 계약(#421 i)이 브릿지를 리포트로 오인한다.
   */
  testIdBase?: string;
  /**
   * **마지막 장**의 주 버튼 라벨(기본 `닫기`).
   *
   * 카드 배열의 마지막이 곧 끝맺음 지점인데, `extraCards` 가 앞으로 오면(#456) 그 자리가 리포트
   * 카드가 되어 방향을 말할 수 없다 — 호출부가 갈 곳을 알고 있으므로 여기로 내려 준다.
   */
  finalCtaLabel?: string;
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
 * 평점 SoT(#403 `player-stats.ts`)가 머지돼 `topRatedOfHalf` 는 **실제 인물을 준다**(W7 플립).
 * 그래도 `null` 경로는 남는다 — 기록이 없는 하프·손상 로그·아직 안 온 로그. 그때 스택은
 * **타임라인 1장**으로 줄고 페이저·도트도 사라진다(계약 = `HalfReportModal.test.ts`).
 *
 * 카드가 그리는 값은 **하나도 여기서 세지 않는다**: 평점·기록은 `skip-report-rating`(→ #403 집계),
 * 등번호·포지션은 `player-stats-view.buildRosterMeta`, 평점 등급은 `ratingTier`,
 * **선수 이름은 `common/player-names` 초크포인트**(#406 요구 6 — 두 카드 모두 `short` 축) 다.
 */
export function HalfReportModal({
  matchId,
  half,
  homeName,
  awayName,
  myTeamSide = null,
  baseline = null,
  extraCards,
  score: scoreOverride = null,
  testIdBase = "half-report",
  finalCtaLabel,
  onClose,
}: HalfReportModalProps) {
  // half 가 없으면 조회하지 않는다 — 리포트 카드가 없는 스택이 하프 로그를 부르면 409(아직 안 열린
  // 하프)를 유발하거나 쓸데없이 로그를 끌어온다.
  const { data: log, isLoading } = useHalfLog(matchId, half ?? 1, half != null);
  const { data: catalog } = usePlayers();
  const tid = testIdBase;

  /**
   * 선수 이름 조회. **`(team, playerId)` 축을 받는다**(#231/#324 — 같은 선수가 양 팀에 뛴다).
   * 지금 출처(`/api/players` 카탈로그)는 id 하나로 답하지만, 시그니처가 팀을 요구해야 소비자가
   * 그 축을 접지 않는다.
   *
   * **축 = `short`**(밀집). 타임라인 행은 `[시계][아이콘][사건][이름][팀]` 이라 이름 옆에 조각이
   * 네 개 앉는다(축 규칙 = `common/player-names.ts` 머리말).
   *
   * ⚠️ **표를 여기서 만들지 마라**(#406 요구 6, W8). 구 코드는 `catalog.map((p) => [p.id, p.name])`
   * 로 **이름 사다리를 두 번째로 선언**하고 있었다 — 카탈로그 우선순위도, 짧은 축도, `미상 선수`
   * 폴백도 없어서 #411 스위치 날 이 카드만 옛 규칙으로 남는다.
   *
   * ⚠️ **응답 형태를 믿지 않는다** — 구 서버·목이 200 `{}` 를 주면 `.map` 이 던져 리포트가
   * 통째로 흰 화면이 된다(apps/web CLAUDE.md, growth-mock G4 실적). 초크포인트가 그 형태를
   * 흡수하므로(`buildPlayerNames` 는 배열·Map 이 아니면 빈 표) 여기서 가드가 사라진 게 아니다.
   *
   * 선수가 없는 사건(킥오프 등)은 계속 `undefined` = **이름 칸을 비운다**. 없는 소속·없는 사람을
   * 지어내지 않는 것이 이 행의 규율이고(`half-report.ts` `playerName` 주석), `미상 선수` 는
   * "선수가 있는데 누군지 모른다"는 다른 사실이다.
   */
  const names = usePlayerNames();
  const nameOf = useMemo<NameOf>(
    () => (_team, playerId) => (playerId ? names.short(playerId) : undefined),
    [names],
  );

  const events = useMemo(
    () => ((log?.events ?? []) as unknown as HalfReportEventLike[]) ?? [],
    [log],
  );
  const rows = useMemo(() => buildHalfReportRows(events, { nameOf }), [events, nameOf]);
  const logScore = useMemo(() => halfReportScore(events, baseline), [events, baseline]);
  const score = half != null ? logScore : scoreOverride;

  /**
   * 표시 메타(이름·등번호·포지션)와 평점 보정 입력을 **한 번에** 만든다 — 둘 다 #403 `player-stats-view`
   * 의 것을 **소비**한다(#57: 로스터·등번호 규칙을 여기서 다시 짜지 않는다). 등번호가 경기장 토큰과
   * 같은 규칙에서 나오는 것도 그 모듈이 보장한다.
   */
  const roster = useMemo(() => buildRosterMeta(half == null ? null : log ?? null, catalog), [half, log, catalog]);
  const gkKeys = useMemo(() => gkKeysOf(roster), [roster]);
  const positions = useMemo(() => positionsOf(roster), [roster]);

  // 팀 필터 = **우리 팀**이 기본이다(유저가 자기 팀 서사를 읽는 화면). 사이드를 모르면 양 팀 통합.
  const top = useMemo(
    () =>
      half == null
        ? null
        : topRatedOfHalf(log ?? null, {
            ...(myTeamSide ? { team: myTeamSide } : {}),
            gkKeys,
            positions,
          }),
    [half, log, myTeamSide, gkKeys, positions],
  );

  const label = halfLabelOf(half ?? 1);
  // 팀을 모르는 이벤트에 홈 이름을 붙이지 않는다 — 없는 소속을 지어내면 그게 곧 오독이다.
  const teamNameOf = (team: string | undefined) =>
    team === "home" ? homeName : team === "away" ? awayName : "";

  const cards: ReportStackCard[] = half == null ? [] : [
    {
      id: "timeline",
      title: `${label} 리포트`,
      body: (
        <ol className={styles.rows} data-testid={`${tid}-timeline`}>
          {rows.map((r) => (
            /*
             * `data-team` 은 **배정한 쪽이 다는 라벨**이다(#456 B4) — 색을 좌표나 순서로 되추론하는
             * 자리를 만들지 않는다. 팀을 모르는 이벤트(휘슬 등)에는 **속성 자체를 안 단다**:
             * 없는 소속을 지어내지 않는다는 위 `teamNameOf` 와 같은 규율이고, CSS 도 그 행엔
             * 색을 안 칠한다.
             */
            <li
              key={r.key}
              className={styles.row}
              data-testid={`${tid}-row-${r.tick}`}
              data-kind={r.kind}
              {...(r.team === "home" || r.team === "away" ? { "data-team": r.team } : {})}
            >
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
                {/*
                  ⚠️ 색은 **덧붙는 채널이다** — 팀 이름 글자를 지우고 색만 남기지 마라(#262 규율:
                  단일 색 채널 금지). `data-team-label` 은 계약이 "그 색이 스코어바와 같은 축인가"
                  를 재는 앵커다.
                */}
                <span className={styles.side} data-team-label="">
                  {teamNameOf(r.team)}
                </span>
              </span>
            </li>
          ))}
          {rows.length === 0 && (
            <li className={styles.empty} data-testid={`${tid}-empty`}>
              {isLoading ? "기록 불러오는 중…" : `${label}에는 골·카드 기록이 없습니다`}
            </li>
          )}
        </ol>
      ),
    },
  ];

  if (top) {
    /*
     * 등번호·포지션은 로스터에서. **이름은 로스터가 아니라 초크포인트(`names`)에서** 온다 —
     * 로스터의 이름도 같은 초크포인트가 만들지만, 로스터는 등번호를 만들 수 있는 선수만 담아서
     * 트림된 로그에서는 비어 있다(아래 ⚠️). 이름을 그 표에 매달면 그때 이름도 같이 사라진다.
     * ⚠️ 로그에 `tickSnapshots` 가 없으면(트림된 로그) 로스터가 비어 등번호가 없다 —
     *    그때 번호 자리를 `–` 로 두고 **이름은 계속 나온다**. 부가 정보가 주 정보를 죽이지 않는다.
     */
    const meta = roster.get(playerKey(top.team, top.playerId));
    const stats = highlightStatsOf(top.line, { isGk: meta?.position === "GK" });
    // 평점 뱃지 등급은 선수 탭과 **같은 판정**(#403 `ratingTier`)을 쓴다 — 화면 간 색이 갈리지 않게.
    const tier = ratingTier(top.rating, top.isMotm);
    cards.push({
      id: "top-rated",
      title: `${label} 주요 인물`,
      body: (
        <div className={styles.motm} data-testid={`${tid}-motm`} data-tier={tier}>
          <p className={styles.motmWho}>
            {/* 팀색 원 + 등번호 — 경기장 토큰·선수 탭과 같은 표현(#285 정책 절). */}
            <i
              className={`${styles.motmNum} ${top.team === "home" ? styles.motmNumHome : styles.motmNumAway}`}
              data-testid={`${tid}-motm-num`}
              aria-hidden="true"
            >
              {meta?.num ?? "–"}
            </i>
            {/*
              축 = `short`(밀집) — 이름 옆에 번호 원과 포지션 칩이 **같은 flex 줄**에 앉는다.
              ⚠️ 여기서 `full` 을 쓰면 **같은 스택 안에서 같은 사람이 두 이름으로 불린다**
              (앞 장 타임라인 행은 `short` 다). 오늘은 두 축의 값이 같아 화면 차이가 0이라
              안 보이고, #411 스위치 날 갈라진다.
              ⚠️ 구 코드는 `meta?.name ?? nameOf(…) ?? top.playerId` 라 3단이 `playerId` 였다.
              지금은 `roster` 와 `names` 가 **같은 초크포인트**에서 같은 id 로 만든 같은 값이라
              사다리가 하나로 접힌다.
            */}
            <span className={styles.motmName} data-testid={`${tid}-motm-name`}>
              {names.short(top.playerId)}
            </span>
            {meta?.position && <span className={styles.motmPos}>{meta.position}</span>}
          </p>
          <span className={styles.motmTeam}>{teamNameOf(top.team)}</span>
          <span className={styles.motmRating} data-tier={tier} data-testid={`${tid}-motm-rating`}>
            {top.rating.toFixed(1)}
          </span>
          {stats.length > 0 && (
            <ul className={styles.motmStats} data-testid={`${tid}-motm-stats`}>
              {stats.map((s) => (
                <li key={s.label} className={styles.motmStat} data-stat={s.label}>
                  <b>{s.value}</b>
                  <span>{s.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ),
    });
  }

  /*
   * #456: 브릿지 카드는 **첫 장**이다. 구 규칙은 "언제나 마지막"이었고 근거는 *"무슨 일이 있었나 →
   * 이제 뭐가 오나"* 순서였는데(설계 §3.2), 그러면 스킵 경로에서 브릿지 도달에 **클릭 2회**가 걸려
   * 유저 기억에는 리포트만 남았다(#456 실사 가설 3, hero: *"경기 브릿지 왜 없어?"*).
   * 전환은 **전환이 일어나는 순간**에 보여야 한다 = 먼저 알리고 자세한 것을 뒤에 붙인다.
   *
   * ⚠️ 대가는 `finalCtaLabel` 이 갚는다 — 구 규칙에서는 마지막 장이 브릿지라 그 `ctaLabel`
   * (`감독시간으로`·`보상과 결과 보기`)이 곧 끝맺음 신호였다. 순서를 뒤집으면 마지막 장이
   * 리포트가 되어 버튼이 `닫기` 로 퇴화하고, **"다음 화면이 무엇인가"의 유일한 신호가 사라진다.**
   */
  if (extraCards?.length) cards.unshift(...extraCards);

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
      labelledBy={`${tid}-title`}
      overlayClassName={styles.overlay}
      className={styles.stack}
      testId={tid}
      overlayTestId={`${tid}-overlay`}
      initialFocus={`[data-testid="${tid}-next"]`}
    >
      {Array.from({ length: behind }, (_, i) => (
        <div
          key={`behind-${i}`}
          className={`${styles.behind} ${i === 0 ? styles.behind1 : styles.behind2}`}
          data-testid={`${tid}-behind-${i + 1}`}
          aria-hidden="true"
        />
      ))}

      <div
        className={`${styles.card} ${current.className ?? ""}`}
        data-testid={`${tid}-card`}
        data-card={current.id}
      >
        <div className={styles.top}>
          <span className={styles.kicker}>{current.kicker ?? "리포트"}</span>
          {total > 1 && (
            <span className={styles.pager} data-testid={`${tid}-pager`}>
              {index + 1} / {total}
            </span>
          )}
        </div>

        <h2 id={`${tid}-title`} className={styles.title} data-testid={`${tid}-title`}>
          {current.title}
        </h2>

        {score && (
          <p className={styles.meta} data-testid={`${tid}-score`}>
            {homeName} {score.home} : {score.away} {awayName}
          </p>
        )}

        <ReportBody testId={tid}>{current.body}</ReportBody>

        {total > 1 && (
          <div className={styles.dots} data-testid={`${tid}-dots`}>
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
          <button
            type="button"
            className={styles.primary}
            data-testid={`${tid}-next`}
            /* 현재 장이 무엇인지 버튼에도 남긴다 — 계약이 "브릿지 CTA"를 접두 이름 없이 겨눌 수 있게. */
            data-card={current.id}
            onClick={advance}
          >
            {last ? (current.ctaLabel ?? finalCtaLabel ?? "닫기") : "다음"}
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
function ReportBody({ children, testId }: { children: ReactNode; testId: string }) {
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
    <div className={styles.bodyArea} data-more={more ? "true" : "false"} data-testid={`${testId}-body-area`}>
      <div
        ref={scrollRef}
        className={styles.body}
        data-testid={`${testId}-body`}
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
