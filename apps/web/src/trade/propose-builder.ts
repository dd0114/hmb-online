/**
 * Pure FA-proposal builder state (unit-tested) — my-player multi-select toggle + points range.
 * The FA slot has no pre-probability from GET /api/trade (PlayerRef carries no value we can
 * price client-side, and clay-side probability is forbidden), so the builder just assembles a
 * valid FaProposeRequest; the result probability comes back in TradeResolveResponse.
 */
import type { FaProposeRequest } from "../api/v2";

export interface ProposalState {
  /** Selected owned playerIds (offer side), insertion-ordered. */
  selected: string[];
  /** Points to include with the offer. */
  points: number;
}

export function initialProposal(): ProposalState {
  return { selected: [], points: 0 };
}

/** Toggle an owned player in/out of the offer. */
export function togglePlayer(state: ProposalState, playerId: string): ProposalState {
  const has = state.selected.includes(playerId);
  return {
    ...state,
    selected: has ? state.selected.filter((id) => id !== playerId) : [...state.selected, playerId],
  };
}

/** Clamp points into [0, max] (max = wallet balance, integer). */
export function setPoints(state: ProposalState, value: number, max: number): ProposalState {
  const hi = Math.max(0, Math.floor(max));
  const clamped = Math.max(0, Math.min(hi, Math.floor(Number.isFinite(value) ? value : 0)));
  return { ...state, points: clamped };
}

/** Reset after a submit or slot change. */
export function resetProposal(): ProposalState {
  return initialProposal();
}

/** An offer is submittable once at least one owned player is on the table (다중선택). */
export function canPropose(state: ProposalState): boolean {
  return state.selected.length > 0;
}

/** Serialize to the API request body (FaProposeRequest). */
export function toRequest(state: ProposalState): FaProposeRequest {
  return { playerIds: [...state.selected], points: state.points };
}
