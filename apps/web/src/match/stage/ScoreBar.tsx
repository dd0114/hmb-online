import type { MatchDetail } from "../../api/hooks";
import styles from "./StageShell.module.css";

interface ScoreBarProps {
  match: MatchDetail;
  homeName: string;
  awayName: string;
  /** 재생 진행에 맞춘 스코어(로그+플레이헤드 기준). 확정 스코어가 없는 상태에서만 쓴다. */
  liveScore: { home: number; away: number } | null;
  /** 재생 플레이헤드(초 단위 틱). 없으면 시계 숨김. */
  tick: number | null;
  /** 리그 매치일 때 라운드(navigation state 로만 오는 값). */
  leagueRound?: number | null;
  onBack: () => void;
}

/** 상태 뱃지 문구. W2/W3(#170)가 추가할 라이브 상태도 미리 사람 말로 보여준다(모르면 원문 노출). */
const STATE_TAGS: Record<string, string> = {
  FINISHED: "경기 종료",
  H1_BREAK: "하프타임",
  HALFTIME: "감독시간",
  FIRST_HALF: "전반 진행 중",
  SECOND_HALF: "후반 진행 중",
};

/** 틱(=경기 초) → `67'` 표기. 엔진 1틱 = 1 게임초. */
function minuteLabel(tick: number): string {
  return `${Math.floor(tick / 60)}'`;
}

/**
 * [A] 스코어바 — 무대 위 고정 행. 팀·스코어·시계·상태를 호스트가 소유한다(#169 S1).
 * (뷰어 iframe 안의 스코어보드는 크롬 CSS 로 숨겨져 중복이 없다.)
 *
 * **확정 스코어 우선**: 하프타임/종료는 결과가 이미 확정된 상태라 그 값을 보여준다. 재생 플레이헤드
 * 기준 스코어를 쓰면 같은 화면의 결과 패널이 `3 : 2` 인데 헤더는 `0 : 0` 으로 뜨는 모순이 생긴다
 * (독립검증 major — "보이는 것 vs 데이터" 인지 갭, 루트 §2-2). 재생 진행은 옆의 시계가 보여준다.
 * 확정 스코어가 없는 상태(W3 라이브 관전)에서는 `liveScore` 가 쓰인다.
 */
export function ScoreBar({
  match,
  homeName,
  awayName,
  liveScore,
  tick,
  leagueRound = null,
  onBack,
}: ScoreBarProps) {
  const isFinished = match.state === "FINISHED";
  const isBreak = match.state === "H1_BREAK";

  const settled = isFinished
    ? { home: match.scoreHome, away: match.scoreAway }
    : isBreak
      ? { home: match.scoreH1Home, away: match.scoreH1Away }
      : null;
  // 확정 상태인데 서버 값이 아직 비어 있으면 0 으로 단정하지 않고 "-" 로 둔다(구 화면과 같은 표기).
  const settledKnown = settled != null && settled.home != null && settled.away != null;
  const home: number | string = settledKnown ? settled.home! : settled ? "-" : (liveScore?.home ?? 0);
  const away: number | string = settledKnown ? settled.away! : settled ? "-" : (liveScore?.away ?? 0);

  const isLeague = match.mode === "league" || Boolean(match.leagueFixtureId);

  return (
    <header className={styles.scorebar} data-testid="stage-scorebar">
      <button type="button" className={styles.back} onClick={onBack} data-testid="stage-back">
        ← 로비
      </button>

      <div className={styles.teams} data-testid="stage-score">
        <span className={`${styles.teamName} ${styles.home}`}>{homeName}</span>
        {/* 하프타임 화면에서 이 값이 곧 "전반 스코어" — 기존 e2e·단위테스트가 참조하는 계약 표기다. */}
        <span className={styles.score} data-testid={isBreak ? "h1-score" : undefined}>
          {home} : {away}
        </span>
        <span className={`${styles.teamName} ${styles.away}`}>{awayName}</span>
      </div>

      <div className={styles.meta}>
        {isLeague && (
          <span className={styles.leagueBadge} data-testid="match-league-badge">
            리그{leagueRound != null ? ` R${leagueRound}` : ""}
          </span>
        )}
        {tick != null && <span className={styles.clock}>{minuteLabel(tick)}</span>}
        <span
          className={`${styles.phaseTag} ${isBreak ? styles.phaseLive : ""}`}
          data-testid="match-state"
        >
          {STATE_TAGS[match.state] ?? match.state}
        </span>
      </div>
    </header>
  );
}
