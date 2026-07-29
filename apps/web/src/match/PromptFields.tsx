import { useState } from "react";
import { CharAvatar } from "../common/CharAvatar";
import type { Grade } from "../common/grades";
import styles from "./PromptFields.module.css";

const PROMPT_MAX = 500;

export interface RosterEntry {
  playerId: string;
  name: string;
  position: string;
  role: "starter" | "bench";
  /**
   * 아이콘 노출 정책 판정용(#285). 이 부품은 현재 화면에 배선돼 있지 않지만(#244 개편으로
   * 프롬프트 입력이 `DirectiveRail` 로 옮겨갔다) 되살릴 때 **등급 없이 아바타를 그리는 구멍**으로
   * 부활하지 않도록 타입에 못 박는다.
   */
  grade: Grade;
}

interface PromptFieldsProps {
  roster: RosterEntry[];
  teamPrompt: string;
  onTeamChange: (text: string) => void;
  playerPrompts: Record<string, string>;
  onPlayerChange: (playerId: string, text: string) => void;
  /** distinguishes briefing vs halftime testids */
  idPrefix: string;
}

/** 팀 프롬프트 textarea + 선수별 프롬프트 목록(펼침) — briefing(phase=pre)과 halftime 공용. */
export function PromptFields({
  roster,
  teamPrompt,
  onTeamChange,
  playerPrompts,
  onPlayerChange,
  idPrefix,
}: PromptFieldsProps) {
  const [openPlayerId, setOpenPlayerId] = useState<string | null>(null);

  return (
    <div className={styles.fields}>
      <label className={styles.label} htmlFor={`${idPrefix}-team-prompt`}>
        팀 전체 프롬프트
      </label>
      <textarea
        id={`${idPrefix}-team-prompt`}
        data-testid={`${idPrefix}-team-prompt`}
        className={styles.textarea}
        rows={3}
        maxLength={PROMPT_MAX}
        placeholder="팀 전체에 내릴 작전 지시 (예: 초반부터 강하게 압박, 역습 위주)"
        value={teamPrompt}
        onChange={(e) => onTeamChange(e.target.value)}
      />
      <span className={styles.counter}>
        {teamPrompt.length}/{PROMPT_MAX}
      </span>

      <h4 className={styles.subTitle}>선수별 프롬프트</h4>
      <ul className={styles.playerList}>
        {roster.map((p) => {
          const text = playerPrompts[p.playerId] ?? "";
          const open = openPlayerId === p.playerId;
          return (
            <li key={p.playerId} className={styles.playerItem}>
              <button
                type="button"
                className={styles.playerHead}
                data-testid={`${idPrefix}-player-toggle-${p.playerId}`}
                aria-expanded={open}
                aria-controls={`${idPrefix}-player-prompt-${p.playerId}`}
                onClick={() => setOpenPlayerId(open ? null : p.playerId)}
              >
                <span className={styles.playerPos}>{p.position}</span>
                <CharAvatar playerId={p.playerId} name={p.name} grade={p.grade} size={26} />
                <span className={styles.playerName}>{p.name}</span>
                <span className={styles.playerRole}>{p.role === "starter" ? "선발" : "벤치"}</span>
                {text && <span className={styles.hasPrompt} title="프롬프트 있음" />}
                <span className={styles.chevron}>{open ? "▲" : "▼"}</span>
              </button>
              {open && (
                <div className={styles.playerBody}>
                  <textarea
                    className={styles.textarea}
                    data-testid={`${idPrefix}-player-prompt-${p.playerId}`}
                    rows={2}
                    maxLength={PROMPT_MAX}
                    placeholder="이 선수에게 내릴 지시"
                    value={text}
                    onChange={(e) => onPlayerChange(p.playerId, e.target.value)}
                  />
                  <span className={styles.counter}>
                    {text.length}/{PROMPT_MAX}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
