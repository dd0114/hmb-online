import { useState } from "react";
import type { TeamPresetSlot } from "../api/v2";
import styles from "./TeamPresetSlots.module.css";

interface TeamPresetSlotsProps {
  slots: TeamPresetSlot[];
  saving: boolean;
  /** save the current editor state into a slot under `name`. */
  onSave: (slot: number, name: string) => Promise<void>;
  /** load a slot's snapshot into the editor (apply → active deck). */
  onLoad: (slot: number) => Promise<void>;
  /** rename a slot (re-save its snapshot under a new name). */
  onRename: (slot: number, name: string) => Promise<void>;
  /** duplicate a slot's snapshot into another (empty) slot. */
  onDuplicate: (from: number, to: number) => Promise<void>;
}

/**
 * Team snapshot 3-slot manager (AC-B1): save / load / rename / duplicate. Empty slots show a
 * save-current CTA; filled slots show load + rename + duplicate. Errors surface inline.
 */
export function TeamPresetSlots({ slots, saving, onSave, onLoad, onRename, onDuplicate }: TeamPresetSlotsProps) {
  const [renaming, setRenaming] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const emptySlot = slots.find((s) => !s.snapshot)?.slot ?? null;

  async function run(fn: () => Promise<void>, ok: string) {
    setError(null);
    setNote(null);
    try {
      await fn();
      setNote(ok);
    } catch (err) {
      setError(err instanceof Error ? err.message : "작업에 실패했습니다");
    }
  }

  return (
    <section className={styles.panel} data-testid="team-preset-slots">
      <h3 className={styles.title}>팀 스냅샷 (3슬롯)</h3>
      <ul className={styles.list}>
        {slots.map((slot) => {
          const filled = Boolean(slot.snapshot);
          const isRenaming = renaming === slot.slot;
          return (
            <li key={slot.slot} className={styles.slot} data-testid={`preset-slot-${slot.slot}`}>
              <div className={styles.slotHead}>
                <span className={styles.slotNo}>슬롯 {slot.slot}</span>
                {isRenaming ? (
                  <input
                    className={styles.nameInput}
                    data-testid={`preset-name-input-${slot.slot}`}
                    value={nameDraft}
                    placeholder="이름"
                    autoFocus
                    onChange={(e) => setNameDraft(e.target.value)}
                  />
                ) : (
                  <span className={styles.slotName}>{filled ? slot.name : <em>비어 있음</em>}</span>
                )}
              </div>

              <div className={styles.actions}>
                {filled ? (
                  <>
                    <button
                      type="button"
                      className={styles.primary}
                      data-testid={`preset-load-${slot.slot}`}
                      disabled={saving}
                      onClick={() => run(() => onLoad(slot.slot), `슬롯 ${slot.slot} 불러옴`)}
                    >
                      불러오기
                    </button>
                    <button
                      type="button"
                      className={styles.secondary}
                      data-testid={`preset-overwrite-${slot.slot}`}
                      disabled={saving}
                      onClick={() =>
                        run(() => onSave(slot.slot, slot.name ?? "프리셋"), `슬롯 ${slot.slot} 저장됨`)
                      }
                    >
                      현재 상태로 덮어쓰기
                    </button>
                    {isRenaming ? (
                      <button
                        type="button"
                        className={styles.secondary}
                        data-testid={`preset-rename-save-${slot.slot}`}
                        disabled={saving || !nameDraft.trim()}
                        onClick={() =>
                          run(async () => {
                            await onRename(slot.slot, nameDraft.trim());
                            setRenaming(null);
                          }, "이름 변경됨")
                        }
                      >
                        이름 저장
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={styles.secondary}
                        data-testid={`preset-rename-${slot.slot}`}
                        onClick={() => {
                          setRenaming(slot.slot);
                          setNameDraft(slot.name ?? "");
                        }}
                      >
                        이름변경
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.secondary}
                      data-testid={`preset-duplicate-${slot.slot}`}
                      disabled={saving || emptySlot == null}
                      title={emptySlot == null ? "빈 슬롯이 없습니다" : `슬롯 ${emptySlot}로 복제`}
                      onClick={() => emptySlot != null && run(() => onDuplicate(slot.slot, emptySlot), `슬롯 ${emptySlot}로 복제됨`)}
                    >
                      복제
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={styles.primary}
                    data-testid={`preset-save-${slot.slot}`}
                    disabled={saving}
                    onClick={() => run(() => onSave(slot.slot, `프리셋 ${slot.slot}`), `슬롯 ${slot.slot} 저장됨`)}
                  >
                    현재 상태 저장
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {note && (
        <p className={styles.note} data-testid="preset-note">
          {note}
        </p>
      )}
      {error && (
        <p className={styles.error} data-testid="preset-error">
          {error}
        </p>
      )}
    </section>
  );
}
