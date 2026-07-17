import { useState } from "react";
import type { CatalogPlayer, PromptPreset } from "../api/hooks";
import { PROMPT_MAX_CHARS, type DeckDraft } from "./deck-logic";
import styles from "./PresetPanel.module.css";

interface PresetPanelProps {
  presets: PromptPreset[];
  draft: DeckDraft;
  playersById: Map<string, CatalogPlayer>;
  creating: boolean;
  onCreate: (name: string, promptText: string) => void;
  onDelete: (id: string) => void;
  /** AC-W2: copies the chosen preset's body into each selected player's prompt (by value). */
  onBulkApply: (playerIds: string[], presetText: string) => void;
}

export function PresetPanel({
  presets,
  draft,
  playersById,
  creating,
  onCreate,
  onDelete,
  onBulkApply,
}: PresetPanelProps) {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [appliedNote, setAppliedNote] = useState<string | null>(null);

  const deckPlayers = draft.slots
    .map((s) => ({ slot: s, player: playersById.get(s.playerId) }))
    .filter((x): x is { slot: (typeof draft.slots)[number]; player: CatalogPlayer } => Boolean(x.player));

  function toggle(playerId: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  }

  function handleCreate() {
    if (!name.trim() || !body.trim()) return;
    onCreate(name.trim(), body);
    setName("");
    setBody("");
  }

  function handleBulkApply() {
    const preset = presets.find((p) => p.id === selectedPresetId);
    if (!preset || checked.size === 0) return;
    onBulkApply([...checked], preset.promptText);
    setAppliedNote(`${checked.size}명에게 '${preset.name}' 적용됨 (저장 필요)`);
    setChecked(new Set());
  }

  return (
    <section className={styles.panel} data-testid="preset-panel">
      <h3 className={styles.title}>프롬프트 프리셋</h3>

      <ul className={styles.list}>
        {presets.map((p) => (
          <li key={p.id} className={styles.presetItem}>
            <div className={styles.presetInfo}>
              <span className={styles.presetName}>{p.name}</span>
              <span className={styles.presetBody}>{p.promptText}</span>
            </div>
            <button
              type="button"
              className={styles.delete}
              data-testid={`preset-delete-${p.id}`}
              onClick={() => onDelete(p.id)}
            >
              삭제
            </button>
          </li>
        ))}
        {presets.length === 0 && <li className={styles.emptyNote}>프리셋이 없습니다</li>}
      </ul>

      <div className={styles.createForm}>
        <input
          className={styles.input}
          data-testid="preset-name"
          placeholder="프리셋 이름"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          className={styles.input}
          data-testid="preset-body"
          placeholder="프리셋 본문 (선수 프롬프트로 복사됨)"
          rows={2}
          maxLength={PROMPT_MAX_CHARS}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <button
          type="button"
          className={styles.createButton}
          data-testid="preset-create"
          disabled={creating || !name.trim() || !body.trim()}
          onClick={handleCreate}
        >
          프리셋 만들기
        </button>
      </div>

      <div className={styles.bulkSection}>
        <h4 className={styles.bulkTitle}>일괄 적용 — 선수 선택 후 프리셋 적용</h4>
        {deckPlayers.length === 0 ? (
          <p className={styles.emptyNote}>덱에 배치된 선수가 없습니다</p>
        ) : (
          <ul className={styles.bulkList}>
            {deckPlayers.map(({ slot, player }) => (
              <li key={player.id}>
                <label className={styles.bulkItem}>
                  <input
                    type="checkbox"
                    data-testid={`bulk-check-${player.id}`}
                    checked={checked.has(player.id)}
                    onChange={() => toggle(player.id)}
                  />
                  <span className={styles.bulkName}>
                    {player.name}
                    <span className={styles.bulkMeta}>
                      {player.position} · {slot.role === "starter" ? "선발" : "벤치"}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className={styles.bulkActions}>
          <select
            className={styles.input}
            data-testid="bulk-preset-select"
            value={selectedPresetId}
            onChange={(e) => setSelectedPresetId(e.target.value)}
          >
            <option value="">프리셋 선택</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styles.createButton}
            data-testid="preset-bulk-apply"
            disabled={!selectedPresetId || checked.size === 0}
            onClick={handleBulkApply}
          >
            일괄 적용 ({checked.size}명)
          </button>
        </div>
        {appliedNote && (
          <p className={styles.appliedNote} data-testid="bulk-applied-note">
            {appliedNote}
          </p>
        )}
      </div>
    </section>
  );
}
