import type {
  ManualTactics,
  PlayerRelationContext,
  TeamInputRosterEntry,
  TeamMoraleContext,
} from "@hmb/shared";

/**
 * context-blocks — Phase 2 컨텍스트 확장(AC-C4)의 프롬프트 블록 렌더러.
 *
 * 전부 **순수 함수**(부수효과·IO·rng·date 0). buildTeamInputPrompt(현행 단일생성)과
 * 향후 #82 A+B 린패치 프롬프트(W3) 양쪽에서 **그대로 재사용**되도록 coach 에서 분리했다.
 *  - manualTactics = A+B 의 A-base → W3 의 A 프롬프트가 이 블록을 그대로 씀.
 *  - relations/teamMorale = B(순간 톤·사기) 해석 입력 → W3 의 B 프롬프트가 이 블록을 그대로 씀.
 *
 * **출력 스키마(TacticalInput)는 불변**(P2-D8) — 이 블록들은 프롬프트 입력만 늘린다.
 * 컨텍스트가 없으면(undefined) 각 렌더러는 `null` 을 반환 → 빌더가 해당 블록을 생략.
 */

/** manualTactics.line/press/tempo/width → TacticalInput 팀 필드 매핑(고정 문자열, 프롬프트 명세용). */
const TACTICS_FIELD_MAP =
  "line→team.defensiveLineHeight, press→team.pressingScheme.intensity, tempo→team.tempo, width→team.width";

/**
 * 성격 4종 반응 규칙(P2-D7, AC-C4) — **고정 문구**. 성격별 mentalModifier/behavior 반응 방향을 명문화.
 * (프롬프트 캐시·스냅샷 안정성을 위해 조건부가 아닌 상수. 관계 컨텍스트가 있을 때만 렌더된다.)
 */
export const PERSONALITY_REACTION_RULES = [
  "성격별 반응 규칙(mentalModifier -1..1 및 관련 behavior 강도에 반영):",
  "- FIERY(불꽃): 강하거나 공격적인 지시에 과반응한다 — 관련 behavior 를 더 크게 잡고 mentalModifier 를 상향한다.",
  "- GLASS(유리멘탈): 질책·압박성 문구에 위축된다 — 역효과로 mentalModifier 를 하향하고, 지시 강도를 무리하게 올리지 않는다.",
  "- AMBITIOUS(야심가): 공격·전진 지시를 선호한다 — 공격 성향(shootTendency·forwardRunFreq 등)에 적극 반응하고 mentalModifier 를 상향한다.",
  "- CALM(침착): 지시 톤에 흔들리지 않는다 — 과반응·위축 없이 안정적으로 반영한다.",
  "신뢰도(trust)가 낮은 선수(대략 40 미만)는 지시 이행도를 완화한다 — 지시 강도를 그대로 반영하지 말고 보수적으로 조정한다.",
].join("\n");

/** 컨디션 값(0..1)을 사람이 읽는 밴드로. 12시(1.0)=최고 … 6시(0.0)=최저 시계 UI 정합. */
function conditionBand(v: number): string {
  if (v >= 0.8) return "최상";
  if (v >= 0.6) return "좋음";
  if (v >= 0.4) return "보통";
  if (v >= 0.2) return "저조";
  return "최저";
}

/**
 * 수동 팀 전술 블록 — "이 값을 베이스로, 프롬프트로 보정만"(A+B 의 A 정합).
 * @returns 블록 문자열, manualTactics 없으면 null.
 */
export function renderManualTacticsBlock(mt: ManualTactics | undefined): string | null {
  if (!mt) return null;
  return [
    "수동 팀 전술(감독이 슬라이더로 설정한 베이스 값 — 각 0..1):",
    `- 라인 ${mt.line} · 압박 ${mt.press} · 템포 ${mt.tempo} · 폭 ${mt.width}`,
    `이 값을 팀 전술의 베이스로 삼는다(${TACTICS_FIELD_MAP}). 감독의 자연어 지시는 이 베이스 위에 보정만 하라 — ` +
      "지시가 없는 축은 베이스 값을 유지하고, 지시가 있는 축만 조정한다.",
  ].join("\n");
}

/**
 * 라인업 컨디션 블록 — 선수별 컨디션(0..1) 표기 + 저조 시 무리 자제 지침.
 * @param conditions {playerId: 0..1}
 */
export function renderConditionsBlock(
  conditions: Record<string, number> | undefined,
  roster: readonly TeamInputRosterEntry[],
): string | null {
  if (!conditions || Object.keys(conditions).length === 0) return null;
  const rows = roster
    .filter((r) => conditions[r.playerId] !== undefined)
    .map((r) => {
      const v = conditions[r.playerId]!;
      return `- ${r.playerId} ${r.name}: ${v.toFixed(2)} (${conditionBand(v)})`;
    });
  if (rows.length === 0) return null;
  return [
    "라인업 컨디션(0=최저 … 1=최상, 시드 롤):",
    ...rows,
    "컨디션이 저조한 선수는 무리한 성향(과도한 forwardRunFreq·pressAggression 등)을 자제하고 보수적으로 잡는다.",
  ].join("\n");
}

/**
 * 관계(성격·신뢰도) 블록 — 고정 반응 규칙 + 선수별 성격/신뢰도 나열.
 * @param relations {playerId: {trust, personality}}
 */
export function renderRelationsBlock(
  relations: Record<string, PlayerRelationContext> | undefined,
  roster: readonly TeamInputRosterEntry[],
): string | null {
  if (!relations || Object.keys(relations).length === 0) return null;
  const rows = roster
    .filter((r) => relations[r.playerId] !== undefined)
    .map((r) => {
      const rel = relations[r.playerId]!;
      return `- ${r.playerId} ${r.name}: 성격 ${rel.personality} · 신뢰 ${rel.trust}`;
    });
  if (rows.length === 0) return null;
  return ["감독-선수 관계(성격·신뢰도 — 지시 반응성에 반영):", PERSONALITY_REACTION_RULES, "선수별:", ...rows].join(
    "\n",
  );
}

/**
 * 팀 사기 블록 — morale/streak 문맥.
 */
export function renderTeamMoraleBlock(tm: TeamMoraleContext | undefined): string | null {
  if (!tm) return null;
  const streakText = tm.streak > 0 ? `${tm.streak}연승` : tm.streak < 0 ? `${-tm.streak}연패` : "연속기록 없음";
  return [
    `팀 사기: ${tm.morale}/100 (${streakText}).`,
    "사기가 높으면 팀 전반을 적극적·과감하게, 낮으면(연패 흐름) 안정 지향으로 문맥을 반영한다.",
  ].join("\n");
}
