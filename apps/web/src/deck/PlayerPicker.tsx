import { useMemo, useState } from "react";
import type { CatalogPlayer } from "../api/hooks";
import { GRADE_COLORS, GRADE_LABELS } from "../common/grades";
import { findPlayerSlot, type DeckDraft } from "./deck-logic";
import type { components } from "../api/schema";
import styles from "./PlayerPicker.module.css";

type Position = components["schemas"]["Position"];
const POSITION_FILTERS: Array<Position | "ALL"> = ["ALL", "GK", "DF", "MF", "FW"];

interface PlayerPickerProps {
  /** owned players only (caller filters GET /api/players by owned) */
  players: CatalogPlayer[];
  draft: DeckDraft;
  onPick: (playerId: string) => void;
}

/** Owned-player pool list with position filter tabs. Tap → assign to the selected/first empty slot. */
export function PlayerPicker({ players, draft, onPick }: PlayerPickerProps) {
  const [filter, setFilter] = useState<Position | "ALL">("ALL");

  const filtered = useMemo(
    () => (filter === "ALL" ? players : players.filter((p) => p.position === filter)),
    [players, filter],
  );

  return (
    <section className={styles.picker}>
      <h3 className={styles.title}>보유 선수 ({players.length})</h3>
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
        {filtered.map((p) => {
          const placed = findPlayerSlot(draft, p.id);
          return (
            <li key={p.id}>
              <button
                type="button"
                className={placed ? styles.itemPlaced : styles.item}
                data-testid={`pick-${p.id}`}
                disabled={Boolean(placed)}
                onClick={() => onPick(p.id)}
              >
                <span className={styles.pos}>{p.position}</span>
                <span className={styles.name}>{p.name}</span>
                <span className={styles.grade} style={{ color: GRADE_COLORS[p.grade] }}>
                  {GRADE_LABELS[p.grade]}
                </span>
                {placed && (
                  <span className={styles.placedMark}>
                    {placed.role === "starter" ? "선발" : "벤치"}
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {filtered.length === 0 && <li className={styles.emptyNote}>해당 포지션 보유 선수가 없습니다</li>}
      </ul>
    </section>
  );
}
