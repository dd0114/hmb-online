import { useMemo } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { CatalogPlayer } from "../api/hooks";
import type { ConditionMap } from "../api/v2";
import { GRADE_COLORS } from "../common/grades";
import { BENCH_MAX, getSlot, type DeckDraft, type SlotRole } from "./deck-logic";
import { starterCoords } from "./tactics-logic";
import { ConditionClock } from "../match/ConditionClock";
import styles from "./TacticsBoard.module.css";

export interface SlotRef {
  role: SlotRole;
  slotIndex: number;
}

interface TacticsBoardProps {
  draft: DeckDraft;
  playersById: Map<string, CatalogPlayer>;
  /** optional per-player condition (briefing) → clock badge on each token (AC-C1). */
  conditions?: ConditionMap;
  /** tap-tap placement target (accessibility / touch fallback). */
  selectedSlot: SlotRef | null;
  /** which token is currently open in the player sheet. */
  selectedPlayerId: string | null;
  /** the player picked for tap-to-place (pool selection), highlighted as the source. */
  onSlotTap: (slot: SlotRef) => void;
  /** drag result — move/swap a player onto a slot. */
  onMove: (playerId: string, toRole: SlotRole, toSlotIndex: number) => void;
}

function slotDroppableId(role: SlotRole, slotIndex: number): string {
  return `${role}:${slotIndex}`;
}

function parseDroppableId(id: string): SlotRef {
  const [role, idx] = id.split(":");
  return { role: role as SlotRole, slotIndex: Number(idx) };
}

interface TokenProps {
  playerId: string;
  player: CatalogPlayer | undefined;
  hasPrompt: boolean;
  condition?: number;
  selected: boolean;
}

/** A draggable player token (used inside both pitch slots and bench cells). */
function PlayerToken({ playerId, player, hasPrompt, condition, selected }: TokenProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: playerId });
  return (
    <div
      ref={setNodeRef}
      className={`${styles.token} ${selected ? styles.tokenSelected : ""} ${isDragging ? styles.tokenDragging : ""}`}
      data-testid={`token-${playerId}`}
      {...listeners}
      {...attributes}
    >
      {condition != null && (
        <span className={styles.tokenClock}>
          <ConditionClock value={condition} size={16} testId={`token-clock-${playerId}`} />
        </span>
      )}
      <span className={styles.tokenName}>{player?.name ?? playerId}</span>
      <span className={styles.tokenMeta} style={{ color: player ? GRADE_COLORS[player.grade] : undefined }}>
        {player?.position ?? "?"}
        {hasPrompt ? <span className={styles.promptDot} title="지시 있음" /> : null}
      </span>
    </div>
  );
}

interface SlotCellProps extends TacticsBoardProps {
  role: SlotRole;
  slotIndex: number;
  style?: React.CSSProperties;
  className: string;
}

/** A droppable slot on the pitch or bench. Tap selects (tap-tap place); occupant opens sheet. */
function SlotCell(props: SlotCellProps) {
  const { draft, playersById, conditions, selectedSlot, selectedPlayerId, onSlotTap, role, slotIndex, style, className } =
    props;
  const { setNodeRef, isOver } = useDroppable({ id: slotDroppableId(role, slotIndex) });
  const slot = getSlot(draft, role, slotIndex);
  const player = slot ? playersById.get(slot.playerId) : undefined;
  const isTapTarget = selectedSlot?.role === role && selectedSlot.slotIndex === slotIndex;

  return (
    <button
      type="button"
      ref={setNodeRef}
      className={`${className} ${isOver ? styles.cellOver : ""} ${isTapTarget ? styles.cellSelected : ""} ${slot ? styles.cellFilled : styles.cellEmpty}`}
      style={style}
      data-testid={`board-slot-${role}-${slotIndex}`}
      aria-label={player ? `${player.name} — ${role === "starter" ? "선발" : "벤치"}` : "빈 슬롯"}
      onClick={() => onSlotTap({ role, slotIndex })}
    >
      {slot ? (
        <PlayerToken
          playerId={slot.playerId}
          player={player}
          hasPrompt={Boolean(slot.promptText)}
          condition={conditions?.[slot.playerId]}
          selected={selectedPlayerId === slot.playerId}
        />
      ) : (
        <span className={styles.emptyMark}>+</span>
      )}
    </button>
  );
}

/**
 * Drag-and-drop tactics board (AC-B3): pitch background with formation-snapped starter slots +
 * a bench strip. Players drag between slots (@dnd-kit, pointer+touch+keyboard sensors) and can
 * also be placed by tap-tap (select slot → tap player, handled by the parent via selectedSlot).
 */
export function TacticsBoard(props: TacticsBoardProps) {
  const { draft, onMove } = props;
  const coords = useMemo(() => starterCoords(draft.formation), [draft.formation]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  function handleDragEnd(e: DragEndEvent) {
    if (!e.over) return;
    const playerId = String(e.active.id);
    const target = parseDroppableId(String(e.over.id));
    onMove(playerId, target.role, target.slotIndex);
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className={styles.pitch} data-testid="tactics-board">
        {coords.map((c) => (
          <SlotCell
            key={`starter-${c.slotIndex}`}
            {...props}
            role="starter"
            slotIndex={c.slotIndex}
            className={styles.pitchSlot!}
            style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}
          />
        ))}
      </div>
      <div className={styles.benchSection}>
        <span className={styles.benchLabel}>벤치 (최대 {BENCH_MAX})</span>
        <div className={styles.benchRow} data-testid="board-bench">
          {Array.from({ length: BENCH_MAX }, (_, i) => (
            <SlotCell
              key={`bench-${i}`}
              {...props}
              role="bench"
              slotIndex={i}
              className={styles.benchCell!}
            />
          ))}
        </div>
      </div>
    </DndContext>
  );
}
