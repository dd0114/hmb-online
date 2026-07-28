import { useState } from "react";
import type { CatalogPlayer } from "../api/hooks";
import type { FaProposeRequest } from "../api/v2";
import { GRADE_LABELS } from "../common/grades";
import { Amount, useCurrency } from "../common/Amount";
import { CURRENCY_POINT } from "../common/currency";
import {
  canPropose,
  initialProposal,
  setPoints,
  togglePlayer,
  toRequest,
} from "./propose-builder";
import styles from "./ProposeBuilder.module.css";

interface ProposeBuilderProps {
  /** My owned players (offer pool). */
  owned: CatalogPlayer[];
  /** Wallet balance = points slider max. */
  maxPoints: number;
  pending: boolean;
  onSubmit: (body: FaProposeRequest) => void;
}

/**
 * FA offer builder (AC-D UI): multi-select my players + points slider. No pre-submit success
 * probability — GET /api/trade gives no FA probability (PlayerRef has no priceable value and
 * client-side probability is forbidden); the result % arrives in TradeResolveResponse. That's
 * surfaced to the user as an explicit note rather than a fake gauge.
 */
export function ProposeBuilder({ owned, maxPoints, pending, onSubmit }: ProposeBuilderProps) {
  const pointCurrency = useCurrency(CURRENCY_POINT);
  const [state, setState] = useState(initialProposal);

  const submittable = canPropose(state) && !pending;

  return (
    <div className={styles.builder} data-testid="propose-builder">
      <div className={styles.section}>
        <span className={styles.sectionLabel}>내 선수 제안 ({state.selected.length})</span>
        <div className={styles.chips}>
          {owned.length === 0 && <span className={styles.empty}>제안할 보유 선수가 없습니다</span>}
          {owned.map((p) => {
            const on = state.selected.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                className={[styles.chip, on ? styles.chipOn : ""].filter(Boolean).join(" ")}
                data-testid={`propose-chip-${p.id}`}
                data-selected={on ? "true" : "false"}
                aria-pressed={on}
                onClick={() => setState((s) => togglePlayer(s, p.id))}
              >
                <span className={styles.chipPos}>{p.position}</span>
                <span className={styles.chipName}>{p.name}</span>
                <span className={styles.chipGrade}>{GRADE_LABELS[p.grade]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.section}>
        <label className={styles.sectionLabel} htmlFor="propose-points">
          함께 낼 {pointCurrency.name}:{" "}
          <Amount
            className={styles.pointsValue}
            data-testid="propose-points-value"
            code={CURRENCY_POINT}
            value={state.points}
          />
        </label>
        <input
          id="propose-points"
          type="range"
          className={styles.slider}
          min={0}
          max={Math.max(0, Math.floor(maxPoints))}
          step={100}
          value={state.points}
          data-testid="propose-points"
          onChange={(e) => setState((s) => setPoints(s, Number(e.target.value), maxPoints))}
        />
      </div>

      <p className={styles.probNote} data-testid="propose-prob-note">
        성공 확률은 제안을 보낸 뒤 결과에서 공개됩니다.
      </p>

      <button
        type="button"
        className={styles.submit}
        data-testid="propose-submit"
        disabled={!submittable}
        onClick={() => onSubmit(toRequest(state))}
      >
        제안 보내기
      </button>
    </div>
  );
}
