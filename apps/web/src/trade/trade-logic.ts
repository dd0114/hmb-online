/**
 * Pure trade helpers (unit-tested) — countdown, slot classification, speedup button gating.
 * No network, no clock reads: the component passes elapsed-since-fetch so these stay
 * deterministic and testable. (LLD-p2-web §4, AC-D1~D5 UI 관점.)
 */
import type { TradeSlot } from "../api/v2";

/** UI-side slot kind = server state × offerKind (openapi-v2 TradeSlot). */
export type SlotView = "WAITING" | "OPEN_FA" | "OPEN_TRADE" | "RESOLVING";

export function slotView(slot: TradeSlot): SlotView {
  if (slot.state === "WAITING") return "WAITING";
  if (slot.state === "RESOLVING") return "RESOLVING";
  // state === "OPEN"
  return slot.offerKind === "TRADE" ? "OPEN_TRADE" : "OPEN_FA";
}

/**
 * Countdown seconds, anchored on the server's `remainingSec` at fetch time and only the
 * *local elapsed* since then — so absolute client clock drift is harmless (task: 서버 시각
 * 기준, 클라 드리프트 무해). Never negative.
 */
export function countdownSec(remainingSecAtFetch: number, elapsedMs: number): number {
  const elapsedSec = Math.floor(Math.max(0, elapsedMs) / 1000);
  return Math.max(0, Math.floor(remainingSecAtFetch) - elapsedSec);
}

/** Format seconds as M:SS (or H:MM:SS when ≥ 1h) for the WAITING dial. */
export function formatCountdown(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(mins)}:${pad(secs)}`;
  return `${mins}:${pad(secs)}`;
}

/** Percentage (0..1) as a display string for a probability the server computed. */
export function formatProbability(p: number | null | undefined): string | null {
  if (p == null) return null;
  const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
  return `${pct}%`;
}

export interface SpeedupState {
  /** Button disabled: not loaded yet, pending, no cost, or short on points. */
  disabled: boolean;
  /** Show the "포인트 부족" hint (loaded + known cost + short). */
  showShort: boolean;
}

/**
 * Speedup button gating — mirrors shop's gachaButtonState (#73: never show '부족' before the
 * wallet loads). `cost` is the server-provided speedupCost (null when not shortenable).
 */
export function speedupButtonState(args: {
  loaded: boolean;
  points: number;
  cost: number | null | undefined;
  pending: boolean;
}): SpeedupState {
  const { loaded, points, cost, pending } = args;
  const hasCost = typeof cost === "number";
  const short = loaded && hasCost && points < (cost as number);
  return {
    disabled: pending || !loaded || !hasCost || short,
    showShort: Boolean(short),
  };
}
