import { useEffect, useMemo, useRef } from "react";
import { logLines, skinKeyOf, type LogEvent, type LogLine } from "@hmb/viewer-core";
import { jerseyNumbers } from "../viewer-skins";
import { useHalfLog } from "../../api/hooks";
import styles from "./panels.module.css";

interface LogPanelProps {
  matchId: string;
  half: 1 | 2;
  homeName: string;
  awayName: string;
  /** 재생 플레이헤드 — 여기까지의 라인만 보여준다(라이브 코멘터리). */
  tick: number | null;
  /**
   * 이 하프 앞에 이미 확정된 스코어(후반이면 전반) — 골 라인이 **경기 누적**을 말하게 한다(#233).
   * null 이면 하프 로컬(전반 재생·전반 확정값 미상). 값은 `playedBaseline` 이 정한다.
   */
  baseline?: { home: number; away: number } | null;
}

/** 이벤트 타입별 색 클래스(뷰어 티커와 같은 팔레트). 없으면 기본색. */
function typeClass(type: string): string {
  const map: Record<string, string | undefined> = {
    goal: styles.evgoal,
    shot: styles.evshot,
    save: styles.evsave,
    foul: styles.evfoul,
    card: styles.evcard,
    offside: styles.evoffside,
    penalty: styles.evpenalty,
    substitution: styles.evsubstitution,
  };
  return map[type] ?? "";
}

function tierClass(tier: LogLine["tier"]): string {
  if (tier === "major") return styles.major ?? "";
  if (tier === "minor") return styles.minor ?? "";
  return styles.normal ?? "";
}

/**
 * [D] 게임 로그 — FM식 코멘터리. 투영(어떤 이벤트를 어떤 라벨/중요도로 보일지)은
 * `@hmb/viewer-core`(P4-D3 SoT)가 소유하고 여기서는 그리기만 한다.
 */
export function LogPanel({ matchId, half, homeName, awayName, tick, baseline = null }: LogPanelProps) {
  const { data: log, isLoading, isError } = useHalfLog(matchId, half);
  const endRef = useRef<HTMLLIElement>(null);

  const lines = useMemo(() => {
    if (!log) return [];
    const events = ((log.events ?? []) as unknown as LogEvent[]) ?? [];
    return logLines(events, tick ?? 0, baseline);
  }, [log, tick, baseline?.home, baseline?.away]);

  /**
   * 등번호 표 (#334). 코어는 실경기 id(`P108`)를 번호로 내보내지 않는다 — 그대로 찍으면 화면에
   * `#P108` 이 뜬다(라이브 한 하프 152/152). 진짜 등번호는 **부모만 안다**: 스냅샷의 팀별 등장
   * 순서로 매긴다(#324 와 같은 표·같은 `(team, playerId)` 키 — 같은 선수가 양 팀에 뛸 수 있다).
   */
  const nums = useMemo(() => (log ? jerseyNumbers(log) : {}), [log]);
  const numberOf = (l: LogLine): string | undefined =>
    (l.playerId ? nums[skinKeyOf(l.team, l.playerId)] : undefined) ?? l.number;

  // 최신 라인이 항상 보이게(스크롤은 이 패널 안에서만 — 문서는 스크롤하지 않는다).
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [lines.length]);

  if (isLoading) return <p className={styles.note}>로그 불러오는 중…</p>;
  if (isError || !log) return <p className={styles.note}>로그를 불러오지 못했습니다</p>;

  return (
    <ol className={`${styles.log} ${styles.logBody}`} data-testid="stage-panel-log">
      {lines.length === 0 && <li className={styles.note}>아직 기록된 장면이 없습니다</li>}
      {lines.map((l, i) => (
        <li
          key={`${l.tick}-${i}`}
          className={`${styles.logRow} ${tierClass(l.tier)} ${typeClass(l.type)}`}
          data-tick={l.tick}
          ref={i === lines.length - 1 ? endRef : undefined}
        >
          <span className={styles.minute}>{l.minute}'</span>
          <span className={styles.label}>
            {l.label}
            {numberOf(l) ? ` #${numberOf(l)}` : ""}
            {l.score ? ` ${l.score}` : ""}
          </span>
          {l.team && <span className={styles.side}>{l.team === "home" ? homeName : awayName}</span>}
          {l.xg && <span className={styles.xg}>xG {l.xg}</span>}
        </li>
      ))}
    </ol>
  );
}
