/**
 * Pure trade helpers (unit-tested) — countdown, slot classification, speedup button gating.
 * No network, no clock reads: the component passes elapsed-since-fetch so these stay
 * deterministic and testable. (LLD-p2-web §4, AC-D1~D5 UI 관점.)
 */
import type { TradeSlot } from "../api/v2";
import { GRADE_COLORS, GRADE_LABELS, type Grade } from "../common/grades";

/** UI-side slot kind = server state × offerKind (openapi-v2 TradeSlot). */
export type SlotView = "IDLE" | "WAITING" | "OPEN_FA" | "OPEN_TRADE" | "RESOLVING";

export function slotView(slot: TradeSlot): SlotView {
  // IDLE 우선 — 장이 닫힌 슬롯은 잔여 오퍼 필드가 남아 있어도 오퍼를 그리지 않는다(#149).
  if (slot.state === "IDLE") return "IDLE";
  if (slot.state === "WAITING") return "WAITING";
  if (slot.state === "RESOLVING") return "RESOLVING";
  // state === "OPEN"
  return slot.offerKind === "TRADE" ? "OPEN_TRADE" : "OPEN_FA";
}

/** Badge copy per view — IDLE 은 "장 닫힘"(유저가 열어야 함). */
export function slotBadgeLabel(view: SlotView): string {
  switch (view) {
    case "IDLE":
      return "장 닫힘";
    case "WAITING":
      return "접촉 중";
    case "OPEN_FA":
      return "FA 영입";
    case "OPEN_TRADE":
      return "트레이드 제안";
    case "RESOLVING":
      return "처리 중";
  }
}

/** WAITING 세부 분기 — 티저(가려짐) vs 이미 본 선수의 쿨타임(공개 유지). */
export type WaitingReveal = "MASKED" | "REVEALED";

/**
 * 계약(openapi-v2 TradeSlot): WAITING 이라도 **아직 한 번도 공개된 적 없는 오퍼만** 가려진다.
 * 이미 OPEN 으로 공개됐던 오퍼가 다시 WAITING 이 된 경우(FA 제안 실패 후 재제안 쿨타임)는
 * target 이 계속 채워져 오므로 도로 가리지 않는다(인지 부조화 방지). 판별 기준 = `target` 유무.
 */
export function waitingReveal(slot: TradeSlot): WaitingReveal {
  return slot.target ? "REVEALED" : "MASKED";
}

/** 같은 카운트다운이지만 의미가 다르다 — 정체 공개까지 vs 재제안 가능까지. */
export function waitingCountdownLabel(reveal: WaitingReveal): string {
  return reveal === "REVEALED" ? "재제안까지" : "공개까지";
}

export interface StartButtonState {
  /** 버튼 노출 여부 — WAITING/RESOLVING 에서는 서버가 400 이므로 감춘다. */
  visible: boolean;
  /** IDLE=최초 시작 / OPEN=거래 안함(= 장 시작을 다시 누른 것과 동일). */
  kind: "start" | "skip" | null;
  label: string;
}

/**
 * `POST /api/trade/{slot}/start` 버튼 게이팅(#149). 같은 엔드포인트지만 문맥에 따라 문구가 다르다:
 * IDLE 이면 "장 시작!", OPEN 이면 공개된 선수를 버리는 "거래 안함"(새 오퍼·새 대기).
 */
export function startButtonState(view: SlotView): StartButtonState {
  if (view === "IDLE") return { visible: true, kind: "start", label: "장 시작!" };
  if (view === "OPEN_FA" || view === "OPEN_TRADE") {
    return { visible: true, kind: "skip", label: "거래 안함" };
  }
  return { visible: false, kind: null, label: "" };
}

/**
 * WAITING 배지 문구 — **등급만** 공개(선수 정체는 카운트다운 만료 전까지 서버가 null 로 감춘다).
 * 서버가 등급 유니온을 넓히더라도 원문 그대로 흘려보낸다(unknown grade fallback).
 */
export function gradeContactLabel(grade: string | null | undefined): string | null {
  if (!grade) return null;
  const label = GRADE_LABELS[grade as Grade] ?? grade;
  return `${label} 등급 접촉 중`;
}

/** 공유 등급 팔레트 재사용(도감/뽑기와 동일 색). 알 수 없는 등급은 중립색. */
export function gradeColor(grade: string | null | undefined): string {
  if (!grade) return "var(--text-muted)";
  return GRADE_COLORS[grade as Grade] ?? "var(--text-muted)";
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
