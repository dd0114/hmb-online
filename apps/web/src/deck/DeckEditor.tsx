import { useMemo, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
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
import { TacticsBoard, parseDroppableId, playerIdFromDragId, type SlotRef } from "./TacticsBoard";
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
  /**
   * 컨디션 {playerId: 0..1} — 보드 토큰 시계 + 선수 시트 + 리스트 행 시계(요구 6)에 쓰인다.
   * 덱 화면 = 당일 롤(GET /api/conditions/today), 브리핑 = 매치 스냅샷(match.conditions).
   */
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

  // Single DndContext spans the board slots + bench (token sources) AND the owned-player pool list
  // (pool: source, 요구 5). Sensors moved up here from TacticsBoard — pointer/touch/keyboard all kept.
  // MouseSensor(터치 아님) + TouchSensor 로 분리한다 — PointerSensor 를 쓰면 터치에서도
  // pointerdown 이 먼저 잡혀 TouchSensor 의 delay(롱프레스) 활성화가 영영 안 걸리고,
  // 거리 기반(distance) 활성화라 손가락이 6px 움직이는 순간 브라우저가 네이티브 스크롤을
  // 시작해 pointercancel 로 드래그가 죽는다(실측). 분리하면 터치는 롱프레스 150ms 로만
  // 드래그가 시작되고, 짧은 스와이프는 리스트 스크롤로 남는다(스크롤·드래그 양립).
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  function handleDragEnd(e: DragEndEvent) {
    if (!e.over) return;
    const playerId = playerIdFromDragId(String(e.active.id));
    const target = parseDroppableId(String(e.over.id));
    handleMove(playerId, target.role, target.slotIndex);
  }

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
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
    <div className={styles.editor} data-testid="deck-editor">
      {/* ≥1024px: 좌 보드 / 우 사이드패널 2컬럼(LLD §2·§7 W6). 모바일은 세로 스택 그대로. */}
      <div className={styles.boardCol}>
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
      </div>

      <div className={styles.sideCol}>
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

        <PlayerPicker players={players} draft={draft} onPick={handlePick} conditions={conditions} />
      </div>
    </div>
    </DndContext>
  );
}
