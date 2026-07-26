import { useEffect, useMemo, useRef } from "react";
import { logLines, type LogEvent, type LogLine } from "@hmb/viewer-core";
import { useHalfLog } from "../../api/hooks";
import styles from "./panels.module.css";

interface LogPanelProps {
  matchId: string;
  half: 1 | 2;
  homeName: string;
  awayName: string;
  /** 재생 플레이헤드 — 여기까지의 라인만 보여준다(라이브 코멘터리). */
  tick: number | null;
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
export function LogPanel({ matchId, half, homeName, awayName, tick }: LogPanelProps) {
  const { data: log, isLoading, isError } = useHalfLog(matchId, half);
  const endRef = useRef<HTMLLIElement>(null);

  const lines = useMemo(() => {
    if (!log) return [];
    const events = ((log.events ?? []) as unknown as LogEvent[]) ?? [];
    return logLines(events, tick ?? 0);
  }, [log, tick]);

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
            {l.number ? ` #${l.number}` : ""}
            {l.score ? ` ${l.score}` : ""}
          </span>
          {l.team && <span className={styles.side}>{l.team === "home" ? homeName : awayName}</span>}
          {l.xg && <span className={styles.xg}>xG {l.xg}</span>}
        </li>
      ))}
    </ol>
  );
}
