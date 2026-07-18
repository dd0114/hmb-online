import { useMemo, useState } from "react";
import type { CatalogPlayer } from "../api/hooks";
import type { ConditionMap, RelationsResponse } from "../api/v2";
import { relationOf } from "../common/relations";
import {
  assignPlayer,
  findPlayerSlot,
  firstEmptySlot,
  getSlot,
  removePlayer,
  setPrompt,
  STARTER_COUNT,
  type DeckDraft,
} from "./deck-logic";
import { movePlayerToSlot, type EditorState } from "./tactics-logic";
import { teamPower } from "./team-power";
import { TacticsBoard, type SlotRef } from "./TacticsBoard";
import { PlayerSheet } from "./PlayerSheet";
import { TeamTacticsPanel } from "./TeamTacticsPanel";
import { TeamPowerBar } from "./TeamPowerBar";
import { PlayerPicker } from "./PlayerPicker";
import { PROMPT_MAX_CHARS } from "./deck-logic";
import styles from "./DeckEditor.module.css";

export interface DeckEditorProps {
  state: EditorState;
  onChange: (state: EditorState) => void;
  /** "AI에 맡기기" — when true, team tactics are managed by AI (sliders disabled/omitted). */
  aiManaged: boolean;
  onToggleAi: (aiManaged: boolean) => void;
  /** owned players (pool). */
  players: CatalogPlayer[];
  playersById: Map<string, CatalogPlayer>;
  /** briefing-only extras. */
  conditions?: ConditionMap;
  /** relations (AC-C4) — feeds the player sheet trust gauge + personality badge. */
  relations?: RelationsResponse;
  opponentPower?: number;
  opponentName?: string;
  opponentApprox?: boolean;
  errorPlayerId?: string | null;
}

/**
 * Shared team editor (AC-B2 컴포넌트 완전 공유): tactics board + player sheet + manual team
 * tactics + power bar + pool. Fully controlled — the parent (DeckPage / BriefingPanel) owns the
 * EditorState and decides how it is persisted (PUT /api/deck vs kickoff re-capture).
 */
export function DeckEditor(props: DeckEditorProps) {
  const {
    state,
    onChange,
    aiManaged,
    onToggleAi,
    players,
    playersById,
    conditions,
    relations,
    opponentPower,
    opponentName,
    opponentApprox,
    errorPlayerId,
  } = props;
  const draft = state.draft;

  const [selectedSlot, setSelectedSlot] = useState<SlotRef | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);

  const starterSlots = draft.slots.filter((s) => s.role === "starter");
  const starterCount = starterSlots.length;

  const power = useMemo(() => {
    const attrs = starterSlots
      .map((s) => playersById.get(s.playerId)?.attributes)
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
    return teamPower(attrs);
  }, [starterSlots, playersById]);

  function mutateDraft(next: DeckDraft) {
    onChange({ ...state, draft: next });
  }

  function handleSlotTap(slot: SlotRef) {
    const occupant = getSlot(draft, slot.role, slot.slotIndex);
    if (occupant) {
      setSelectedPlayerId(occupant.playerId);
      setSelectedSlot(slot);
    } else {
      setSelectedSlot((prev) =>
        prev?.role === slot.role && prev.slotIndex === slot.slotIndex ? null : slot,
      );
      setSelectedPlayerId(null);
    }
  }

  function handlePick(playerId: string) {
    const target = selectedSlot ?? firstEmptySlot(draft);
    if (!target) return; // full
    mutateDraft(assignPlayer(draft, target.role, target.slotIndex, playerId));
    setSelectedSlot(null);
  }

  function handleMove(playerId: string, toRole: SlotRef["role"], toSlotIndex: number) {
    mutateDraft(movePlayerToSlot(draft, playerId, toRole, toSlotIndex));
  }

  const editingPlayer = selectedPlayerId ? playersById.get(selectedPlayerId) : undefined;
  const editingSlot = selectedPlayerId ? findPlayerSlot(draft, selectedPlayerId) : undefined;

  return (
    <div className={styles.editor} data-testid="deck-editor">
      <div className={styles.starterHint}>
        선발 {starterCount}/{STARTER_COUNT} · 토큰을 끌어 배치하거나 슬롯을 탭해 선택하세요
      </div>

      <TacticsBoard
        draft={draft}
        playersById={playersById}
        conditions={conditions}
        selectedSlot={selectedSlot}
        selectedPlayerId={selectedPlayerId}
        onSlotTap={handleSlotTap}
        onMove={handleMove}
      />

      {errorPlayerId && playersById.get(errorPlayerId) && (
        <p className={styles.errorNote} data-testid="editor-error-player">
          문제 선수: {playersById.get(errorPlayerId)!.name}
        </p>
      )}

      {editingPlayer && editingSlot && (
        <PlayerSheet
          key={editingPlayer.id}
          player={editingPlayer}
          promptText={editingSlot.promptText ?? ""}
          condition={conditions?.[editingPlayer.id]}
          trust={relationOf(relations, editingPlayer.id)?.trust}
          personality={relationOf(relations, editingPlayer.id)?.personality}
          onChange={(text) => mutateDraft(setPrompt(draft, editingPlayer.id, text))}
          onRemoveFromDeck={() => {
            mutateDraft(removePlayer(draft, editingPlayer.id));
            setSelectedPlayerId(null);
            setSelectedSlot(null);
          }}
          onClose={() => setSelectedPlayerId(null)}
        />
      )}

      <TeamPowerBar
        power={power}
        starterCount={starterCount}
        opponentPower={opponentPower}
        opponentName={opponentName}
        opponentApprox={opponentApprox}
      />

      <TeamTacticsPanel
        tactics={state.tactics}
        aiManaged={aiManaged}
        onChange={(tactics) => onChange({ ...state, tactics })}
        onToggleAi={onToggleAi}
      />

      <section className={styles.teamPromptSection}>
        <label className={styles.teamPromptLabel} htmlFor="team-prompt">
          팀 전체 지시
        </label>
        <textarea
          id="team-prompt"
          data-testid="editor-team-prompt"
          className={styles.teamPromptInput}
          rows={2}
          maxLength={PROMPT_MAX_CHARS}
          placeholder="팀 전체에 내릴 작전 (예: 초반부터 강하게 압박, 역습 위주)"
          value={state.teamPrompt}
          onChange={(e) => onChange({ ...state, teamPrompt: e.target.value })}
        />
      </section>

      <PlayerPicker players={players} draft={draft} onPick={handlePick} />
    </div>
  );
}
