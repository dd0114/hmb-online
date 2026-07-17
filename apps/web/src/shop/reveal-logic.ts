/**
 * Pure gacha reveal state machine (unit-tested) — drives GachaReveal's
 * sequential card-flip: cards start face-down and flip one at a time.
 */

export interface RevealState {
  total: number;
  /** number of cards currently face-up (revealed left-to-right) */
  revealed: number;
}

export function initialReveal(total: number): RevealState {
  return { total, revealed: 0 };
}

/** Flip the next face-down card. No-op once everything is revealed. */
export function revealNext(state: RevealState): RevealState {
  if (state.revealed >= state.total) return state;
  return { ...state, revealed: state.revealed + 1 };
}

export function revealAll(state: RevealState): RevealState {
  return { ...state, revealed: state.total };
}

export function isCardRevealed(state: RevealState, index: number): boolean {
  return index < state.revealed;
}

export function isAllRevealed(state: RevealState): boolean {
  return state.revealed >= state.total;
}
