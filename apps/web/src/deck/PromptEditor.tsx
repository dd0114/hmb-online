import type { CatalogPlayer, PromptPreset } from "../api/hooks";
import { PROMPT_MAX_CHARS } from "./deck-logic";
import styles from "./PromptEditor.module.css";

interface PromptEditorProps {
  player: CatalogPlayer;
  promptText: string;
  presets: PromptPreset[];
  onChange: (text: string) => void;
  onRemoveFromDeck: () => void;
  onClose: () => void;
}

/**
 * 선수별 사전 프롬프트 편집 패널 — 500자 카운터 + 프리셋 드롭다운(적용 = 본문 복사).
 * 프리셋을 적용해도 참조가 아니라 텍스트 복사이므로 프리셋 삭제와 무관 (AC-S4와 동일 의미론).
 */
export function PromptEditor({
  player,
  promptText,
  presets,
  onChange,
  onRemoveFromDeck,
  onClose,
}: PromptEditorProps) {
  const over = promptText.length > PROMPT_MAX_CHARS;

  return (
    <section className={styles.panel} data-testid="prompt-editor">
      <div className={styles.head}>
        <h3 className={styles.title}>
          {player.name} <span className={styles.pos}>{player.position}</span>
        </h3>
        <button type="button" className={styles.close} onClick={onClose} data-testid="prompt-close">
          닫기
        </button>
      </div>

      <div className={styles.presetRow}>
        <select
          className={styles.presetSelect}
          data-testid="prompt-preset-select"
          defaultValue=""
          onChange={(e) => {
            const preset = presets.find((p) => p.id === e.target.value);
            if (preset) onChange(preset.promptText); // copy body into textarea
            e.target.value = "";
          }}
        >
          <option value="" disabled>
            프리셋 적용(본문 복사)
          </option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <textarea
        className={over ? styles.textareaOver : styles.textarea}
        data-testid="prompt-input"
        value={promptText}
        maxLength={PROMPT_MAX_CHARS}
        rows={4}
        placeholder="이 선수에게 내릴 사전 지시 (예: 측면 돌파 위주로, 수비 가담 최소화)"
        onChange={(e) => onChange(e.target.value)}
      />
      <div className={styles.counterRow}>
        <span className={over ? styles.counterOver : styles.counter} data-testid="prompt-counter">
          {promptText.length}/{PROMPT_MAX_CHARS}
        </span>
        <button
          type="button"
          className={styles.remove}
          data-testid="prompt-remove-player"
          onClick={onRemoveFromDeck}
        >
          덱에서 제거
        </button>
      </div>
    </section>
  );
}
