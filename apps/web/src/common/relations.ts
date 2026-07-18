/**
 * 관계 표시 순수 헬퍼 (AC-C4) — 성격 메타 + 신뢰도/사기 게이지 계산 + 연승/연패 라벨.
 * 서버 GET /api/relations(RelationsResponse) 를 표시용으로 가공한다. UI 컴포넌트가 아니라
 * 순수 함수만 두어 단위 테스트로 게이지 계산을 박제한다(#96 W2 ④).
 */
import type { Personality, PlayerRelation, RelationsResponse } from "../api/v2";

function clamp01to100(n: number): number {
  return Math.max(0, Math.min(100, n));
}

// ── 성격 (players.personality, data v2.1) ──────────────────────────────────
export interface PersonalityMeta {
  id: Personality;
  emoji: string;
  /** 짧은 한글 라벨 */
  label: string;
  /** AI 반응 규칙 힌트(툴팁) — p2-servants 성격별 반응 규칙과 정합 */
  hint: string;
}

export const PERSONALITY_META: Record<Personality, PersonalityMeta> = {
  FIERY: { id: "FIERY", emoji: "🔥", label: "불같은", hint: "도전적·질책성 지시에 강하게 반응" },
  CALM: { id: "CALM", emoji: "🧊", label: "침착한", hint: "기복이 적어 압박·질책에도 흔들리지 않음" },
  GLASS: { id: "GLASS", emoji: "🥀", label: "유리멘탈", hint: "질책성 프롬프트에 역효과 — 격려 위주로" },
  AMBITIOUS: { id: "AMBITIOUS", emoji: "⭐", label: "야망가", hint: "기용·신뢰 보상에 민감하게 반응" },
};

export function personalityMeta(p: Personality | undefined): PersonalityMeta | undefined {
  return p ? PERSONALITY_META[p] : undefined;
}

// ── 신뢰도 게이지 (0..100) ────────────────────────────────────────────────
export type TrustTierKey = "high" | "mid" | "low" | "distrust";

export interface TrustTier {
  key: TrustTierKey;
  label: string;
  color: string;
  /** 0..1 게이지 채움 비율 */
  ratio: number;
  /** 0..100 정수 */
  value: number;
}

export function trustTier(trust: number): TrustTier {
  const value = Math.round(clamp01to100(trust));
  const ratio = value / 100;
  if (value >= 75) return { key: "high", label: "두터운 신뢰", color: "#3fb950", ratio, value };
  if (value >= 50) return { key: "mid", label: "보통", color: "#d6a935", ratio, value };
  if (value >= 25) return { key: "low", label: "낮음", color: "#db8a34", ratio, value };
  return { key: "distrust", label: "불신", color: "#da3633", ratio, value };
}

// ── 팀 사기 게이지 (0..100) + 연승/연패 ────────────────────────────────────
export type MoraleTierKey = "high" | "mid" | "low";

export interface MoraleTier {
  key: MoraleTierKey;
  label: string;
  color: string;
  ratio: number;
  value: number;
}

export function moraleTier(morale: number): MoraleTier {
  const value = Math.round(clamp01to100(morale));
  const ratio = value / 100;
  if (value >= 66) return { key: "high", label: "높음", color: "#3fb950", ratio, value };
  if (value >= 33) return { key: "mid", label: "보통", color: "#d6a935", ratio, value };
  return { key: "low", label: "침체", color: "#da3633", ratio, value };
}

/** streak: +연승 / -연패 / 0 없음 (openapi RelationsResponse.streak). */
export function streakLabel(streak: number): string {
  const n = Math.trunc(streak);
  if (n > 0) return `${n}연승`;
  if (n < 0) return `${-n}연패`;
  return "연승·연패 없음";
}

export function streakTone(streak: number): "win" | "loss" | "none" {
  const n = Math.trunc(streak);
  return n > 0 ? "win" : n < 0 ? "loss" : "none";
}

/** relations 응답에서 특정 선수의 관계를 찾는다(없으면 undefined). */
export function relationOf(
  relations: RelationsResponse | undefined,
  playerId: string,
): PlayerRelation | undefined {
  return relations?.players.find((r) => r.playerId === playerId);
}
