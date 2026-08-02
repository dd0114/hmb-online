/**
 * ⚠️ 이슈 #106 R1 — 프롬프트 프리셋 패널는 덱 화면에서 **내렸다**(삭제가 아니라 렌더 중단).
 * hero 판정: 컨셉 확정 전의 프리셋은 시기상조 → 세팅 하나(활성 덱)만 편집·저장한다.
 * 이 파일·훅·서버 계약(/api/presets*)은 재도입 대비로 존치한다. 되돌리려면 DeckPage 에서 다시 렌더.
 *
 * <p>⚠️ **렌더를 내렸다고 계약 밖은 아니다.** 여기 남아 있던 `player.name` 직조회가 정확히
 * "오늘은 유저 영향 0 이라 아무도 안 고치는데, 되돌리는 날 우회가 초록인 채로 부활하는" 자리였다
 * (#406 W1b 3차). 지금은 선수명 스캐너(`common/player-names.test.ts`)가 이 파일도 스캔하고
 * 초크포인트(`playerNameOf`)를 지난다 — 되돌릴 때 이름 경로는 손댈 것이 없다.
 */
import { useState } from "react";
import type { CatalogPlayer, PromptPreset } from "../api/hooks";
import { ErrorToast } from "../common/ErrorToast";
import { playerNameOf } from "../common/player-names";
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

  /**
   * ⚠️ **카탈로그가 모르는 선수를 목록에서 지우지 않는다**(#406 요구 6).
   * 구 코드는 `.filter(Boolean(x.player))` 로 미상 선수를 통째로 빼서, 덱에 앉아 있는데
   * 일괄 적용 목록에는 **없는** 선수가 생겼다 — 유저는 그 선수에게만 프리셋이 안 걸린 걸
   * 모른다. 사다리대로 `미상 선수` 로 남기고 체크·적용은 `slot.playerId` 로 한다.
   */
  const deckPlayers = draft.slots.map((s) => ({ slot: s, player: playersById.get(s.playerId) }));

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
              <li key={slot.playerId}>
                <label className={styles.bulkItem}>
                  <input
                    type="checkbox"
                    data-testid={`bulk-check-${slot.playerId}`}
                    checked={checked.has(slot.playerId)}
                    onChange={() => toggle(slot.playerId)}
                  />
                  <span className={styles.bulkName}>
                    {/* 체크박스 + 포지션 + 역할이 한 줄에 같이 앉는 **밀집 UI** → 짧은 이름 축.
                        (`player-names.ts` 두 축 규칙: 이름 옆에 다른 조각이 앉으면 short.) */}
                    {playerNameOf(player, "short")}
                    <span className={styles.bulkMeta}>
                      {player?.position ?? "?"} · {slot.role === "starter" ? "선발" : "벤치"}
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
