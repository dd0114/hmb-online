import type { MatchDetail } from "../../api/hooks";
import { clockLabel, headerScore, isHalftimeState } from "./stage-state";
import styles from "./StageShell.module.css";

interface ScoreBarProps {
  match: MatchDetail;
  homeName: string;
  awayName: string;
  /**
   * **지금 재생 중인 하프의 델타** — 그 하프 로그의 골만 플레이헤드까지 센 값이다(경기 누적이 아니다).
   * 앞에 끝난 하프의 확정 스코어를 얹는 건 `headerScore` 가 한다(#233).
   */
  liveScore: { home: number; away: number } | null;
  /**
   * 헤더 시계가 가리킬 틱(초 단위). 감독시간엔 하프 끝, 그 외엔 재생 플레이헤드 — `headerTick` 참조.
   *
   * 이 값이 "하프 끝"인지 "플레이헤드"인지는 **여기서 상태로 다시 판정**한다(props 로 안 받는다).
   * 호출자가 같은 사실을 두 번 넘기면 둘이 어긋난 상태가 만들어질 수 있고, 그 어긋남은 상태만 보는
   * 단위 테스트에 안 잡힌다(독립검증 minor-3 — 그 변이체가 실제로 단위테스트를 전부 통과했다).
   */
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

/**
 * [A] 스코어바 — 무대 위 고정 행. 팀·스코어·시계·상태를 호스트가 소유한다(#169 S1).
 * (뷰어 iframe 안의 스코어보드는 크롬 CSS 로 숨겨져 중복이 없다.)
 *
 * **스코어 규칙은 `headerScore` 가 소유한다** — 끝난 하프는 서버 확정값, 지금 하프만 재생 델타
 * (#233). 여기서 상태를 다시 분기해 값을 만들지 마라: 그 손분기가 #226(감독시간이 재생을 따라감)과
 * #233(후반이 전반 스코어를 잃음) 두 버그를 낳았다. 재생 플레이헤드 기준 스코어만 쓰면 같은 화면의
 * 결과 패널이 `3 : 2` 인데 헤더는 `0 : 0` 으로 뜨는 모순이 생긴다
 * (독립검증 major — "보이는 것 vs 데이터" 인지 갭, 루트 §2-2).
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
  leagueRound = null,
  onBack,
}: ScoreBarProps) {
  const isBreak = isHalftimeState(match.state);

  // 규칙은 `headerScore`·`clockLabel` 이 소유한다 — 여기서 상태별로 다시 분기하지 마라(#226·#233).
  const { home, away } = headerScore(match.state, match, liveScore);
  const clock = clockLabel(match.state, tick);

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
        {clock != null && (
          <span className={styles.clock} data-testid="stage-clock">
            {clock}
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
