import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMatchLogs, useRankings, useTradeLogs } from "../api/hooks-v2";
import { usePlayers, type CatalogPlayer } from "../api/hooks";
import type { MatchLogItem, RankingsResponse, TradeLogItem } from "../api/v2";
import { Layout } from "../common/Layout";
import { ErrorToast } from "../common/ErrorToast";
import { GRADE_COLORS, GRADE_LABELS } from "../common/grades";
import {
  DEFAULT_MATCH_LOG_FILTER,
  MODE_LABELS,
  RESULT_LABELS,
  formatMyScore,
  formatWinRate,
  orientScore,
  roundLabel,
  setFilterMode,
  setFilterSeason,
  type MatchLogFilter,
  type ModeFilter,
} from "./logs-logic";
// MatchSnapshotDialog(그 경기 세팅 보기 → 프리셋 저장, #98 W5)는 이슈 #106 으로 **화면에서 내렸다**
// — 프리셋 개념 자체를 보류했기 때문. 컴포넌트/테스트/서버 계약은 존치(재도입 대비).
import { Amount } from "../common/Amount";
import { CURRENCY_POINT } from "../common/currency";
import styles from "./LogsPage.module.css";

type Tab = "matches" | "trades" | "rankings";

const TABS: Array<[Tab, string]> = [
  ["matches", "경기"],
  ["trades", "트레이드"],
  ["rankings", "랭킹"],
];

/** 짧은 로컬 표시용 일시(비-엔진 UI — 결정론 대상 아님). */
function shortDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function LogsPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("matches");

  const header = (
    <div className={styles.headerRow}>
      <button type="button" className={styles.back} onClick={() => navigate("/lobby")}>
        ← 로비
      </button>
      <h1 className={styles.pageTitle}>로그</h1>
      <span className={styles.spacer} />
    </div>
  );

  return (
    <Layout header={header} nav>
      <div className={styles.tabs} role="tablist" aria-label="로그 종류">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={[styles.tab, tab === key ? styles.tabActive : ""].filter(Boolean).join(" ")}
            data-testid={`logs-tab-${key}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "matches" && <MatchLogsTab />}
      {tab === "trades" && <TradeLogsTab />}
      {tab === "rankings" && <RankingsTab />}
    </Layout>
  );
}

// ─────────────────────────── 경기 로그 (AC-E1) ───────────────────────────

function MatchLogsTab() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<MatchLogFilter>(DEFAULT_MATCH_LOG_FILTER);
  const { data, isLoading, isError } = useMatchLogs(filter);

  const modeOptions: Array<[ModeFilter, string]> = [
    ["all", "전체"],
    ["practice", "연습"],
    ["league", "리그"],
  ];

  return (
    <div data-testid="logs-matches">
      <div className={styles.filterRow}>
        <div className={styles.segmented} role="group" aria-label="모드 필터">
          {modeOptions.map(([m, label]) => (
            <button
              key={m}
              type="button"
              className={[styles.segBtn, filter.mode === m ? styles.segActive : ""]
                .filter(Boolean)
                .join(" ")}
              data-testid={`filter-mode-${m}`}
              onClick={() => setFilter((f) => setFilterMode(f, m))}
            >
              {label}
            </button>
          ))}
        </div>
        {filter.mode === "league" && (
          <input
            type="number"
            className={styles.seasonInput}
            placeholder="시즌"
            aria-label="시즌 필터"
            data-testid="filter-season"
            value={filter.season ?? ""}
            min={1}
            onChange={(e) =>
              setFilter((f) => setFilterSeason(f, e.target.value === "" ? null : Number(e.target.value)))
            }
          />
        )}
      </div>

      {isError && <ErrorToast message="경기 기록을 불러오지 못했습니다" />}
      {isLoading && <p className={styles.pending}>불러오는 중…</p>}
      {!isLoading && data && data.length === 0 && (
        <p className={styles.empty} data-testid="matches-empty">
          기록이 없습니다.
        </p>
      )}

      <ul className={styles.list}>
        {(data ?? []).map((item) => (
          <MatchLogRow
            key={item.id}
            item={item}
            onOpen={() => navigate(`/match/${item.id}`)}
          />
        ))}
      </ul>

    </div>
  );
}

function MatchLogRow({
  item,
  onOpen,
}: {
  item: MatchLogItem;
  onOpen: () => void;
}) {
  const oriented = orientScore(item);
  const rl = roundLabel(item);
  const result = item.result ?? null;
  const win = result === "WIN";
  const loss = result === "LOSS";
  return (
    <li>
      <button
        type="button"
        className={styles.row}
        data-testid={`match-log-${item.id}`}
        data-user-was-home={item.userWasHome ? "true" : "false"}
        onClick={onOpen}
      >
        <div className={styles.rowMain}>
          <span className={styles.opp}>{item.opponentName}</span>
          <span
            className={styles.score}
            data-testid={`match-score-${item.id}`}
            aria-label={`내 ${oriented.my ?? "-"} 대 상대 ${oriented.opp ?? "-"}`}
          >
            {formatMyScore(item)}
          </span>
          {result && (
            <span
              className={[styles.badge, win ? styles.badgeWin : loss ? styles.badgeLoss : styles.badgeDraw]
                .filter(Boolean)
                .join(" ")}
              data-testid={`match-result-${item.id}`}
            >
              {RESULT_LABELS[result]}
            </span>
          )}
        </div>
        <div className={styles.rowMeta}>
          <span className={styles.modeTag}>{MODE_LABELS[item.mode]}</span>
          {rl && <span className={styles.roundTag}>{rl}</span>}
          {item.hasHalves && (
            <span className={styles.replayTag} data-testid={`match-replay-${item.id}`}>
              ▶ 재생
            </span>
          )}
          <span className={styles.date}>{shortDate(item.createdAt)}</span>
        </div>
      </button>

    </li>
  );
}

// ─────────────────────────── 트레이드 이력 (AC-E3) ───────────────────────────

const TRADE_RESULT_LABELS: Record<string, string> = {
  SUCCESS: "성공",
  FAIL: "실패",
  DECLINED: "거절",
  EXPIRED: "만료",
};

function TradeLogsTab() {
  const { data, isLoading, isError } = useTradeLogs();
  return (
    <div data-testid="logs-trades">
      {isError && <ErrorToast message="트레이드 이력을 불러오지 못했습니다" />}
      {isLoading && <p className={styles.pending}>불러오는 중…</p>}
      {!isLoading && data && data.length === 0 && (
        <p className={styles.empty} data-testid="trades-empty">
          이력이 없습니다.
        </p>
      )}
      <ul className={styles.list}>
        {(data ?? []).map((item) => (
          <TradeLogRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

function TradeLogRow({ item }: { item: TradeLogItem }) {
  const detail = (item.detail ?? {}) as Record<string, unknown>;
  const target = detail.target as { name?: string } | undefined;
  const points = typeof detail.points === "number" ? detail.points : null;
  const success = item.result === "SUCCESS";
  return (
    <li>
      <div className={styles.row} data-testid={`trade-log-${item.id}`}>
        <div className={styles.rowMain}>
          <span className={styles.opp}>
            {item.kind === "FA" ? "FA 영입" : "트레이드"}
            {target?.name ? ` · ${target.name}` : ""}
          </span>
          <span
            className={[styles.badge, success ? styles.badgeWin : styles.badgeLoss]
              .filter(Boolean)
              .join(" ")}
            data-testid={`trade-result-${item.id}`}
          >
            {TRADE_RESULT_LABELS[item.result] ?? item.result}
          </span>
        </div>
        <div className={styles.rowMeta}>
          {points != null && (
            <Amount className={styles.roundTag} code={CURRENCY_POINT} value={points} />
          )}
          <span className={styles.date}>{shortDate(item.createdAt)}</span>
        </div>
      </div>
    </li>
  );
}

// ─────────────────────────── 랭킹 (AC-E2) ───────────────────────────

function RankingsTab() {
  const { data, isLoading, isError } = useRankings();
  const { data: players } = usePlayers();

  const catalog = useMemo(() => {
    const m = new Map<string, CatalogPlayer>();
    for (const p of players ?? []) m.set(p.id, p);
    return m;
  }, [players]);

  if (isError) return <ErrorToast message="랭킹을 불러오지 못했습니다" />;
  if (isLoading || !data) return <p className={styles.pending}>불러오는 중…</p>;

  return (
    <div data-testid="logs-rankings" className={styles.rankingsGrid}>
      <Leaderboard data={data} />
      <PersonalRecordsCard data={data} catalog={catalog} />
    </div>
  );
}

function Leaderboard({ data }: { data: RankingsResponse }) {
  const myId = data.me?.userId;
  return (
    <section className={styles.card}>
      <h3 className={styles.cardTitle}>리더보드</h3>
      <ul className={styles.leaderboard} data-testid="leaderboard">
        {data.leaderboard.map((e) => {
          const isMe = e.userId === myId;
          return (
            <li
              key={e.userId}
              className={[styles.lbRow, isMe ? styles.lbMe : ""].filter(Boolean).join(" ")}
              data-testid={`lb-${e.userId}`}
              data-me={isMe ? "true" : undefined}
            >
              <span className={styles.lbRank}>{e.rank}</span>
              <span className={styles.lbName}>{e.nickname}</span>
              <span className={styles.lbWins}>{e.wins}승</span>
              <span className={styles.lbRate}>{formatWinRate(e.winRate)}</span>
            </li>
          );
        })}
      </ul>
      {data.me && !data.leaderboard.some((e) => e.userId === myId) && (
        <div className={`${styles.lbRow} ${styles.lbMe}`} data-testid="lb-me">
          <span className={styles.lbRank}>{data.me.rank}</span>
          <span className={styles.lbName}>{data.me.nickname} (나)</span>
          <span className={styles.lbWins}>{data.me.wins}승</span>
          <span className={styles.lbRate}>{formatWinRate(data.me.winRate)}</span>
        </div>
      )}
    </section>
  );
}

function PersonalRecordsCard({
  data,
  catalog,
}: {
  data: RankingsResponse;
  catalog: Map<string, CatalogPlayer>;
}) {
  const pr = data.personalRecords;
  const scorer = pr?.topScorer ?? null;
  const joined = scorer ? catalog.get(scorer.playerId) : undefined;
  const grade = joined?.grade ?? scorer?.grade;
  return (
    <section className={styles.card} data-testid="personal-records">
      <h3 className={styles.cardTitle}>개인 기록</h3>
      <div className={styles.recRow}>
        <span className={styles.recLabel}>최다 득점 선수</span>
        {scorer ? (
          <span className={styles.scorerCard} data-testid="top-scorer">
            <span
              className={styles.scorerName}
              style={grade ? { color: GRADE_COLORS[grade] } : undefined}
            >
              {joined?.name ?? scorer.name}
            </span>
            {grade && <span className={styles.scorerGrade}>{GRADE_LABELS[grade]}</span>}
            <span className={styles.scorerPos}>{joined?.position ?? scorer.position}</span>
            {pr?.topScorerGoals != null && (
              <span className={styles.scorerGoals}>{pr.topScorerGoals}골</span>
            )}
          </span>
        ) : (
          <span className={styles.recValue}>-</span>
        )}
      </div>
      <div className={styles.recRow}>
        <span className={styles.recLabel}>최다 연승</span>
        <span className={styles.recValue}>{pr?.longestWinStreak ?? 0}연승</span>
      </div>
      <div className={styles.recRow}>
        <span className={styles.recLabel}>총 경기</span>
        <span className={styles.recValue}>{pr?.totalMatches ?? 0}경기</span>
      </div>
    </section>
  );
}
