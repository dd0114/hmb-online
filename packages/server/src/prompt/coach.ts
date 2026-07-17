import { zodToJsonSchema } from "zod-to-json-schema";
import {
  TacticalInput,
  clampTacticalInput,
  TeamInputJobContext,
  type TeamInputRosterEntry,
} from "@hmb/shared";

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
  "감독 지시의 의도를 파라미터로 충실히 반영하라(예: '풀백 오버랩' → 해당 풀백 widthTendency·forwardRunFreq↑; '로우블록' → defensiveLineHeight↓·compactness↑·pressAggression↓).",
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
    `포메이션: ${ctx.formation} (${ctx.side} 팀, ${ctx.half === 1 ? "전반" : "후반"})`,
    `팀 로스터(선발 11명, 능력치 0..100):`,
    ...roster.map(rosterLine),
    "",
    `seed: ${ctx.seed}`,
  ];

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
  parts.push("", "제공된 JSON 스키마에 맞는 TacticalInput JSON 을 정확히 한 번 제출한다. 다른 설명·행동 금지.");
  return parts.join("\n");
}

/**
 * 검증 게이트(가드레일) — AI 산출 raw → zod 스키마 검증 + sanity(11명·로스터 playerId 정합) + clamp.
 * 어떤 executor(AI)가 만들었든 이 게이트를 통과해야 complete(ok:true) 가 된다. 순수 함수.
 */
export function validateTeamInputOutput(raw: unknown, ctx: TeamInputJobContext): TacticalInput {
  const parsed = TacticalInput.parse(raw); // zod 스키마 검증(형태·타입)
  if (parsed.players.length !== 11) {
    throw new Error(`선수는 11명이어야 함 (got ${parsed.players.length})`);
  }
  const rosterIds = new Set(ctx.roster.map((p) => p.playerId));
  for (const p of parsed.players) {
    if (!rosterIds.has(p.playerId)) {
      throw new Error(`로스터에 없는 playerId: ${p.playerId}`);
    }
  }
  const outIds = new Set(parsed.players.map((p) => p.playerId));
  if (outIds.size !== 11) {
    throw new Error(`playerId 중복 — 로스터 11명 전원이 정확히 1회씩 있어야 함`);
  }
  return clampTacticalInput(parsed); // 모든 수치를 유효 범위로 클램프
}
