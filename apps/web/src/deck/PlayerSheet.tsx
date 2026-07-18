import { useEffect, useState } from "react";
import type { CatalogPlayer } from "../api/hooks";
import { PROMPT_MAX_CHARS } from "./deck-logic";
import {
  composePrompt,
  DIRECTIVE_CHIPS,
  emptyDirectiveState,
  ROLE_OPTIONS,
  synthesizeDirectiveText,
  toggleChip,
  type DirectiveState,
} from "./directives";
import { ConditionClock } from "../match/ConditionClock";
import { PersonalityBadge, TrustGauge } from "../common/RelationBits";
import type { Personality } from "../api/v2";
import styles from "./PlayerSheet.module.css";

interface PlayerSheetProps {
  player: CatalogPlayer;
  /** the player's current combined promptText (SoT). */
  promptText: string;
  /** optional condition for the clock header (briefing). */
  condition?: number;
  /** optional relation (AC-C4) — trust gauge + personality badge in the header. */
  trust?: number;
  personality?: Personality;
  onChange: (text: string) => void;
  onRemoveFromDeck: () => void;
  onClose: () => void;
}

/**
 * Two-layer player sheet (AC-B4):
 *   상단 = 전술 지시 (역할 셀렉트 + 성향 토글칩 — 카탈로그 6종 정합).
 *   하단 = 자유 프롬프트 ("감독의 한마디").
 * Chips synthesize directive text that is prepended to the free prompt; the combined string is
 * the promptText sent to the server. Chip/role state is sheet-local (an input aid) — on open the
 * whole stored promptText is treated as the free layer.
 */
export function PlayerSheet({ player, promptText, condition, trust, personality, onChange, onRemoveFromDeck, onClose }: PlayerSheetProps) {
  const personalityValue = personality ?? player.personality;
  const [directive, setDirective] = useState<DirectiveState>(emptyDirectiveState());
  const [freeText, setFreeText] = useState<string>(promptText);

  // reset the local layers whenever the sheet switches to a different player
  useEffect(() => {
    setDirective(emptyDirectiveState());
    setFreeText(promptText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.id]);

  function push(nextDirective: DirectiveState, nextFree: string) {
    setDirective(nextDirective);
    setFreeText(nextFree);
    onChange(composePrompt(nextDirective, nextFree));
  }

  const directivePreview = synthesizeDirectiveText(directive);
  const combinedLen = composePrompt(directive, freeText).length;
  const over = combinedLen > PROMPT_MAX_CHARS;

  return (
    <section className={styles.panel} data-testid="player-sheet">
      <div className={styles.head}>
        <h3 className={styles.title}>
          {condition != null && <ConditionClock value={condition} size={22} testId={`sheet-clock-${player.id}`} />}
          {player.name} <span className={styles.pos}>{player.position}</span>
        </h3>
        <button type="button" className={styles.close} data-testid="sheet-close" onClick={onClose}>
          닫기
        </button>
      </div>

      {/* ── 관계 (AC-C4): 성격 뱃지 + 신뢰도 게이지 ── */}
      {(personalityValue || trust != null) && (
        <div className={styles.relationRow} data-testid="sheet-relation">
          {personalityValue && <PersonalityBadge personality={personalityValue} />}
          {trust != null && <TrustGauge trust={trust} />}
        </div>
      )}

      {/* ── 상단: 전술 지시 (정형 UI) ── */}
      <div className={styles.tacticalLayer} data-testid="sheet-tactical-layer">
        <span className={styles.layerTag}>전술 지시</span>
        <div className={styles.roleRow}>
          <label className={styles.roleLabel} htmlFor={`role-${player.id}`}>
            역할
          </label>
          <select
            id={`role-${player.id}`}
            className={styles.roleSelect}
            data-testid="sheet-role-select"
            value={directive.role}
            onChange={(e) => push({ ...directive, role: e.target.value }, freeText)}
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.chips} role="group" aria-label="성향 토글">
          {DIRECTIVE_CHIPS.map((chip) => {
            const active = directive.chipIds.includes(chip.id);
            return (
              <button
                key={chip.id}
                type="button"
                className={active ? styles.chipActive : styles.chip}
                data-testid={`sheet-chip-${chip.id}`}
                aria-pressed={active}
                onClick={() => push(toggleChip(directive, chip.id), freeText)}
              >
                {chip.label}
              </button>
            );
          })}
        </div>
        {directivePreview && (
          <p className={styles.directivePreview} data-testid="sheet-directive-preview">
            {directivePreview}
          </p>
        )}
      </div>

      {/* ── 하단: 자유 프롬프트 (감독의 한마디) ── */}
      <div className={styles.promptLayer} data-testid="sheet-prompt-layer">
        <span className={styles.layerTag}>감독의 한마디</span>
        <textarea
          className={over ? styles.textareaOver : styles.textarea}
          data-testid="sheet-prompt-input"
          value={freeText}
          rows={3}
          placeholder="이 선수에게 자유롭게 한마디 (예: 오늘 너만 믿는다, 과감하게 슛 노려)"
          onChange={(e) => push(directive, e.target.value)}
        />
        <div className={styles.counterRow}>
          <span className={over ? styles.counterOver : styles.counter} data-testid="sheet-counter">
            {combinedLen}/{PROMPT_MAX_CHARS}
          </span>
          <button
            type="button"
            className={styles.remove}
            data-testid="sheet-remove-player"
            onClick={onRemoveFromDeck}
          >
            덱에서 제거
          </button>
        </div>
      </div>
    </section>
  );
}
