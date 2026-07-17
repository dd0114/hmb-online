import type { CatalogPlayer } from "../api/hooks";
import { GRADE_COLORS } from "../common/grades";
import {
  BENCH_MAX,
  DEFAULT_FORMATION,
  FORMATION_LAYOUTS,
  getSlot,
  type DeckDraft,
  type SlotRole,
} from "./deck-logic";
import styles from "./SlotGrid.module.css";

export interface SlotRef {
  role: SlotRole;
  slotIndex: number;
}

interface SlotGridProps {
  draft: DeckDraft;
  playersById: Map<string, CatalogPlayer>;
  selectedSlot: SlotRef | null;
  /** playerId highlighted as the server-reported offender (400 DECK_INVALID detail.playerId) */
  errorPlayerId: string | null;
  onSlotTap: (slot: SlotRef) => void;
}

/** Pitch-shaped starter grid (formation rows, FW top / GK bottom) + bench row. CSS only. */
export function SlotGrid({ draft, playersById, selectedSlot, errorPlayerId, onSlotTap }: SlotGridProps) {
  const layout = FORMATION_LAYOUTS[draft.formation] ?? FORMATION_LAYOUTS[DEFAULT_FORMATION]!;

  function renderSlot(role: SlotRole, slotIndex: number) {
    const slot = getSlot(draft, role, slotIndex);
    const player = slot ? playersById.get(slot.playerId) : undefined;
    const isSelected = selectedSlot?.role === role && selectedSlot.slotIndex === slotIndex;
    const isError = slot != null && slot.playerId === errorPlayerId;
    const classes = [
      styles.slot,
      isSelected ? styles.selected : "",
      isError ? styles.error : "",
      slot ? styles.filled : styles.empty,
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        key={`${role}-${slotIndex}`}
        type="button"
        className={classes}
        data-testid={`slot-${role}-${slotIndex}`}
        onClick={() => onSlotTap({ role, slotIndex })}
      >
        {player ? (
          <>
            <span className={styles.slotName}>{player.name}</span>
            <span className={styles.slotMeta}>
              <span style={{ color: GRADE_COLORS[player.grade] }}>{player.position}</span>
              {slot?.promptText ? <span className={styles.promptDot} title="프롬프트 있음" /> : null}
            </span>
          </>
        ) : (
          <span className={styles.emptyMark}>+</span>
        )}
      </button>
    );
  }

  return (
    <div>
      <div className={styles.pitch} data-testid="starter-grid">
        {layout.map((row) => (
          <div key={row.label} className={styles.row}>
            <span className={styles.rowLabel}>{row.label}</span>
            <div className={styles.rowSlots}>{row.slotIndexes.map((i) => renderSlot("starter", i))}</div>
          </div>
        ))}
      </div>
      <div className={styles.benchSection}>
        <span className={styles.benchLabel}>벤치 (최대 {BENCH_MAX})</span>
        <div className={styles.benchRow} data-testid="bench-row">
          {Array.from({ length: BENCH_MAX }, (_, i) => renderSlot("bench", i))}
        </div>
      </div>
    </div>
  );
}
