import { z } from "zod";
import { Vec2 } from "./vec.js";
import { PlayerBehavior, Duty, TacticalInput } from "./tactical-input.js";
import { clampTacticalInput } from "./clamp.js";
import type { ManualTactics } from "./team-input-job.js";

/**
 * TacticalPatch — A+B 린패치 분리(#82 인계 / p2-servants W3)의 **벌크 조정 계약**.
 *
 * B(패치 생성) 잡의 출력. A(베이스 TacticalInput)에 **정적으로 머지**하면 완전한 TacticalInput 이 된다.
 * "전원 압박"·"수비진 라인 올려" 같은 지시를 몇 줄로 표현해 **출력 토큰을 억제**(perf 실측: 6805→~1193)하는 게 목적.
 *
 * 설계 근거(측정): latency ∝ 생성 토큰 총량 → B 는 **절대값 패치만** 출력하고(A 재기술 금지),
 * 머지가 A 위에 정적으로 얹는다. 값은 절대값(상대 증분 아님) — 머지·클램프가 결정론.
 *
 * 모든 필드 additive optional + `.strict()`(모델이 미지정 필드를 지어내지 못하게). 출력 토큰 목표 ~1–2k.
 */

/**
 * 성향 파라미터 부분 패치(9필드 전부 optional, 0..1).
 * `.strict()` — 오타 필드(예: "shooting" 대신 정식 shootTendency 아닌 것)를 조용히 strip 하지 않고 거부한다
 * (unknownKeys=strip 기본이면 헛필드가 소실 → 지시 누락). parse 거부 → 실행기 VALIDATE 재시도 경로.
 */
export const PlayerBehaviorPatch = PlayerBehavior.partial().strict();
export type PlayerBehaviorPatch = z.infer<typeof PlayerBehaviorPatch>;

/** 부분 좌표 패치(x/y optional) — leaf strict(헛필드 거부). */
export const BasePositionPatch = Vec2.partial().strict();
export type BasePositionPatch = z.infer<typeof BasePositionPatch>;

/**
 * 팀 전술 패치 — **평탄(flat) 스칼라**. pressingScheme 는 pressIntensity/pressTriggerLine 로 평탄화해
 * 모델 출력을 얕게 유지한다(머지가 team.pressingScheme.{intensity,triggerLine} 로 되돌린다).
 * formation 은 A(덱) 소유라 패치 불가.
 */
export const TeamPatch = z
  .object({
    defensiveLineHeight: z.number().optional(),
    compactness: z.number().optional(),
    tempo: z.number().optional(),
    width: z.number().optional(),
    /** → team.pressingScheme.intensity */
    pressIntensity: z.number().optional(),
    /** → team.pressingScheme.triggerLine */
    pressTriggerLine: z.number().optional(),
    offsideTrap: z.boolean().optional(),
  })
  .strict();
export type TeamPatch = z.infer<typeof TeamPatch>;

/** 포지션 그룹 벌크 패치 값(그룹 전원에 적용). */
export const PositionPatch = z
  .object({
    behavior: PlayerBehaviorPatch.optional(),
    mentalModifier: z.number().optional(),
  })
  .strict();
export type PositionPatch = z.infer<typeof PositionPatch>;

/** 포지션 그룹(엔진 role 에서 파생 — roleToPositionGroup). "전원/수비진/공격진 …" 벌크 지시의 열쇠. */
export const PositionGroup = z.enum(["GK", "DF", "MF", "FW"]);
export type PositionGroup = z.infer<typeof PositionGroup>;

/** 그룹별 벌크 패치 묶음(명시적 키 — 모델에 그룹 집합을 고정 노출). */
export const ByPositionPatch = z
  .object({
    GK: PositionPatch.optional(),
    DF: PositionPatch.optional(),
    MF: PositionPatch.optional(),
    FW: PositionPatch.optional(),
  })
  .strict();
export type ByPositionPatch = z.infer<typeof ByPositionPatch>;

/** 개별 선수 오버라이드(byPosition 위에 우선 적용). markTarget 은 markTargets 로 분리. */
export const PlayerPatch = z
  .object({
    behavior: PlayerBehaviorPatch.optional(),
    /** 부분 좌표(x/y 각각 optional). */
    basePosition: BasePositionPatch.optional(),
    mentalModifier: z.number().optional(),
    duty: Duty.optional(),
  })
  .strict();
export type PlayerPatch = z.infer<typeof PlayerPatch>;

export const TacticalPatch = z
  .object({
    /** 팀 전술 벌크 조정. */
    team: TeamPatch.optional(),
    /** 포지션 그룹 벌크 조정(GK/DF/MF/FW). */
    byPosition: ByPositionPatch.optional(),
    /** 선수 개별 조정 {playerId: patch}. byPosition 다음에 적용(우선). */
    byPlayer: z.record(z.string(), PlayerPatch).optional(),
    /** 전담 마크 {수비수 playerId: 상대 targetId}. 마지막에 적용. */
    markTargets: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type TacticalPatch = z.infer<typeof TacticalPatch>;

/**
 * 엔진 role 문자열 → 포지션 그룹(GK/DF/MF/FW). applyPatch(byPosition)이 base.players[].role 로 그룹을 판정한다.
 * TacticalInput.PlayerInput 은 position 을 담지 않으므로(role 만) role 로 파생 → applyPatch 를 (base,patch,seed)만으로 순수 유지.
 * 규칙(우선순위): GK → CB/LB/RB/WB/DF → DM/CM/AM/MF → 그 외(LW/RW/ST/CF/…) = FW.
 */
export function roleToPositionGroup(role: string): PositionGroup {
  const r = role.toUpperCase();
  if (r === "GK") return "GK";
  if (/(CB|LB|RB|WB|DF)/.test(r)) return "DF";
  if (/(DM|CM|AM|MF)/.test(r)) return "MF";
  return "FW";
}

export interface ApplyPatchOptions {
  /** 머지 시 주입할 엔진 시드(halfSeed). 미지정 시 base.seed 유지. A 콘텐츠에서 seed 를 뺄 수 있게 하는 통과 필드. */
  seed?: string;
}

/**
 * applyPatch — A(베이스 TacticalInput)에 B(TacticalPatch)를 **정적 머지**한 완전한 TacticalInput.
 *
 * **순수·결정론**: rng/date 없음, 같은 (base, patch, seed) → 같은 출력. 적용 순서 = team → byPosition → byPlayer → markTargets.
 * 값은 절대값(패치가 지정한 축만 덮어씀 — 미지정 축은 A 베이스 유지). 마지막에 zod 검증 + 전 수치 클램프.
 */
export function applyPatch(
  base: TacticalInput,
  patch: TacticalPatch,
  opts: ApplyPatchOptions = {},
): TacticalInput {
  // 1) team — flat 패치를 team(+pressingScheme)으로 되돌려 적용.
  const team = { ...base.team, pressingScheme: { ...base.team.pressingScheme } };
  const tp = patch.team;
  if (tp) {
    if (tp.defensiveLineHeight !== undefined) team.defensiveLineHeight = tp.defensiveLineHeight;
    if (tp.compactness !== undefined) team.compactness = tp.compactness;
    if (tp.tempo !== undefined) team.tempo = tp.tempo;
    if (tp.width !== undefined) team.width = tp.width;
    if (tp.pressIntensity !== undefined) team.pressingScheme.intensity = tp.pressIntensity;
    if (tp.pressTriggerLine !== undefined) team.pressingScheme.triggerLine = tp.pressTriggerLine;
    if (tp.offsideTrap !== undefined) team.offsideTrap = tp.offsideTrap;
  }

  // 2) players — 깊은 복제 후 byPosition → byPlayer → markTargets 순.
  const players = base.players.map((p) => {
    const np = { ...p, behavior: { ...p.behavior }, basePosition: { ...p.basePosition } };

    // 2a) byPosition (그룹 벌크)
    const grp = patch.byPosition?.[roleToPositionGroup(np.role)];
    if (grp?.behavior) np.behavior = { ...np.behavior, ...grp.behavior };
    if (grp?.mentalModifier !== undefined) np.mentalModifier = grp.mentalModifier;

    // 2b) byPlayer (개별 오버라이드 — byPosition 위에 우선)
    const bp = patch.byPlayer?.[np.playerId];
    if (bp?.behavior) np.behavior = { ...np.behavior, ...bp.behavior };
    if (bp?.basePosition) np.basePosition = { ...np.basePosition, ...bp.basePosition };
    if (bp?.mentalModifier !== undefined) np.mentalModifier = bp.mentalModifier;
    if (bp?.duty !== undefined) np.duty = bp.duty;

    return np;
  });

  // 2c) markTargets (수비수 playerId → 상대 targetId)
  if (patch.markTargets) {
    const byId = new Map(players.map((p) => [p.playerId, p]));
    for (const [defId, targetId] of Object.entries(patch.markTargets)) {
      const d = byId.get(defId);
      if (d) d.markTarget = targetId;
    }
  }

  const merged: TacticalInput = {
    ...base,
    seed: opts.seed ?? base.seed, // seed 는 통과 필드 — 머지 시 halfSeed 주입 가능.
    team,
    players,
  };
  // 최종: 형태 검증(zod) + 전 수치 클램프. **머지 산출물**에 적용(B 출력 자체가 아니라 — #82 §5).
  return clampTacticalInput(TacticalInput.parse(merged));
}

/**
 * A(베이스 생성) 크로스매치 캐시 **키 규약** — Java 캐시 소유이나 키 재료(정규화)는 여기서 단일 정의.
 *
 * A-key = f(덱 스냅샷) — **matchId/side/half/seed 제외**(크로스매치·양팀 재사용). Java 는 이 정규 문자열을
 * sha256 해 캐시 키로 쓴다(shared 는 crypto 미의존 — 브라우저 호환). 같은 덱(로스터+포메이션+사전프롬프트+수동전술)
 * → 같은 material → 같은 A. 봇은 B 가 없어 A 만 → 봇 인풋이 자동 크로스매치 캐시된다.
 */
export interface BaseContextKeyInput {
  formation: string;
  /** 덱 스냅샷(선발) — playerId·slotIndex·attributes 가 A 성향을 결정. name 은 키에서 제외(식별 무관). */
  roster: ReadonlyArray<{ playerId: string; slotIndex: number; attributes: unknown }>;
  /** 덱 사전(팀) 프롬프트 — 매치시점 추가 프롬프트가 아니라 덱에 저장된 기본 지시. */
  teamPrompt: string;
  /** 덱 사전 선수별 프롬프트. */
  playerPrompts: Record<string, string>;
  /** 수동 팀 전술(A-base 슬라이더). */
  manualTactics?: ManualTactics;
}

/** 키 안정 정규화용 — 객체 키를 재귀 정렬해 결정론 JSON 을 만든다(부수효과·rng·date 0). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * A-key 재료(정규 JSON 문자열). Java 가 이 문자열을 sha256 → 캐시 키. matchId/seed/side/half 는 재료에서 제외.
 * roster 는 slotIndex 오름차순 정규화(입력 순서 무관 안정성).
 */
export function baseContextKeyMaterial(input: BaseContextKeyInput): string {
  const roster = [...input.roster]
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((r) => ({ playerId: r.playerId, slotIndex: r.slotIndex, attributes: r.attributes }));
  return JSON.stringify(
    canonicalize({
      // 규약 버전 — A 성향 결정 로직이 바뀌면 올려 캐시 무효화. **Java BaseContextKey.material 과 동시에**
      // 올려야 한다(한쪽만 올리면 전 매치 캐시 미스). 두 값은 크로스언어 앵커 테스트가 묶는다.
      // v2 (#324): 프롬프트가 슬롯 기준 좌표를 전달하고 겹침을 금지하도록 계약이 바뀌었다 —
      //            그 이전 A 산출(라이브 78개 중 9개가 겹친 배치)을 재사용하면 고쳐도 안 바뀐다.
      v: 2,
      formation: input.formation,
      roster,
      teamPrompt: input.teamPrompt,
      playerPrompts: input.playerPrompts,
      manualTactics: input.manualTactics ?? null,
    }),
  );
}
