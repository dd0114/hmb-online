import type { MatchDetail } from "../../api/hooks";
import { isHalftimeState } from "./stage-state";
import styles from "./StageShell.module.css";

interface ScoreBarProps {
  match: MatchDetail;
  homeName: string;
  awayName: string;
  /** 재생 진행에 맞춘 스코어(로그+플레이헤드 기준). 확정 스코어가 없는 상태에서만 쓴다. */
  liveScore: { home: number; away: number } | null;
  /** 헤더 시계가 가리킬 틱(초 단위). 감독시간엔 하프 끝, 그 외엔 재생 플레이헤드 — `headerTick` 참조. */
  tick: number | null;
  /** 이 시계가 재생 플레이헤드가 아니라 **끝난 하프의 종료 지점**인가(감독시간). 표기 반올림이 달라진다. */
  tickIsHalfEnd?: boolean;
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
 * 하프가 끝난 지점의 분 표기 — **내림이 아니라 반올림**이다. 전반 마지막 스냅샷은 틱 2699(=44.98분)
 * 라서 내리면 `44'` 로 한 분 모자라 보인다. 45' 는 상수가 아니라 엔진 하프 길이에서 파생된다
 * (엔진 config 가 바뀌면 이 값도 따라간다 — 웹에 경기 길이를 복제하지 않는다).
 */
function halfEndMinuteLabel(tick: number): string {
  return `${Math.round(tick / 60)}'`;
}

/**
 * [A] 스코어바 — 무대 위 고정 행. 팀·스코어·시계·상태를 호스트가 소유한다(#169 S1).
 * (뷰어 iframe 안의 스코어보드는 크롬 CSS 로 숨겨져 중복이 없다.)
 *
 * **확정 스코어 우선**: 하프타임/종료는 결과가 이미 확정된 상태라 그 값을 보여준다. 재생 플레이헤드
 * 기준 스코어를 쓰면 같은 화면의 결과 패널이 `3 : 2` 인데 헤더는 `0 : 0` 으로 뜨는 모순이 생긴다
 * (독립검증 major — "보이는 것 vs 데이터" 인지 갭, 루트 §2-2).
 * 확정 스코어가 없는 상태(W3 라이브 관전)에서는 `liveScore` 가 쓰인다.
 *
 * ⚠️ 감독시간 판정은 **`isHalftimeState`** 로만 한다(#226). 여기서 `state === "H1_BREAK"` 라고 직접
 * 쓴 탓에 현행 상태명 `HALFTIME` 이 규칙 밖으로 빠졌고, 배포본 감독시간 화면이 재생을 따라가
 * `0 : 0 / 0'` 를 띄웠다(API 는 0:4). 시계도 같은 이유로 하프 끝에 고정한다 — 재생 진행은 무대와
 * 재생 컨트롤이 보여주지, 결과가 확정된 하프의 헤더가 보여줄 것이 아니다.
 */
export function ScoreBar({
  match,
  homeName,
  awayName,
  liveScore,
  tick,
  tickIsHalfEnd = false,
  leagueRound = null,
  onBack,
}: ScoreBarProps) {
  const isFinished = match.state === "FINISHED";
  const isBreak = isHalftimeState(match.state);

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
        {tick != null && (
          <span className={styles.clock} data-testid="stage-clock">
            {tickIsHalfEnd ? halfEndMinuteLabel(tick) : minuteLabel(tick)}
          </span>
        )}
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
