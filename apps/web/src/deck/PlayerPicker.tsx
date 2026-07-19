import { useMemo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import type { CatalogPlayer } from "../api/hooks";
import { GRADE_COLORS, GRADE_LABELS } from "../common/grades";
import { findPlayerSlot, type DeckDraft } from "./deck-logic";
import { rankPlayers } from "./player-ranking";
import { playerOverall } from "./team-power";
import { poolDraggableId } from "./TacticsBoard";
import type { components } from "../api/schema";
import type { ConditionMap } from "../api/v2";
import { ConditionClock } from "../match/ConditionClock";
import styles from "./PlayerPicker.module.css";

type Position = components["schemas"]["Position"];
const POSITION_FILTERS: Array<Position | "ALL"> = ["ALL", "GK", "DF", "MF", "FW"];

interface PlayerPickerProps {
  /** owned players only (caller filters GET /api/players by owned) */
  players: CatalogPlayer[];
  draft: DeckDraft;
  onPick: (playerId: string) => void;
  /**
   * 요구 6(#98): 당일 컨디션 {playerId: 0..1}. 덱 화면은 GET /api/conditions/today(useTodayConditions),
   * 브리핑은 매치 스냅샷(match.conditions)을 넘긴다. optional — 없으면 시계를 그리지 않는다(graceful).
   */
  conditions?: ConditionMap;
}

interface PoolItemProps {
  player: CatalogPlayer;
  placed: ReturnType<typeof findPlayerSlot>;
  onPick: (playerId: string) => void;
  condition?: number;
}

/**
 * One owned-player row. Draggable (@dnd-kit, source id = `pool:${id}`) so it can be dragged onto a
 * board slot within the DeckEditor-level DndContext (요구 5); the same button also tap-to-places
 * (mouse = MouseSensor distance:6, touch = TouchSensor delay:150 — either way a plain click/tap
 * with no drag still fires onClick, so tap-to-place stays the accessible fallback).
 * A player already placed on the board is disabled (no drag, no tap) — no duplicates.
 */
function PoolItem({ player, placed, onPick, condition }: PoolItemProps) {
  const overall = Math.round(playerOverall(player.attributes));
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: poolDraggableId(player.id),
    disabled: Boolean(placed),
  });

  return (
    <button
      ref={setNodeRef}
      type="button"
      className={placed ? styles.itemPlaced : styles.item}
      data-testid={`pick-${player.id}`}
      disabled={Boolean(placed)}
      onClick={() => onPick(player.id)}
      style={isDragging ? { opacity: 0.4 } : undefined}
      {...listeners}
      {...attributes}
    >
      <span className={styles.pos}>{player.position}</span>
      <span className={styles.name}>{player.name}</span>
      {/* 스탯 총량(요구 6) = playerOverall — 9개 능력치 평균(0..100). teamPower/Auto/추천정렬과 동일 지표. */}
      <span className={styles.overall} data-testid={`pick-overall-${player.id}`} title="종합 능력치">
        {overall}
      </span>
      {/* 컨디션(요구 6) = 당일 롤. 값이 없으면(로딩/미응답) 이 칸 자체를 생략한다. */}
      {condition !== undefined && (
        <ConditionClock value={condition} size={18} testId={`pick-cond-${player.id}`} />
      )}
      <span className={styles.grade} style={{ color: GRADE_COLORS[player.grade] }}>
        {GRADE_LABELS[player.grade]}
      </span>
      {placed && (
        <span className={styles.placedMark}>{placed.role === "starter" ? "선발" : "벤치"}</span>
      )}
    </button>
  );
}

/**
 * Owned-player pool list with position filter tabs, sorted by 추천 순위 (player-ranking):
 * fit for the active position filter, or overall for ALL. Drag a row onto a board slot, or tap it
 * to place into the selected/first-empty slot.
 */
export function PlayerPicker({ players, draft, onPick, conditions }: PlayerPickerProps) {
  const [filter, setFilter] = useState<Position | "ALL">("ALL");

  const ranked = useMemo(() => {
    const filtered = filter === "ALL" ? players : players.filter((p) => p.position === filter);
    return rankPlayers(filtered, filter);
  }, [players, filter]);

  return (
    <section className={styles.picker}>
      <div className={styles.header}>
        <h3 className={styles.title}>보유 선수 ({players.length})</h3>
        <span className={styles.sortNote} data-testid="picker-sort-note">
          추천순
        </span>
      </div>
      <div className={styles.tabs} role="tablist">
        {POSITION_FILTERS.map((pos) => (
          <button
            key={pos}
            type="button"
            role="tab"
            aria-selected={filter === pos}
            className={filter === pos ? styles.tabActive : styles.tab}
            data-testid={`picker-filter-${pos}`}
            onClick={() => setFilter(pos)}
          >
            {pos === "ALL" ? "전체" : pos}
          </button>
        ))}
      </div>
      <ul className={styles.list}>
        {ranked.map((p) => (
          <li key={p.id}>
            <PoolItem
              player={p}
              placed={findPlayerSlot(draft, p.id)}
              onPick={onPick}
              condition={conditions?.[p.id]}
            />
          </li>
        ))}
        {ranked.length === 0 && (
          <li className={styles.emptyNote}>해당 포지션 보유 선수가 없습니다</li>
        )}
      </ul>
    </section>
  );
}
