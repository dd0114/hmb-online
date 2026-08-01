// @hmb/engine — Tier B 축소 공간 결정론 매치 엔진. (PRD §7)
export * from "./config";
export * from "./fixedmath";
export * from "./rng";
export * from "./pitch";
export * from "./ball";
export * from "./perception";
export * from "./decision";
export * from "./contest";
export * from "./hash";
export * from "./match";
export * from "./fixtures";
export type { SimState, SimPlayer, Ball, BallFlight, PossessionReason, SetPiece, DeferredRestart } from "./simstate";
export {
  playerKey,
  buildById,
  playerAt,
  ballOwnerOf,
  claimantSideOf,
  otherSide,
  setPossession,
  INTENT_KINDS,
  SET_PIECE_KINDS,
} from "./simstate";
export type { TeamPlan } from "./teamplan";
export { computeTeamPlan } from "./teamplan";
