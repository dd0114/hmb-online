/**
 * ⚠️ 이슈 #106 R1 — 선택 프리셋 요약 카드는 덱 화면에서 **내렸다**(삭제가 아니라 렌더 중단).
 * hero 판정: 컨셉 확정 전의 프리셋은 시기상조 → 세팅 하나(활성 덱)만 편집·저장한다.
 * 이 파일·훅·서버 계약(/api/presets*)은 재도입 대비로 존치한다. 되돌리려면 DeckPage 에서 다시 렌더.
 */
import { useState } from "react";
import type { CatalogPlayer } from "../api/hooks";
import type { TeamPresetSlot } from "../api/v2";
import { STARTER_COUNT } from "./deck-logic";
import { snapshotSummary } from "./preset-selector-logic";
import { TACTICS_KEYS, TACTICS_LABELS } from "./tactics-logic";
import styles from "./PresetSummary.module.css";

interface PresetSummaryProps {
  /** the selected preset slot (may be empty/undefined = nothing selected yet). */
  slot: TeamPresetSlot | undefined;
  playersById: Map<string, CatalogPlayer>;
  /** editor has unsaved edits vs this saved snapshot. */
  dirty: boolean;
  /** a save/apply is in flight — disable the rename control. */
  busy?: boolean;
  /** rename the selected filled slot (요구 2 이름 저장). */
  onRename?: (name: string) => Promise<void>;
}

/**
 * Top-of-screen "completed preset" card (요구 1): the SELECTED slot's saved snapshot — name,
 * formation, 선발/전술 요약, 파워. Shows a dirty badge when the editor below has unsaved edits, and a
 * first-entry empty state when no preset is selected/saved yet (요구 2 — [+새 프리셋] 두드러지게).
 */
export function PresetSummary({ slot, playersById, dirty, busy = false, onRename }: PresetSummaryProps) {
  const snap = slot?.snapshot ?? null;
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  async function confirmRename() {
    const name = nameDraft.trim();
    if (!name || !onRename) {
      setRenameError("이름을 입력하세요");
      return;
    }
    setRenameError(null);
    try {
      await onRename(name);
      setRenaming(false);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "이름 변경에 실패했습니다");
    }
  }

  if (!snap) {
    return (
      <section className={styles.card} data-testid="preset-summary">
        <div className={styles.emptyState} data-testid="preset-summary-empty">
          <strong className={styles.emptyTitle}>저장된 프리셋이 없습니다</strong>
          <p className={styles.emptyDesc}>
            아래에서 팀을 구성한 뒤 <span className={styles.hi}>[+ 새 프리셋]</span> 으로 저장하세요.
          </p>
          {/* No slot selected yet, but edits (예: Auto 구성) can still be pending → show dirty. */}
          {dirty && (
            <span className={styles.dirty} data-testid="deck-dirty-badge">
              미저장 변경
            </span>
          )}
        </div>
      </section>
    );
  }

  const s = snapshotSummary(snap, playersById);

  return (
    <section className={styles.card} data-testid="preset-summary" data-slot={slot?.slot}>
      <div className={styles.head}>
        <div className={styles.titleWrap}>
          <span className={styles.slotBadge}>슬롯 {slot?.slot}</span>
          {renaming ? (
            <input
              className={styles.renameInput}
              data-testid="preset-rename-input"
              value={nameDraft}
              placeholder="프리셋 이름"
              autoFocus
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmRename();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <h2 className={styles.name} data-testid="preset-summary-name">
              {slot?.name}
            </h2>
          )}
          {onRename &&
            (renaming ? (
              <>
                <button
                  type="button"
                  className={styles.renameSave}
                  data-testid="preset-rename-save"
                  disabled={busy || !nameDraft.trim()}
                  onClick={confirmRename}
                >
                  저장
                </button>
                <button
                  type="button"
                  className={styles.renameCancel}
                  data-testid="preset-rename-cancel"
                  onClick={() => {
                    setRenaming(false);
                    setRenameError(null);
                  }}
                >
                  취소
                </button>
              </>
            ) : (
              <button
                type="button"
                className={styles.renameButton}
                data-testid="preset-rename-button"
                onClick={() => {
                  setNameDraft(slot?.name ?? "");
                  setRenameError(null);
                  setRenaming(true);
                }}
              >
                이름변경
              </button>
            ))}
        </div>
        {dirty && (
          <span className={styles.dirty} data-testid="deck-dirty-badge">
            미저장 변경
          </span>
        )}
      </div>
      {renameError && (
        <p className={styles.renameError} data-testid="preset-rename-error">
          {renameError}
        </p>
      )}

      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>포메이션</span>
          <span className={styles.statValue} data-testid="preset-summary-formation">
            {s.formation}
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>선발</span>
          <span className={styles.statValue}>
            {s.starterCount}/{STARTER_COUNT}
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>파워</span>
          <span className={styles.statValue} data-testid="preset-summary-power">
            {s.power}
          </span>
        </div>
      </div>

      {s.tactics && (
        <ul className={styles.tacticsRow} data-testid="preset-summary-tactics">
          {TACTICS_KEYS.map((k) => (
            <li key={k} className={styles.tactic}>
              <span className={styles.tacticLabel}>{TACTICS_LABELS[k]}</span>
              <span className={styles.tacticValue}>{Math.round((s.tactics![k] ?? 0.5) * 100)}</span>
            </li>
          ))}
        </ul>
      )}

      {s.teamPrompt && <p className={styles.teamPrompt}>“{s.teamPrompt}”</p>}
    </section>
  );
}
