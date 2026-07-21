import { useEffect, useMemo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import type { CatalogPlayer } from "../api/hooks";
import { GRADE_COLORS, GRADE_LABELS } from "../common/grades";
import { CharAvatar } from "../common/CharAvatar";
import { findPlayerSlot, type DeckDraft } from "./deck-logic";
import { positionWeight } from "./auto-lineup";
import { rankPlayers } from "./player-ranking";
import { playerOverall } from "./team-power";
import { poolDraggableId } from "./TacticsBoard";
import type { components } from "../api/schema";
import type { ConditionMap } from "../api/v2";
import { ConditionClock } from "../match/ConditionClock";
import { conditionLabel } from "../match/condition-clock";
import styles from "./PlayerPicker.module.css";

type Position = components["schemas"]["Position"];
const POSITION_FILTERS: Array<Position | "ALL"> = ["ALL", "GK", "DF", "MF", "FW"];

interface PlayerPickerProps {
  /** owned players only (caller filters GET /api/players by owned) */
  players: CatalogPlayer[];
  draft: DeckDraft;
  onPick: (playerId: string) => void;
  /**
   * 당일 컨디션 {playerId: 0..1}. 덱 화면은 GET /api/conditions/today(useTodayConditions),
   * 브리핑은 매치 스냅샷(match.conditions)을 넘긴다. optional — 없으면 시계를 그리지 않는다.
   */
  conditions?: ConditionMap;
  /**
   * #106 R1 탭-투-플레이스: 보드에서 슬롯을 탭하면 그 슬롯 포지션으로 리스트가 **자동 필터**된다.
   * 값이 바뀔 때만 로컬 필터를 덮어쓴다(그 뒤 사용자가 직접 탭한 필터는 유지).
   */
  autoFilter?: Position | "ALL";
  /** 리스트에서 집어든(배치 대기) 선수 — 행이 강조된다. */
  pendingPlayerId?: string | null;
}

interface PoolItemProps {
  player: CatalogPlayer;
  placed: ReturnType<typeof findPlayerSlot>;
  onPick: (playerId: string) => void;
  condition?: number;
  fit: "best" | "mid" | "low" | null;
  pending: boolean;
}

const FIT_LABELS: Record<"best" | "mid" | "low", string> = { best: "적합", mid: "보통", low: "낮음" };
const FIT_CLASSES: Record<"best" | "mid" | "low", string> = {
  best: styles.fitBest!,
  mid: styles.fitMid!,
  low: styles.fitLow!,
};

/**
 * One owned-player row. Draggable (@dnd-kit, source id = `pool:${id}`) so it can be dragged onto a
 * board slot (보조 수단); the same button also tap-to-places (1급 수단, tap-place.ts).
 * A player already placed on the board is disabled (no drag, no tap) — no duplicates.
 */
function PoolItem({ player, placed, onPick, condition, fit, pending }: PoolItemProps) {
  const overall = Math.round(playerOverall(player.attributes));
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: poolDraggableId(player.id),
    disabled: Boolean(placed),
  });

  return (
    <button
      ref={setNodeRef}
      type="button"
      className={[placed ? styles.itemPlaced : styles.item, pending ? styles.itemPending : ""]
        .filter(Boolean)
        .join(" ")}
      data-testid={`pick-${player.id}`}
      data-pending={pending ? "true" : "false"}
      /* aria-pressed 는 @dnd-kit attributes 가 소유한다(드래그 상태) — 배치 대기는 data-pending + aria-label 로. */
      aria-label={pending ? `${player.name} — 배치할 슬롯을 고르세요` : undefined}
      disabled={Boolean(placed)}
      onClick={() => onPick(player.id)}
      style={isDragging ? { opacity: 0.4 } : undefined}
      {...listeners}
      {...attributes}
    >
      {/* 컨디션(당일 롤). 값이 없으면(로딩/미응답) 이 칸 자체를 생략한다.
          색각 대응(#106 R3b B): 리스트 행은 공간이 있으므로 시계(각도·파선) 위에 **글자 축**을
          하나 더 얹는다 — 색을 전혀 못 봐도 "최상/보통/저조"로 등급이 읽힌다. */}
      {condition !== undefined && (
        <span className={styles.cond}>
          <ConditionClock value={condition} size={18} testId={`pick-cond-${player.id}`} />
          <span className={styles.condTier} data-testid={`pick-cond-tier-${player.id}`}>
            {conditionLabel(condition)}
          </span>
        </span>
      )}
      <CharAvatar playerId={player.id} name={player.name} grade={player.grade} size={34} />
      <span className={styles.who}>
        <b className={styles.name}>{player.name}</b>
        <span className={styles.sub}>
          {player.position}
          <span className={styles.grade} style={{ color: GRADE_COLORS[player.grade] }}>
            {GRADE_LABELS[player.grade]}
          </span>
          {placed && (
            <span className={styles.placedMark}>{placed.role === "starter" ? "선발" : "벤치"}</span>
          )}
        </span>
      </span>
      {fit && (
        <span className={FIT_CLASSES[fit]} data-testid={`pick-fit-${player.id}`}>
          {FIT_LABELS[fit]}
        </span>
      )}
      {/* 스탯 총량 = playerOverall — 9개 능력치 평균(0..100). teamPower/Auto/추천정렬과 동일 지표. */}
      <span className={styles.overall} data-testid={`pick-overall-${player.id}`} title="종합 능력치">
        {overall}
      </span>
    </button>
  );
}

/** 포지션 필터 대비 적합도 티어 (auto-lineup.positionWeight 재사용 — Auto 배치와 같은 기준). */
function fitTier(player: CatalogPlayer, filter: Position | "ALL"): "best" | "mid" | "low" | null {
  if (filter === "ALL") return null;
  const w = positionWeight(player.position, filter);
  if (w >= 1) return "best";
  if (w >= 0.8) return "mid";
  return "low";
}

/**
 * 보유 선수 리스트 — 포지션 필터 + 추천순(player-ranking) 정렬. 탭하면 배치(탭-투-플레이스),
 * 드래그는 보조. #106 R1: 슬롯을 먼저 탭하면 `autoFilter` 로 그 포지션이 자동 선택된다.
 */
export function PlayerPicker({ players, draft, onPick, conditions, autoFilter, pendingPlayerId }: PlayerPickerProps) {
  const [filter, setFilter] = useState<Position | "ALL">("ALL");

  // 슬롯 탭 → 그 포지션으로 필터 전환(자동). autoFilter 가 바뀔 때만 반영한다.
  useEffect(() => {
    if (autoFilter) setFilter(autoFilter);
  }, [autoFilter]);

  const ranked = useMemo(() => {
    const filtered = filter === "ALL" ? players : players.filter((p) => p.position === filter);
    return rankPlayers(filtered, filter);
  }, [players, filter]);

  return (
    <section className={styles.picker} data-testid="player-pool">
      <div className={styles.header}>
        <h3 className={styles.title}>보유 선수 ({players.length})</h3>
        <span className={styles.sortNote} data-testid="picker-sort-note">
          {filter === "ALL" ? "추천순" : `${filter} 추천순`}
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
              fit={fitTier(p, filter)}
              pending={pendingPlayerId === p.id}
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
