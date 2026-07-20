import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLeague, useStartLeague, useStartNextLeagueMatch } from "../api/hooks-v2";
import type { LeagueFixture, LeagueSeason, LeagueStanding } from "../api/v2";
import type { LeagueResponseP3, LeagueSeasonReward } from "../api/p3";
import { ApiError } from "../api/client";
import { Layout } from "../common/Layout";
import { ErrorToast } from "../common/ErrorToast";
import type { SeasonSummary } from "./league-logic";
import {
  fixtureScore,
  formatAwardedAt,
  groupByRound,
  isSeasonFinished,
  pickSeasonReward,
  seasonRewardView,
  seasonSummary,
  sortByRank,
  teamNameMap,
  userRank,
} from "./league-logic";
import styles from "./LeaguePage.module.css";

export function LeaguePage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch, isFetching } = useLeague();
  const [error, setError] = useState<string | null>(null);

  const season = data?.season ?? null;
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
    </div>
  );

  return (
    <Layout header={header} nav>
      {isError && <ErrorToast message="리그 정보를 불러오지 못했습니다" />}
      {isLoading && <p className={styles.pending}>불러오는 중…</p>}

      {!isLoading && !season && <StartSeasonCta onError={setError} />}
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

function StartSeasonCta({ onError }: { onError: (m: string) => void }) {
  const start = useStartLeague();
  const handleErr = useStartError(onError);
  return (
    <div className={styles.cta} data-testid="league-start-cta">
      <p className={styles.ctaTitle}>리그에 도전하세요</p>
      <p className={styles.ctaDesc}>봇 9팀과 더블 라운드로빈 18라운드. 승점 3-1-0, 시즌 종료 시 순위 보상.</p>
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
        <StandingsTable standings={season.standings} />
        <Schedule fixtures={season.fixtures} names={names} />
      </div>
    </div>
  );
}

function StandingsTable({ standings }: { standings: LeagueStanding[] }) {
  const sorted = useMemo(() => sortByRank(standings), [standings]);
  return (
    <section className={styles.card}>
      <h3 className={styles.cardTitle}>순위표</h3>
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
            {sorted.map((s) => (
              <tr
                key={s.teamId}
                className={s.isUser ? styles.userRow : undefined}
                data-testid={`standing-${s.teamId}`}
                data-user={s.isUser ? "true" : undefined}
              >
                <td className={styles.rankCol}>{s.rank}</td>
                <td className={styles.teamCol}>{s.name}</td>
                <td>{s.played}</td>
                <td>{s.won}</td>
                <td>{s.drawn}</td>
                <td>{s.lost}</td>
                <td>{s.goalDiff > 0 ? `+${s.goalDiff}` : s.goalDiff}</td>
                <td className={styles.ptsCol}>{s.points}</td>
              </tr>
            ))}
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
      {/* reward 부재(구 서버) = 렌더 안 함 → 기존 화면 그대로. */}
      {reward && <SeasonRewardCard reward={reward} onRefresh={onRefresh} refreshing={refreshing} />}
      {summary && <SeasonSummaryCard summary={summary} />}
      <StandingsTable standings={sorted} />
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
  const view = useMemo(() => seasonRewardView(reward), [reward]);
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
        <span className={styles.rewardPointsValue}>{shown.toLocaleString()}</span>
        <span className={styles.rewardPointsUnit}>P</span>
        {!view.showPoints && <span className={styles.rewardPointsNote}>미지급</span>}
      </p>
      <p className={styles.rewardDetail} data-testid="season-reward-message">
        {view.detail}
      </p>
      {reward.awardedAt && view.status === "AWARDED" && (
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
