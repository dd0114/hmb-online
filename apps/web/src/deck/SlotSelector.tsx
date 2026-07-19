import { useState } from "react";
import type { TeamPresetSlot } from "../api/v2";
import { nextEmptySlot } from "./preset-selector-logic";
import styles from "./SlotSelector.module.css";

interface SlotSelectorProps {
  slots: TeamPresetSlot[];
  /** currently selected/loaded slot (null = ad-hoc active deck, no preset selected). */
  selectedSlot: number | null;
  /** a save/apply is in flight — disable interactions. */
  busy: boolean;
  /** can the current editor be saved as a snapshot (선발 11 완성)? gates [+new]. */
  saveable: boolean;
  /** select a slot: a filled slot loads its snapshot; an empty slot just becomes the save target. */
  onSelect: (slot: number) => void;
  /** save the current editor into the next empty slot under `name` (요구 2·4). */
  onNew: (name: string) => Promise<void>;
}

/**
 * Compact slot selector row `[1][2][3][+new]` (요구 2). Replaces the old vertical 3-slot manager:
 * the top summary now carries the "completed preset" view, so this row is just quick selection +
 * "save as new". `[+new]` is enabled only when an empty slot exists AND the editor is saveable.
 */
export function SlotSelector({ slots, selectedSlot, busy, saveable, onSelect, onNew }: SlotSelectorProps) {
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const ordered = [...slots].sort((a, b) => a.slot - b.slot);
  const emptyTarget = nextEmptySlot(slots);
  const newEnabled = emptyTarget != null && saveable && !busy;

  async function confirmNew() {
    const name = nameDraft.trim();
    if (!name) {
      setError("이름을 입력하세요");
      return;
    }
    setError(null);
    try {
      await onNew(name);
      setNaming(false);
      setNameDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장에 실패했습니다");
    }
  }

  return (
    <section className={styles.selector} data-testid="slot-selector">
      <div className={styles.row}>
        {ordered.map((slot) => {
          const filled = Boolean(slot.snapshot);
          const selected = selectedSlot === slot.slot;
          return (
            <button
              key={slot.slot}
              type="button"
              className={[styles.chip, filled ? styles.chipFilled : styles.chipEmpty, selected ? styles.chipSelected : ""]
                .filter(Boolean)
                .join(" ")}
              data-testid={`slot-chip-${slot.slot}`}
              data-filled={filled ? "true" : "false"}
              data-selected={selected ? "true" : "false"}
              disabled={busy}
              onClick={() => onSelect(slot.slot)}
            >
              <span className={styles.chipNo}>{slot.slot}</span>
              <span className={styles.chipName}>{filled ? slot.name : "빈 슬롯"}</span>
            </button>
          );
        })}

        <button
          type="button"
          className={`${styles.chip} ${styles.chipNew}`}
          data-testid="slot-new-button"
          disabled={!newEnabled}
          title={
            emptyTarget == null
              ? "빈 슬롯이 없습니다 (기존 슬롯을 덮어써 저장하세요)"
              : !saveable
                ? "선발 11명을 채워야 저장할 수 있습니다"
                : `슬롯 ${emptyTarget}에 새 프리셋 저장`
          }
          onClick={() => {
            setError(null);
            setNameDraft("");
            setNaming(true);
          }}
        >
          + 새 프리셋
        </button>
      </div>

      {naming && (
        <div className={styles.namingRow} data-testid="slot-new-form">
          <input
            className={styles.nameInput}
            data-testid="slot-new-name-input"
            value={nameDraft}
            placeholder={`슬롯 ${emptyTarget ?? ""} 이름`}
            autoFocus
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmNew();
              if (e.key === "Escape") setNaming(false);
            }}
          />
          <button
            type="button"
            className={styles.confirm}
            data-testid="slot-new-confirm"
            disabled={busy || !nameDraft.trim()}
            onClick={confirmNew}
          >
            저장
          </button>
          <button
            type="button"
            className={styles.cancel}
            data-testid="slot-new-cancel"
            onClick={() => {
              setNaming(false);
              setError(null);
            }}
          >
            취소
          </button>
        </div>
      )}

      {error && (
        <p className={styles.error} data-testid="slot-selector-error">
          {error}
        </p>
      )}
    </section>
  );
}
