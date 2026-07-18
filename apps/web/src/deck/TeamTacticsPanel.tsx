import type { TeamTactics } from "../api/v2";
import { TACTICS_KEYS, TACTICS_LABELS } from "./tactics-logic";
import styles from "./TeamTacticsPanel.module.css";

interface TeamTacticsPanelProps {
  tactics: TeamTactics;
  /** false = "AI에 맡기기" (manual tactics not sent — server/AI decides). */
  aiManaged: boolean;
  onChange: (tactics: TeamTactics) => void;
  onToggleAi: (aiManaged: boolean) => void;
}

/** low/high hint labels per slider so 0..1 reads as a football concept. */
const ENDPOINTS: Record<keyof TeamTactics, [string, string]> = {
  line: ["낮게", "높게"],
  press: ["약하게", "강하게"],
  tempo: ["느리게", "빠르게"],
  width: ["좁게", "넓게"],
};

/**
 * Manual team tactics (P2-D4): four 0..1 sliders + "AI에 맡기기" toggle. When AI-managed, the
 * sliders are disabled and teamTactics is NOT sent (the caller omits it from the match request).
 */
export function TeamTacticsPanel({ tactics, aiManaged, onChange, onToggleAi }: TeamTacticsPanelProps) {
  return (
    <section className={styles.panel} data-testid="team-tactics-panel">
      <div className={styles.head}>
        <h3 className={styles.title}>팀 전술</h3>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            data-testid="tactics-ai-toggle"
            checked={aiManaged}
            onChange={(e) => onToggleAi(e.target.checked)}
          />
          <span>AI에 맡기기</span>
        </label>
      </div>

      <div className={aiManaged ? styles.slidersDisabled : styles.sliders} aria-disabled={aiManaged}>
        {TACTICS_KEYS.map((key) => (
          <div key={key} className={styles.sliderRow}>
            <span className={styles.sliderLabel}>{TACTICS_LABELS[key]}</span>
            <span className={styles.endpoint}>{ENDPOINTS[key][0]}</span>
            <input
              type="range"
              className={styles.range}
              data-testid={`tactics-${key}`}
              min={0}
              max={1}
              step={0.05}
              value={tactics[key]}
              disabled={aiManaged}
              onChange={(e) => onChange({ ...tactics, [key]: Number(e.target.value) })}
            />
            <span className={styles.endpoint}>{ENDPOINTS[key][1]}</span>
            <span className={styles.value} data-testid={`tactics-value-${key}`}>
              {Math.round(tactics[key] * 100)}
            </span>
          </div>
        ))}
      </div>
      {aiManaged && (
        <p className={styles.aiNote} data-testid="tactics-ai-note">
          팀 전술을 AI가 결정합니다 (수동 값 미전송).
        </p>
      )}
    </section>
  );
}
