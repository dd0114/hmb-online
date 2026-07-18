import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLeague, useStartLeague, useStartNextLeagueMatch } from "../api/hooks-v2";
import type { LeagueFixture, LeagueSeason, LeagueStanding } from "../api/v2";
import { ApiError } from "../api/client";
import { Layout } from "../common/Layout";
import { ErrorToast } from "../common/ErrorToast";
import {
  fixtureScore,
  groupByRound,
  isSeasonFinished,
  sortByRank,
  teamNameMap,
  userRank,
} from "./league-logic";
import styles from "./LeaguePage.module.css";

export function LeaguePage() {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useLeague();
  const [error, setError] = useState<string | null>(null);

  const season = data?.season ?? null;

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
      {season && isSeasonFinished(season) && <SeasonEnd season={season} onError={setError} />}

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

function SeasonEnd({ season, onError }: { season: LeagueSeason; onError: (m: string) => void }) {
  const start = useStartLeague();
  const handleErr = useStartError(onError);
  const rank = userRank(season.standings);
  const sorted = useMemo(() => sortByRank(season.standings), [season.standings]);
  return (
    <div data-testid="season-end">
      <section className={styles.endHero}>
        <p className={styles.endTitle}>시즌 {season.seasonNo} 종료</p>
        {rank != null && (
          <p className={styles.endRank} data-testid="final-rank">
            최종 순위 <strong>{rank}위</strong>
          </p>
        )}
      </section>
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
