/**
 * ⚠️ 이슈 #106 R1 — 프롬프트 프리셋 패널는 덱 화면에서 **내렸다**(삭제가 아니라 렌더 중단).
 * hero 판정: 컨셉 확정 전의 프리셋은 시기상조 → 세팅 하나(활성 덱)만 편집·저장한다.
 * 이 파일·훅·서버 계약(/api/presets*)은 재도입 대비로 존치한다. 되돌리려면 DeckPage 에서 다시 렌더.
 */
import { useState } from "react";
import type { CatalogPlayer, PromptPreset } from "../api/hooks";
import { ErrorToast } from "../common/ErrorToast";
import { PROMPT_MAX_CHARS, type DeckDraft } from "./deck-logic";
import styles from "./PresetPanel.module.css";

interface PresetPanelProps {
  presets: PromptPreset[];
  draft: DeckDraft;
  playersById: Map<string, CatalogPlayer>;
  creating: boolean;
  /** Resolves on success so inputs clear ONLY then; rejects surface an inline error (#73 P0 — no silent data loss). */
  onCreate: (name: string, promptText: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
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
  const [error, setError] = useState<string | null>(null);

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

  async function handleCreate() {
    if (!name.trim() || !body.trim() || creating) return;
    setError(null);
    try {
      await onCreate(name.trim(), body);
      // 성공했을 때만 입력을 비운다 — 실패 시 작성 내용 유실 방지(#73 P0).
      setName("");
      setBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "프리셋 저장에 실패했습니다");
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await onDelete(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "프리셋 삭제에 실패했습니다");
    }
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
              onClick={() => handleDelete(p.id)}
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
        <ErrorToast message={error} onDismiss={() => setError(null)} />
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
