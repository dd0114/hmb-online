import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLeague, useStartLeague, useStartNextLeagueMatch } from "../api/hooks-v2";
import { useMe } from "../api/hooks";
import type { LeagueFixture, LeagueSeason, LeagueStanding } from "../api/v2";
import type { LeagueResponseP3, LeagueSeasonReward } from "../api/p3";
import { ApiError } from "../api/client";
import { Layout } from "../common/Layout";
import { Amount, useCurrency } from "../common/Amount";
import { CURRENCY_GEM, CURRENCY_POINT, formatAmount } from "../common/currency";
import { ErrorToast } from "../common/ErrorToast";
import { matchInProgressIdOf } from "../common/match-lock";
import type { SeasonSummary } from "./league-logic";
import {
  divisionLabel,
  divisionOutcome,
  divisionRuleText,
  fixtureScore,
  formatAwardedAt,
  groupByRound,
  isGranted,
  isSeasonFinished,
  pickDivision,
  pickMeDivision,
  pickSeasonReward,
  seasonRewardView,
  seasonSummary,
  sortByRank,
  teamNameMap,
  userRank,
  zoneOfRank,
} from "./league-logic";
import type { DivisionInfo } from "./league-logic";
import styles from "./LeaguePage.module.css";

export function LeaguePage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch, isFetching } = useLeague();
  const { data: me } = useMe();
  const [error, setError] = useState<string | null>(null);

  const season = data?.season ?? null;
  // 헤더 뱃지: 시즌이 있으면 **그 시즌에 박제된** 값(그 시즌을 무슨 디비전으로 치렀는지),
  // 없으면 유저의 현재 값(#268). 시즌 종료 화면에서 승급했더라도 뱃지는 **치른 시즌**의 것이 맞다.
  const headerDivision = pickDivision(season) ?? pickMeDivision(me);
  // Phase3 additive — 구 서버(필드 부재)면 null → 기존 종료 화면 그대로(폴백).
  const reward = useMemo(() => pickSeasonReward(data as LeagueResponseP3 | undefined), [data]);

  const header = (
    <div className={styles.headerRow}>
      <button type="button" className={styles.back} onClick={() => navigate("/lobby")}>
        ← 로비
      </button>
      <h1 className={styles.pageTitle}>리그</h1>
      {season && (
        <span className={styles.seasonTag} data-testid="season-tag">
          시즌 {season.seasonNo}
        </span>
      )}
      {/* 디비전 뱃지 — 구 서버(필드 부재)면 렌더 안 함(폴백). 시즌이 없어도 뜬다(#268). */}
      {divisionLabel(headerDivision) && (
        <span className={styles.divisionTag} data-testid="division-tag">
          {divisionLabel(headerDivision)}
        </span>
      )}
    </div>
  );

  return (
    <Layout header={header} nav>
      {isError && <ErrorToast message="리그 정보를 불러오지 못했습니다" />}
      {isLoading && <p className={styles.pending}>불러오는 중…</p>}

      {!isLoading && !season && <StartSeasonCta onError={setError} division={headerDivision} />}
      {season && !isSeasonFinished(season) && <Dashboard season={season} onError={setError} />}
      {season && isSeasonFinished(season) && (
        <SeasonEnd
          season={season}
          reward={reward}
          onError={setError}
          onRefresh={() => void refetch()}
          refreshing={isFetching}
        />
      )}

      <ErrorToast message={error} onDismiss={() => setError(null)} />
    </Layout>
  );
}

function useStartError(onError: (m: string) => void) {
  return (err: unknown) => {
    if (err instanceof ApiError && err.code === "LEAGUE_INVALID") {
      onError(`리그를 시작할 수 없습니다 — ${err.message}`);
    } else {
      onError(err instanceof Error ? err.message : "리그 시작에 실패했습니다");
    }
  };
}

function StartSeasonCta({
  onError,
  division,
}: {
  onError: (m: string) => void;
  division?: DivisionInfo | null;
}) {
  const start = useStartLeague();
  const handleErr = useStartError(onError);
  return (
    <div className={styles.cta} data-testid="league-start-cta">
      <p className={styles.ctaTitle}>리그에 도전하세요</p>
      <p className={styles.ctaDesc}>봇 9팀과 더블 라운드로빈 18라운드. 승점 3-1-0, 시즌 종료 시 순위 보상.</p>
      {/* 시즌이 없는 구간에서도 "내가 몇 부인지" 를 보여준다(#268) — 승급/강등은 시즌 **사이**에
          일어나므로, 다음 시즌을 시작하기 직전이 그게 가장 궁금한 순간이다. */}
      {divisionLabel(division ?? null) && (
        <p className={styles.ctaDivision} data-testid="cta-division">
          다음 시즌 <strong>{divisionLabel(division ?? null)}</strong> 에서 시작합니다
        </p>
      )}
      <button
        type="button"
        className={styles.primary}
        disabled={start.isPending}
        data-testid="start-league"
        onClick={() => start.mutate(undefined, { onError: handleErr })}
      >
        {start.isPending ? "시즌 생성 중…" : "리그 시작"}
      </button>
    </div>
  );
}

function Dashboard({ season, onError }: { season: LeagueSeason; onError: (m: string) => void }) {
  const navigate = useNavigate();
  const next = useStartNextLeagueMatch();
  const names = useMemo(() => teamNameMap(season.teams), [season.teams]);
  const nextFixture = season.nextUserFixture ?? null;

  function startNext() {
    next.mutate(undefined, {
      onSuccess: (res) =>
        navigate(`/match/${res.match.id}`, { state: { leagueRound: res.fixture.round } }),
      onError: (err) => {
        // #217: "이미 진행 중인 경기가 있다"(409)는 실패가 아니라 **이어가라는 안내**다.
        // 로비 [연습 경기] 와 같은 처리 — 문구만 띄우면 유저는 이동 링크 없는 막다른 길에 선다.
        // (/league 는 MatchLockGate 가 locked && !abandonable 일 때만 막으므로 브리핑·사고
        //  매치에서는 이 화면에 도달할 수 있고, 그때 이 분기가 실제로 탄다.)
        const resumeId = matchInProgressIdOf(err);
        if (resumeId) {
          navigate(`/match/${resumeId}`);
          return;
        }
        if (err instanceof ApiError && err.code === "LEAGUE_INVALID") {
          onError(`다음 경기를 시작할 수 없습니다 — ${err.message}`);
        } else {
          onError(err instanceof Error ? err.message : "다음 경기 시작 실패");
        }
      },
    });
  }

  return (
    <div data-testid="league-dashboard">
      <section className={styles.nextCard}>
        {nextFixture ? (
          <>
            <div className={styles.nextInfo}>
              <span className={styles.nextRound}>R{nextFixture.round}</span>
              <span className={styles.nextMatchup}>
                {names.get(nextFixture.homeTeam) ?? nextFixture.homeTeam}
                <span className={styles.vs}>
                  {nextFixture.homeTeam && season.teams.find((t) => t.teamId === nextFixture.homeTeam)?.isUser
                    ? " (홈)"
                    : " (원정)"}
                </span>
                {" vs "}
                {names.get(nextFixture.awayTeam) ?? nextFixture.awayTeam}
              </span>
            </div>
            <button
              type="button"
              className={styles.primary}
              disabled={next.isPending}
              data-testid="next-match"
              onClick={startNext}
            >
              {next.isPending ? "경기 준비 중…" : "다음 경기"}
            </button>
          </>
        ) : (
          <p className={styles.pending}>남은 유저 경기가 없습니다 — 시즌 정산 대기.</p>
        )}
      </section>

      {/* ≥1024px: 순위표·일정 병렬(LLD §7). 모바일은 세로 스택. */}
      <div className={styles.dashGrid}>
        <StandingsTable standings={season.standings} division={pickDivision(season)} />
        <Schedule fixtures={season.fixtures} names={names} />
      </div>
    </div>
  );
}

function StandingsTable({
  standings,
  division,
}: {
  standings: LeagueStanding[];
  division?: DivisionInfo | null;
}) {
  const sorted = useMemo(() => sortByRank(standings), [standings]);
  const rule = divisionRuleText(division ?? null);
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>순위표</h3>
        {/* 컷은 서버 값으로만 만든다 — 클라가 "1~2위"를 기억하면 규칙이 바뀔 때 거짓말이 된다. */}
        {rule && (
          <span className={styles.ruleHint} data-testid="division-rule">
            {rule}
          </span>
        )}
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table} data-testid="standings">
          <thead>
            <tr>
              <th className={styles.rankCol}>#</th>
              <th className={styles.teamCol}>팀</th>
              <th>경기</th>
              <th>승</th>
              <th>무</th>
              <th>패</th>
              <th>득실</th>
              <th className={styles.ptsCol}>승점</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => {
              const zone = zoneOfRank(s.rank, division ?? null);
              return (
              <tr
                key={s.teamId}
                className={[
                  s.isUser ? styles.userRow : "",
                  zone === "promote" ? styles.promoteRow : "",
                  zone === "relegate" ? styles.relegateRow : "",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined}
                data-testid={`standing-${s.teamId}`}
                data-user={s.isUser ? "true" : undefined}
                data-zone={zone === "none" ? undefined : zone}
              >
                <td className={styles.rankCol}>
                  {s.rank}
                  {/*
                    색 단일 채널이면 적록색약에게 승급권/강등권이 구분되지 않는다(독립검증 MIN-2).
                    ▲/▼ 기호로 축을 하나 더 주고, 보조기술에는 텍스트로 읽힌다.
                  */}
                  {zone === "promote" && (
                    // role="img" 가 있어야 aria-label 이 접근성 트리에 매핑된다 — generic span 에
                    // 붙인 label 은 보조기술이 무시할 수 있다(독립검증 2R MIN-C).
                    <span className={styles.zoneMark} role="img" aria-label="승급권">
                      ▲
                    </span>
                  )}
                  {zone === "relegate" && (
                    <span className={styles.zoneMark} role="img" aria-label="강등권">
                      ▼
                    </span>
                  )}
                </td>
                <td className={styles.teamCol}>{s.name}</td>
                <td>{s.played}</td>
                <td>{s.won}</td>
                <td>{s.drawn}</td>
                <td>{s.lost}</td>
                <td>{s.goalDiff > 0 ? `+${s.goalDiff}` : s.goalDiff}</td>
                <td className={styles.ptsCol}>{s.points}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Schedule({
  fixtures,
  names,
}: {
  fixtures: LeagueFixture[];
  names: Map<string, string>;
}) {
  const rounds = useMemo(() => groupByRound(fixtures), [fixtures]);
  return (
    <section className={styles.card}>
      <h3 className={styles.cardTitle}>일정</h3>
      <div className={styles.schedule} data-testid="schedule">
        {rounds.map((g) => (
          <div key={g.round} className={styles.roundBlock}>
            <div className={styles.roundHead}>R{g.round}</div>
            <ul className={styles.fixtureList}>
              {g.fixtures.map((f) => {
                const score = fixtureScore(f);
                return (
                  <li
                    key={f.id}
                    className={[styles.fixture, f.isUser ? styles.userFixture : ""]
                      .filter(Boolean)
                      .join(" ")}
                    data-testid={`fixture-${f.id}`}
                    data-user={f.isUser ? "true" : undefined}
                  >
                    <span className={styles.fxHome}>{names.get(f.homeTeam) ?? f.homeTeam}</span>
                    <span className={styles.fxScore}>{score ?? "vs"}</span>
                    <span className={styles.fxAway}>{names.get(f.awayTeam) ?? f.awayTeam}</span>
                    {f.isUser && <span className={styles.youTag}>나</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * 시즌 종료 화면 — 최종 순위 + (Phase3) 보상 + 시즌 요약.
 *
 * ⚠️ 멱등성: 이 화면은 **지급을 트리거하지 않는다**. 보상 지급은 서버 소관(AC-F4)이고 여기서
 * 발생하는 네트워크는 GET /api/league refetch 뿐이라, 재진입/재조회해도 중복 지급이 없다(AC-E1).
 */
function SeasonEnd({
  season,
  reward,
  onError,
  onRefresh,
  refreshing,
}: {
  season: LeagueSeason;
  reward: LeagueSeasonReward | null;
  onError: (m: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const start = useStartLeague();
  const handleErr = useStartError(onError);
  const rank = userRank(season.standings);
  const sorted = useMemo(() => sortByRank(season.standings), [season.standings]);
  const summary = useMemo(() => seasonSummary(season.standings), [season.standings]);
  const division = useMemo(() => pickDivision(season), [season]);
  const outcome = useMemo(() => divisionOutcome(rank, division), [rank, division]);
  return (
    <div data-testid="season-end">
      <section className={styles.endHero}>
        <p className={styles.endTitle}>시즌 {season.seasonNo} 종료</p>
        {rank != null && (
          <p className={styles.endRank} data-testid="final-rank">
            최종 순위 <strong className={styles.rankPop}>{rank}위</strong>
          </p>
        )}
      </section>
      {/* 승급/강등 결과 — 디비전 규칙이 없으면(구 서버) 렌더 안 함. */}
      {outcome && (
        <section
          className={`${styles.outcomeCard} ${styles[`outcome_${outcome.tone}`]}`}
          data-testid="division-outcome"
          data-zone={outcome.zone}
        >
          <p className={styles.outcomeHeadline}>{outcome.headline}</p>
          <p className={styles.outcomeDetail}>{outcome.detail}</p>
        </section>
      )}
      {/* reward 부재(구 서버) = 렌더 안 함 → 기존 화면 그대로. */}
      {reward && <SeasonRewardCard reward={reward} onRefresh={onRefresh} refreshing={refreshing} />}
      {summary && <SeasonSummaryCard summary={summary} />}
      <StandingsTable standings={sorted} division={division} />
      <button
        type="button"
        className={styles.primary}
        disabled={start.isPending}
        data-testid="new-season"
        onClick={() => start.mutate(undefined, { onError: handleErr })}
      >
        {start.isPending ? "새 시즌 생성 중…" : "새 시즌 시작"}
      </button>
    </div>
  );
}

/** prefers-reduced-motion: reduce → 연출(카운트업·페이드) 끄기. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** 0→target 카운트업(rAF, ~700ms). enabled=false 면 즉시 target(모션 없음). */
function useCountUp(target: number, enabled: boolean): number {
  const [value, setValue] = useState(enabled ? 0 : target);
  const frame = useRef(0);
  useEffect(() => {
    if (!enabled) {
      setValue(target);
      return;
    }
    const startedAt = performance.now();
    const DURATION = 700;
    const tick = (now: number) => {
      const t = Math.min(1, (now - startedAt) / DURATION);
      const eased = 1 - (1 - t) * (1 - t); // easeOutQuad
      setValue(Math.round(target * eased));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [target, enabled]);
  return value;
}

function SeasonRewardCard({
  reward,
  onRefresh,
  refreshing,
}: {
  reward: LeagueSeasonReward;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  // 재화 표기는 서버 메타에서 — 순수 뷰 함수에 포매터로 주입한다(#232).
  const pointCurrency = useCurrency(CURRENCY_POINT);
  const gemCurrency = useCurrency(CURRENCY_GEM);
  const view = useMemo(
    () => seasonRewardView(reward, (v) => formatAmount(pointCurrency, v), (v) => formatAmount(gemCurrency, v)),
    [reward, pointCurrency, gemCurrency],
  );
  // 시즌 유상재화(#251: 완주하면 전 순위 지급) — G 와 **병기**한다. 연출은 #214 소관이라 값만 보여준다.
  const gems = reward.gems ?? 0;
  const reducedMotion = usePrefersReducedMotion();
  const shown = useCountUp(reward.points, view.animate && !reducedMotion);
  return (
    <section
      className={[styles.card, styles.rewardCard, reducedMotion ? "" : styles.rewardEnter]
        .filter(Boolean)
        .join(" ")}
      data-testid="season-reward"
      data-status={view.status}
      data-tone={view.tone}
    >
      <h3 className={styles.cardTitle}>시즌 보상</h3>
      <p
        className={[styles.rewardStatus, styles[`tone_${view.tone}`]].join(" ")}
        data-testid="season-reward-status"
        data-status={view.status}
      >
        {view.headline}
      </p>
      <p
        className={styles.rewardPoints}
        data-testid="season-reward-points"
        data-points={reward.points}
        data-awarded={view.showPoints ? "true" : "false"}
      >
        {/*
          이 화면만 심볼을 손으로 뒤에 붙이고 있었다 → 서버가 position 을 prefix 로 바꾸면 다른 화면은
          다 뒤집히는데 여기만 접미로 남는다(독립검증 minor). 카운트업 연출 때문에 숫자와 단위를
          다른 크기로 그려야 해서 문자열 하나로 합칠 수는 없으므로, **순서와 구분자를 메타에서 읽어**
          두 조각으로 배치한다.
        */}
        {pointCurrency.position === "prefix" ? (
          <>
            <span className={styles.rewardPointsUnit}>{pointCurrency.symbol}</span>
            {pointCurrency.separator}
            <span className={styles.rewardPointsValue}>{shown.toLocaleString()}</span>
          </>
        ) : (
          <>
            <span className={styles.rewardPointsValue}>{shown.toLocaleString()}</span>
            {pointCurrency.separator}
            <span className={styles.rewardPointsUnit}>{pointCurrency.symbol}</span>
          </>
        )}
        {/*
          "미지급" 은 **받았어야 하는데 못 받았다** 는 뜻이다. NONE(보상 순위 밖)은 정상이라
          붙이면 안 된다 — 중립 헤드라인 밑에 실패 뉘앙스가 붙어 읽는 사람이 사고로 오해한다.
        */}
        {!view.showPoints && view.status !== "NONE" && (
          <span className={styles.rewardPointsNote}>미지급</span>
        )}
      </p>
      {gems > 0 && (
        <p className={styles.rewardGems} data-testid="season-reward-gems" data-gems={gems}>
          <span aria-hidden="true">{gemCurrency.icon}</span>{" "}
          <Amount code={CURRENCY_GEM} value={gems} />
        </p>
      )}
      <p className={styles.rewardDetail} data-testid="season-reward-message">
        {view.detail}
      </p>
      {reward.awardedAt && isGranted(view.status) && (
        <p className={styles.rewardAt} data-testid="season-reward-at">
          지급 {formatAwardedAt(reward.awardedAt)}
        </p>
      )}
      {view.canRetry && (
        // GET refetch 만 — 지급 트리거 POST 를 보내지 않는다(멱등, AC-E1).
        <button
          type="button"
          className={styles.secondary}
          data-testid="season-reward-retry"
          disabled={refreshing}
          onClick={onRefresh}
        >
          {refreshing ? "조회 중…" : "다시 조회"}
        </button>
      )}
    </section>
  );
}

function SeasonSummaryCard({ summary }: { summary: SeasonSummary }) {
  return (
    <section className={styles.card} data-testid="season-summary">
      <h3 className={styles.cardTitle}>시즌 요약</h3>
      <dl className={styles.summaryGrid}>
        <div className={styles.summaryItem}>
          <dt>경기</dt>
          <dd data-testid="season-summary-played">{summary.played}</dd>
        </div>
        <div className={styles.summaryItem}>
          <dt>전적</dt>
          <dd data-testid="season-summary-record">{summary.record}</dd>
        </div>
        <div className={styles.summaryItem}>
          <dt>득실</dt>
          <dd data-testid="season-summary-goals">
            {summary.goalsLabel}
            <span className={styles.summaryDiff}>({summary.goalDiffLabel})</span>
          </dd>
        </div>
        <div className={styles.summaryItem}>
          <dt>승점</dt>
          <dd data-testid="season-summary-points">{summary.points}</dd>
        </div>
      </dl>
    </section>
  );
}
