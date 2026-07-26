import { zodToJsonSchema } from "zod-to-json-schema";
import {
  TacticalInput,
  TacticalPatch,
  applyPatch,
  clampTacticalInput,
  TeamInputJobContext,
  TeamInputPatchJobContext,
  type TeamInputRosterEntry,
} from "@hmb/shared";
import { synthesizeDirectivesSection, DIRECTIVES } from "./directives/index.js";
import {
  renderManualTacticsBlock,
  renderConditionsBlock,
  renderRelationsBlock,
  renderTeamMoraleBlock,
} from "./context-blocks.js";
import { assertTacticalSanity } from "./gates.js";

/**
 * coach — "자연어 지시(팀+선수별) → TacticalInput" 프롬프트 빌더 + 검증 게이트 (방식1 핵심).
 * W1 재편: 잡 컨텍스트 = shared `TeamInputJobContext`(Java MatchOrchestrator 가 생성, LLD-server-java §5.2).
 * 구 CoachContext(directive+rosterContext 문자열+prefix, 파일큐 시대)를 대체 —
 * 로스터 능력치·팀 지시·선수별 개인 지시·half2 전반요약(prevSummary)을 여기서 프롬프트로 푼다.
 * executor(AI 구현) 무관 공통: 프롬프트 소재 + JSON 스키마 + 검증 게이트.
 */

/** 코치 시스템 프롬프트(고정 — 프롬프트 캐시 프리픽스의 일부). */
export const COACH_SYSTEM = [
  "너는 축구 게임의 AI 감독이다. 감독의 자연어 지시를 시뮬레이션 엔진의 전술 파라미터(TacticalInput)로 번역한다.",
  "규칙:",
  "- players 는 주어진 로스터의 playerId 를 정확히 그대로 사용한다(11명 전원, 추가/누락 금지).",
  "- 모든 behavior 값과 team 수치는 0..1, mentalModifier 는 -1..1 범위.",
  "- basePosition 은 포메이션 슬롯을 기본으로 하되 지시에 맞게 조정 가능(x=0 자기 골문→1 상대 골문, y=0..1 좌우 폭).",
  "- 선수의 능력치(0..100)를 고려해 현실적인 성향을 부여한다(예: pace 낮은 수비수에게 과도한 forwardRunFreq 금지).",
  "behavior 의미: forwardRunFreq=오프더볼 전진 침투, widthTendency=측면으로 벌림(풀백/윙어 오버랩), supportDepth=공격 가담 깊이, pressAggression=개인 압박, passRisk=위험 전진패스, passDirectness=직선 패스, dribbleTendency, shootTendency, positioningFreedom=로밍.",
  "감독 지시의 의도를 파라미터로 충실히 반영하라 — 구체 해석은 아래 '지원 지시 카탈로그'를 따른다.",
].join("\n");

/**
 * 필수확인 서픽스(#193 W2b-B3) — 출력 직전에 붙는 짧은 체크. **A/B(풀 생성·델타 패치) 공용**.
 * 실측 근거: effort=low 로 사고 토큰을 줄이면 품질이 떨어지는데, 이 두 줄 서픽스가 4.25/5 로 회복시켰다
 * (파급 체크리스트형 긴 프롬프트는 분산이 커서 기각). 항목을 늘리면 그 실측 근거를 벗어난다 — 신중히.
 */
export const MANDATORY_CHECKS = [
  "제출 전 필수 확인:",
  "- 마킹/전담 마크 지시가 있으면 반드시 해당 수비수에게 markTarget(패치는 markTargets)을 상대 로스터의 실제 playerId 로 설정한다 — 비워 두지 마라.",
  "- GK(골키퍼)의 역할을 존중한다 — 골키퍼에게 전진 침투·공격 가담 성향을 부여하지 마라.",
].join("\n");

/**
 * TacticalInput → JSON Schema. claude CLI `--json-schema`(구조화 출력) 로 모델을 안내한다.
 * shared 계약(zod v3)에서 파생 = 단일 출처(드리프트 없음). 진짜 검증은 validateTeamInputOutput 게이트.
 */
export function tacticalJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(TacticalInput, { $refStrategy: "none" }) as Record<string, unknown>;
  delete raw["$schema"];
  return raw;
}

/** 로스터 1명 → 프롬프트 한 줄(슬롯·능력치 요약). */
function rosterLine(p: TeamInputRosterEntry): string {
  const a = p.attributes;
  return (
    `- slot${p.slotIndex} ${p.playerId} ${p.name} (${p.position}) — ` +
    `tech ${a.technical}/mental ${a.mental}/phys ${a.physical} · ` +
    `pass ${a.passing}·shoot ${a.shooting}·tackle ${a.tackling}·pace ${a.pace}·stam ${a.stamina}·pos ${a.positioning}`
  );
}

/**
 * team-input 프롬프트 조립. 안정 프리픽스(system + 포메이션/로스터) 먼저, 가변부(지시·개인 지시·
 * 전반요약·seed·feedback) 마지막 → 프롬프트 캐시 최적. executor 가 이 텍스트를 -p 프롬프트로 넘긴다.
 */
export function buildTeamInputPrompt(ctx: TeamInputJobContext, feedback?: string): string {
  const roster = [...ctx.roster].sort((a, b) => a.slotIndex - b.slotIndex);

  const parts = [
    COACH_SYSTEM,
    "",
    // 지시 카탈로그(고정 콘텐츠) — 안정 프리픽스에 두어 프롬프트 캐시 최적. 순수 합성(A/B 프롬프트 공용).
    // contextNeeds 는 고정 문구로 렌더 → 요청별 컨텍스트 유무는 아래 가변부 블록으로만 전달(단일 변형).
    synthesizeDirectivesSection(DIRECTIVES),
    "",
    `포메이션: ${ctx.formation} (${ctx.side} 팀, ${ctx.half === 1 ? "전반" : "후반"})`,
    `팀 로스터(선발 11명, 능력치 0..100):`,
    ...roster.map(rosterLine),
    "",
    `seed: ${ctx.seed}`,
  ];

  // ─── Phase 2 컨텍스트 블록(가변부, additive optional) — 순수 렌더러 재사용(W3 A+B 공용). 없으면 생략.
  // manualTactics = A-base(있으면 "베이스, 프롬프트로 보정만"). 로스터 다음에 두어 전술 베이스를 먼저 고정.
  const manualTacticsBlock = renderManualTacticsBlock(ctx.manualTactics);
  if (manualTacticsBlock) parts.push("", manualTacticsBlock);

  const conditionsBlock = renderConditionsBlock(ctx.conditions, roster);
  if (conditionsBlock) parts.push("", conditionsBlock);

  const teamMoraleBlock = renderTeamMoraleBlock(ctx.teamMorale);
  if (teamMoraleBlock) parts.push("", teamMoraleBlock);

  const relationsBlock = renderRelationsBlock(ctx.relations, roster);
  if (relationsBlock) parts.push("", relationsBlock);

  // 상대 로스터(마킹 등 opponentRoster 의존 지시의 이름→playerId 해석 근거). additive optional.
  // OpponentRosterEntry = 3필드(playerId/name/position, slotIndex 없음) — 제공 순서 유지.
  if (ctx.opponentRoster && ctx.opponentRoster.length > 0) {
    parts.push(
      "",
      "상대 로스터(마킹 대상 해석용 — 이름을 playerId 로 매핑):",
      ...ctx.opponentRoster.map((p) => `- ${p.playerId} ${p.name} (${p.position})`),
    );
  }

  const team = ctx.teamPrompt.trim();
  parts.push(`감독 지시(팀 전체):\n${team.length > 0 ? team : "(별도 지시 없음 — 포메이션 기본 성향으로)"}`);

  const pp = Object.entries(ctx.playerPrompts).filter(([, v]) => v.trim());
  if (pp.length > 0) {
    parts.push(
      "",
      "선수별 개인 지시(해당 선수의 behavior 에 우선 반영 — 팀 지시보다 구체적):",
      ...pp.map(([pid, prompt]) => `- ${pid}: ${prompt.trim()}`),
    );
  }

  if (ctx.half === 2 && ctx.prevSummary) {
    const s = ctx.prevSummary;
    parts.push(
      "",
      "전반 결과 요약(후반 전술에 반영):",
      `- 스코어 home ${s.scoreHome} : ${s.scoreAway} away · 슛 ${s.shots} · 흐름: ${String(s.possessionHint)}`,
    );
  }

  if (feedback) {
    parts.push("", `[이전 산출 거부됨] 사유: ${feedback} — 이 문제를 고쳐서 다시 제출.`);
  }
  // 필수확인 서픽스(#193) — effort=low 의 품질 손실 회복(실측 A1 승자). 출력 지시 바로 앞.
  parts.push("", MANDATORY_CHECKS);
  parts.push("", "제공된 JSON 스키마에 맞는 TacticalInput JSON 을 정확히 한 번 제출한다. 다른 설명·행동 금지.");
  return parts.join("\n");
}

/**
 * 로스터 정합 가드(순수) — 산출 TacticalInput 이 정확히 로스터 11명(중복·유령 id 없음)을 담는지 검사.
 * team-input(전량 생성)·team-input-patch(머지 산출) 두 경로가 공유(단일 규칙).
 */
export function assertRosterConsistency(input: TacticalInput, roster: readonly TeamInputRosterEntry[]): void {
  if (input.players.length !== 11) {
    throw new Error(`선수는 11명이어야 함 (got ${input.players.length})`);
  }
  const rosterIds = new Set(roster.map((p) => p.playerId));
  for (const p of input.players) {
    if (!rosterIds.has(p.playerId)) {
      throw new Error(`로스터에 없는 playerId: ${p.playerId}`);
    }
  }
  const outIds = new Set(input.players.map((p) => p.playerId));
  if (outIds.size !== 11) {
    throw new Error(`playerId 중복 — 로스터 11명 전원이 정확히 1회씩 있어야 함`);
  }
}

/**
 * 검증 게이트(가드레일) — AI 산출 raw → zod 스키마 검증 + sanity(11명·로스터 playerId 정합) + clamp.
 * 어떤 executor(AI)가 만들었든 이 게이트를 통과해야 complete(ok:true) 가 된다. 순수 함수.
 */
export function validateTeamInputOutput(raw: unknown, ctx: TeamInputJobContext): TacticalInput {
  const parsed = TacticalInput.parse(raw); // zod 스키마 검증(형태·타입)
  assertRosterConsistency(parsed, ctx.roster);
  const clamped = clampTacticalInput(parsed); // 모든 수치를 유효 범위로 클램프
  assertTacticalSanity(clamped, ctx); // #193 게이트(자기모순·지시 미이행·배치 파손)
  return clamped;
}

// ─────────────────────── B(패치 생성) — team-input-patch 경로 (A+B 린패치, #82/W3) ───────────────────────

/**
 * TacticalPatch → JSON Schema(claude `--json-schema`). shared 계약(zod)에서 파생 — 단일 출처.
 * 출력은 **패치**(벌크 연산)라 TacticalInput 전량보다 훨씬 얕다 → 출력 토큰 억제(목표 ~1–2k).
 */
export function tacticalPatchJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(TacticalPatch, { $refStrategy: "none" }) as Record<string, unknown>;
  delete raw["$schema"];
  return raw;
}

/**
 * 필드 글로서리(#82 실측: 글로서리 → 15.5s·정확). 자연어 지시어 → TacticalInput/TacticalPatch 필드 직결 매핑.
 * B 프롬프트에 두어 모델이 A 를 재대조(기계적 추론 낭비)하지 않고 **지시된 축의 절대값만** 내게 한다.
 */
export const PATCH_FIELD_GLOSSARY = [
  "필드 글로서리(자연어 → 패치 필드 — 이 매핑을 직접 쓰고 추론을 최소화하라):",
  "- 라인 올려/내려 → team.defensiveLineHeight, 압박/프레스 강도 → team.pressIntensity, 압박 시작 위치 → team.pressTriggerLine",
  "- 템포/빠르게·느리게 → team.tempo, 폭 넓게·좁게 → team.width, 콤팩트 → team.compactness, 오프사이드 트랩 → team.offsideTrap",
  "- 침투/전진 런 → forwardRunFreq, 오버랩/측면 → widthTendency, 공격 가담 → supportDepth, 로밍/자유 → positioningFreedom",
  "- 개인 압박 → pressAggression, 과감한 슛 → shootTendency, 드리블 → dribbleTendency, 위험한 전진패스 → passRisk, 직선 패스 → passDirectness",
  "- 격려·신뢰·질책 등 사기/톤 → 해당 선수/그룹 mentalModifier(-1..1)",
].join("\n");

/** B 프롬프트 시스템(고정 — 패치만·절대값·추론최소). */
export const PATCH_SYSTEM = [
  "너는 축구 게임의 AI 감독이다. 이미 계산된 팀 전술 베이스(A) 위에, 감독의 이번 지시(전술 조정 + 사기/관계 톤)를",
  "**변경분(TacticalPatch)** 으로만 표현한다. 규칙:",
  "- 지시가 건드린 축만 출력한다. 바뀌지 않는 값은 절대 다시 쓰지 마라(A 를 재기술 금지 — 머지가 정적으로 얹는다).",
  "- 값은 **절대값**(0..1, mentalModifier 는 -1..1) — '조금 더' 같은 상대 표현도 최종 절대값으로 환산해 낸다.",
  "- 벌크로 표현하라: 팀 전체=team, 포지션 그룹(GK/DF/MF/FW) 공통=byPosition, 특정 선수만=byPlayer, 전담 마크=markTargets(수비수 playerId→상대 targetId).",
  "  예) '전원 강하게 압박' → team.pressIntensity + byPosition 로 몇 줄. 11명을 개별 나열하지 마라.",
  "- 관계·성격·사기 톤은 mentalModifier 로 반영한다(성격 규칙은 아래). 근거 설명·사고과정 출력 금지 — 패치 JSON 하나만.",
].join("\n");

/**
 * 델타 모드 용어집 = 글로서리 + supportDepth 정의 명확화.
 * 실측에서 **반복 오독된 축**이 supportDepth 였다("수비 가담 최소화" 지시에 supportDepth 를 내리는 오해) —
 * 정의를 한 줄로 못 박는다. 비델타(기존) 프롬프트는 무변경(후방 호환).
 */
export const SUPPORT_DEPTH_CLARIFICATION =
  "- ⚠️ supportDepth = **공격 시 전진 가담 깊이**(수비 가담 아님). 값↑ = 공격 때 더 높이 올라가 가담." +
  " '수비 가담을 줄이고 앞에 남아라' 는 supportDepth 를 **올리는** 쪽, '내려와서 수비를 도와라' 가 낮추는 쪽이다.";

/** 델타 모드에서 쓰는 용어집(글로서리 + supportDepth 명확화). */
export const PATCH_FIELD_GLOSSARY_DELTA = [PATCH_FIELD_GLOSSARY, SUPPORT_DEPTH_CLARIFICATION].join("\n");

/** 로스터 1명 → B 프롬프트 한 줄(id·role·그룹만 — 능력치 재나열 없이 키 해석 근거). */
function patchRosterLine(p: TeamInputRosterEntry): string {
  return `- slot${p.slotIndex} ${p.playerId} ${p.name} (${p.position})`;
}

/**
 * team-input-patch 프롬프트 조립(B). 안정 프리픽스(system + 글로서리 + 카탈로그) 먼저,
 * 가변부(A 베이스 요약·로스터·관계/사기/컨디션·감독 지시·전반요약) 나중 → 프롬프트 캐시 최적.
 *
 * A(base)는 **팀 스칼라 요약**만 참조로 싣는다(선수 11명 성향 전량 덤프 금지 — #82: A 전량 노출 시 diff 추론 낭비).
 * 컨텍스트 블록 렌더러(manualTactics/relations/conditions/teamMorale)는 team-input 과 **동일 재사용**.
 */
export function buildTeamInputPatchPrompt(ctx: TeamInputPatchJobContext, feedback?: string): string {
  // #193: 변경분이 실려 오면 **델타 모드**(풀 컨텍스트 나열 없이 변경분만) — 사고 토큰 = 지연의 지배 변수.
  if (hasPromptDelta(ctx)) return buildDeltaPatchPrompt(ctx, feedback);

  const roster = [...ctx.roster].sort((a, b) => a.slotIndex - b.slotIndex);
  const t = ctx.base.team;

  const parts = [
    PATCH_SYSTEM,
    "",
    PATCH_FIELD_GLOSSARY,
    "",
    // 카탈로그(고정 콘텐츠) — 안정 프리픽스. A/B 공용 순수 합성.
    synthesizeDirectivesSection(DIRECTIVES),
    "",
    `포메이션: ${ctx.base.team.formation} (${ctx.side} 팀, ${ctx.half === 1 ? "전반" : "후반"})`,
    // A 베이스 = 팀 스칼라 값만(참고). 이 위에 지시된 축만 덮어쓴다.
    "현재 팀 전술 베이스(A — 지시가 없는 축은 이 값 유지, 패치에 다시 쓰지 말 것):",
    `- defensiveLineHeight ${t.defensiveLineHeight} · compactness ${t.compactness} · tempo ${t.tempo} · width ${t.width}` +
      ` · pressIntensity ${t.pressingScheme.intensity} · pressTriggerLine ${t.pressingScheme.triggerLine} · offsideTrap ${t.offsideTrap}`,
    "선수 성향 베이스는 이미 A 에 계산돼 있다(여기 재나열 안 함) — 지시가 닿는 선수/그룹만 패치하라.",
    "",
    "로스터(선발 11명 — byPlayer/markTargets 키 해석용, id·포지션):",
    ...roster.map(patchRosterLine),
  ];

  // ─── 컨텍스트 블록(가변부) — team-input 과 동일 순수 렌더러 재사용. 없으면 생략. ───
  const manualTacticsBlock = renderManualTacticsBlock(ctx.manualTactics);
  if (manualTacticsBlock) parts.push("", manualTacticsBlock);

  const conditionsBlock = renderConditionsBlock(ctx.conditions, roster);
  if (conditionsBlock) parts.push("", conditionsBlock);

  const teamMoraleBlock = renderTeamMoraleBlock(ctx.teamMorale);
  if (teamMoraleBlock) parts.push("", teamMoraleBlock);

  const relationsBlock = renderRelationsBlock(ctx.relations, roster);
  if (relationsBlock) parts.push("", relationsBlock);

  if (ctx.opponentRoster && ctx.opponentRoster.length > 0) {
    parts.push(
      "",
      "상대 로스터(마킹 대상 해석용 — 이름을 playerId 로 매핑):",
      ...ctx.opponentRoster.map((p) => `- ${p.playerId} ${p.name} (${p.position})`),
    );
  }

  const team = ctx.teamPrompt.trim();
  parts.push(
    "",
    `감독의 이번 지시(팀 전체):\n${team.length > 0 ? team : "(전술 지시 없음 — 사기/톤 위주면 mentalModifier 만, 없으면 빈 패치 {} 로)"}`,
  );

  const pp = Object.entries(ctx.playerPrompts).filter(([, v]) => v.trim());
  if (pp.length > 0) {
    parts.push(
      "",
      "선수별 개인 지시(해당 선수 byPlayer 로 반영 — 팀 지시보다 구체적):",
      ...pp.map(([pid, prompt]) => `- ${pid}: ${prompt.trim()}`),
    );
  }

  if (ctx.half === 2 && ctx.prevSummary) {
    const s = ctx.prevSummary;
    parts.push(
      "",
      "전반 결과 요약(후반 조정에 반영):",
      `- 스코어 home ${s.scoreHome} : ${s.scoreAway} away · 슛 ${s.shots} · 흐름: ${String(s.possessionHint)}`,
    );
  }

  if (feedback) {
    parts.push("", `[이전 산출 거부됨] 사유: ${feedback} — 이 문제를 고쳐서 패치를 다시 제출.`);
  }
  parts.push("", "제공된 JSON 스키마에 맞는 TacticalPatch JSON 을 정확히 한 번 제출한다. 패치만 — 다른 설명·사고과정 금지.");
  return parts.join("\n");
}

// ─────────────────────── 델타 모드 (#193 W2b-B3) — "무엇이 바뀌었나"만 제시 ───────────────────────

/** 실제 변경 항목이 하나라도 있는가(빈 promptDelta 는 기존 경로로 폴백 — 후방 호환). */
export function hasPromptDelta(ctx: TeamInputPatchJobContext): boolean {
  const d = ctx.promptDelta;
  if (!d) return false;
  return d.team !== undefined || Object.keys(d.players ?? {}).length > 0;
}

/** 선수 지시 변경 1건 → 프롬프트 한 줄(신규/삭제/수정 3형태). */
function playerDeltaLine(
  playerId: string,
  entry: { old?: string; new?: string },
  label: (id: string) => string,
): string {
  const who = label(playerId);
  if (entry.new === undefined) return `- ${who} [삭제됨] (이전: ${entry.old ?? ""})`;
  if (entry.old === undefined) return `- ${who} [신규] ${entry.new}`;
  return `- ${who} [이전] ${entry.old} → [이후] ${entry.new}`;
}

/**
 * 델타 패치 프롬프트(#193 W2b-B3) — 실측 채택안(단순 델타, 8~16s).
 * 구성 = PATCH_SYSTEM + 용어집(supportDepth 명확화) + 로스터 요약 + 베이스 팀 스칼라 요약 +
 *        "다음 지시가 변경되었다: old → new"(변경된 항목만) + "이 변경이 유발하는 변화만" + 필수확인 서픽스.
 * 카탈로그·능력치·관계/사기 블록은 **싣지 않는다**(사고 토큰 억제가 목적 — 지연의 지배 변수).
 * 예외로 상대 로스터는 마킹 변경이 있을 때만 싣는다(markTargets 대상 해석 근거, 게이트 G2 가 요구).
 */
export function buildDeltaPatchPrompt(ctx: TeamInputPatchJobContext, feedback?: string): string {
  const roster = [...ctx.roster].sort((a, b) => a.slotIndex - b.slotIndex);
  const t = ctx.base.team;
  const d = ctx.promptDelta ?? {};
  const byId = new Map(roster.map((p) => [p.playerId, p]));
  const label = (id: string): string => {
    const p = byId.get(id);
    return p ? `${p.playerId} (${p.position})` : id;
  };

  const parts = [
    PATCH_SYSTEM,
    "",
    PATCH_FIELD_GLOSSARY_DELTA,
    "",
    `포메이션: ${t.formation} (${ctx.side} 팀, ${ctx.half === 1 ? "전반" : "후반"})`,
    "현재 팀 전술 베이스(A — 변경과 무관한 축은 이 값 유지, 패치에 다시 쓰지 말 것):",
    `- defensiveLineHeight ${t.defensiveLineHeight} · compactness ${t.compactness} · tempo ${t.tempo} · width ${t.width}` +
      ` · pressIntensity ${t.pressingScheme.intensity} · pressTriggerLine ${t.pressingScheme.triggerLine} · offsideTrap ${t.offsideTrap}`,
    "선수 성향 베이스는 이미 A 에 계산돼 있다(여기 재나열 안 함) — 변경이 닿는 선수/그룹만 패치하라.",
    "",
    "로스터(선발 11명 — byPlayer/markTargets 키 해석용, id·포지션):",
    ...roster.map(patchRosterLine),
  ];

  // 마킹 변경이 있을 때만 상대 로스터(대상 id 해석 근거). 그 외에는 토큰을 쓰지 않는다.
  const deltaText = [
    d.team?.new ?? "",
    ...Object.values(d.players ?? {}).map((e) => e.new ?? ""),
  ].join("\n");
  if (/막아|마크|전담|mark/i.test(deltaText) && ctx.opponentRoster && ctx.opponentRoster.length > 0) {
    parts.push(
      "",
      "상대 로스터(마킹 대상 해석용 — 이름을 playerId 로 매핑):",
      ...ctx.opponentRoster.map((p) => `- ${p.playerId} ${p.name} (${p.position})`),
    );
  }

  parts.push("", "다음 지시가 변경되었다(변경된 항목만 나열):");
  if (d.team) {
    // 이전 지시가 없던 경우(신규 부여)엔 빈 "[이전 팀 지시] " 줄을 흘리지 않는다 — 모델에게
    // "빈 지시가 있었다"로 읽히는 잡음이다(#193 검증 m-3).
    parts.push(
      ...(d.team.old.trim() === ""
        ? [`[신규 팀 지시] ${d.team.new}`]
        : [`[이전 팀 지시] ${d.team.old}`, `[이후 팀 지시] ${d.team.new}`]),
    );
  }
  const playerEntries = Object.entries(d.players ?? {});
  if (playerEntries.length > 0) {
    parts.push(
      "",
      "선수 개인 지시 변경:",
      ...playerEntries.map(([pid, entry]) => playerDeltaLine(pid, entry, label)),
    );
  }

  parts.push(
    "",
    "**이 변경이 유발하는 변화만** TacticalPatch 로 출력하라. 변경과 무관한 축·선수는 절대 포함하지 마라.",
    "단 변경이 다른 선수에 파급되면(마킹·커버·트랩 등) 그 파급분은 포함하라.",
  );

  if (ctx.half === 2 && ctx.prevSummary) {
    const s = ctx.prevSummary;
    parts.push(
      "",
      "전반 결과 요약(후반 조정에 반영):",
      `- 스코어 home ${s.scoreHome} : ${s.scoreAway} away · 슛 ${s.shots} · 흐름: ${String(s.possessionHint)}`,
    );
  }

  if (feedback) {
    parts.push("", `[이전 산출 거부됨] 사유: ${feedback} — 이 문제를 고쳐서 패치를 다시 제출.`);
  }

  parts.push("", MANDATORY_CHECKS);
  parts.push("", "제공된 JSON 스키마에 맞는 TacticalPatch JSON 을 정확히 한 번 제출한다. 패치만 — 다른 설명·사고과정 금지.");
  return parts.join("\n");
}

/**
 * B 검증 게이트 — raw(TacticalPatch) → applyPatch(A, patch, {seed}) → 최종 TacticalInput 로스터 정합 검사.
 * **complete 는 최종 TacticalInput 을 반환**(Java 는 team-input 과 동일하게 소비 — 패치는 실행기 내부 세부).
 */
export function validateTeamInputPatchOutput(raw: unknown, ctx: TeamInputPatchJobContext): TacticalInput {
  const patch = TacticalPatch.parse(raw); // 패치 형태 검증(strict — 헛필드 거부)
  const merged = applyPatch(ctx.base, patch, { seed: ctx.seed }); // 정적 머지(내부 zod+clamp) + halfSeed 주입
  assertRosterConsistency(merged, ctx.roster); // 최종 산출이 로스터 11명 정합

  // 유령 마크 타깃 제거 — opponentRoster 가 있으면 그 안에 없는 markTarget 을 떨군다(team-input 과 동일 수위:
  // 없는 상대 id 를 지어내지 않는다). opponentRoster 미제공이면 검증 생략(통과).
  let cleaned = merged;
  if (ctx.opponentRoster && ctx.opponentRoster.length > 0) {
    const validTargets = new Set(ctx.opponentRoster.map((o) => o.playerId));
    cleaned = {
      ...merged,
      players: merged.players.map((p) =>
        p.markTarget !== undefined && !validTargets.has(p.markTarget) ? { ...p, markTarget: undefined } : p,
      ),
    };
  }

  // #193 게이트 — 유령 제거 **후** 최종본 기준(유령이 지시 이행으로 오인되지 않도록).
  assertTacticalSanity(cleaned, ctx);
  return cleaned;
}
