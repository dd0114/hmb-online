import { makeTacticalInput } from "@hmb/engine";
import {
  TeamInputJobContext,
  TeamInputPatchJobContext,
  type TacticalInput,
  type TacticalPatch,
  type PlayerBehaviorPatch,
} from "@hmb/shared";
import type { AiExecutor } from "../executor.js";
import type { ExecutorJob } from "../kinds.js";

/**
 * 결정론 스텁 executor — 키/네트워크/로그인 0 (테스트·오프라인·CI·폴백). AC-T2 의 오프라인 축.
 * 실제 AI 대체가 아니라 폴링→검증→complete 배선 검증용.
 * kind 라우팅: 'team-input' = 전량 생성(시드 결정론 베이스 + 키워드 성향), 'team-input-patch' = 패치 생성(키워드 결정론).
 */
export function stubExecutor(): AiExecutor {
  return {
    name: "stub",
    execute(job: ExecutorJob): Promise<unknown> {
      if (job.kind === "team-input") return Promise.resolve(stubTeamInput(TeamInputJobContext.parse(job.context)));
      if (job.kind === "team-input-patch") return Promise.resolve(stubPatch(TeamInputPatchJobContext.parse(job.context)));
      throw new Error(`stub: 미지원 kind ${String(job.kind)}`);
    },
  };
}

const clampM = (v: number): number => Math.max(-1, Math.min(1, v));

/** 'team-input' — 시드 결정론 베이스(4-3-3) + teamPrompt/개인지시/마킹/관계 키워드 반영(기존 W1 의미론). */
function stubTeamInput(ctx: TeamInputJobContext): TacticalInput {
  const t = makeTacticalInput("S", ctx.seed);
  const roster = [...ctx.roster].sort((a, b) => a.slotIndex - b.slotIndex);
  t.players.forEach((p, i) => {
    p.playerId = roster[i]!.playerId;
  });
  t.team.formation = ctx.formation;

  const d = ctx.teamPrompt;
  if (/공격|오버랩|하이라인|와이드|빠른 템포|attack|wide|overlap/i.test(d)) {
    t.team.defensiveLineHeight = 0.85;
    t.team.width = 0.85;
    t.team.pressingScheme.intensity = 0.8;
    for (const p of t.players) {
      if (p.role === "LB" || p.role === "RB") {
        p.behavior.widthTendency = 0.9;
        p.behavior.forwardRunFreq = 0.85;
      }
    }
  }
  if (/수비|로우|콤팩트|back four|low|defensive|compact/i.test(d)) {
    t.team.defensiveLineHeight = 0.2;
    t.team.compactness = 0.85;
    t.team.width = 0.35;
    t.team.pressingScheme.intensity = 0.2;
    for (const p of t.players) {
      if (p.role === "LB" || p.role === "RB") {
        p.behavior.widthTendency = 0.15;
        p.behavior.forwardRunFreq = 0.05;
      }
    }
  }
  for (const p of t.players) {
    const pp = ctx.playerPrompts[p.playerId];
    if (pp && /침투|런|run|forward/i.test(pp)) p.behavior.forwardRunFreq = 0.9;
  }

  // 마킹(AC-C2)
  const opp = ctx.opponentRoster ?? [];
  if (opp.length > 0) {
    const isMark = (s: string): boolean => /막아|막아라|마크|전담|mark/i.test(s);
    const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mentionsId = (s: string, id: string): boolean => new RegExp(`\\b${escapeRe(id)}\\b`).test(s);
    const findTarget = (s: string): string | undefined =>
      opp.find((o) => mentionsId(s, o.playerId) || s.includes(o.name))?.playerId;

    for (const p of t.players) {
      const pp = ctx.playerPrompts[p.playerId];
      if (pp && isMark(pp)) {
        const target = findTarget(pp);
        if (target) p.markTarget = target;
      }
    }
    if (isMark(ctx.teamPrompt)) {
      const mentioned = opp.filter((o) => ctx.teamPrompt.includes(o.name) || mentionsId(ctx.teamPrompt, o.playerId));
      const defenders = t.players.filter((p) => /(LB|CB|RB|DM|CDM)/i.test(p.role) && !p.markTarget);
      mentioned.forEach((o, i) => {
        const d = defenders[i];
        if (d) d.markTarget = o.playerId;
      });
    }
  }

  // 관계·사기 방향성(AC-C4)
  const rel = ctx.relations ?? {};
  const scold = (s: string): boolean => /질책|혼|정신차려|압박해|blame|scold|criticiz/i.test(s);
  const strongAttack = (s: string): boolean => /공격|과감|밀어붙|강하게|attack|aggress|push/i.test(s);
  for (const p of t.players) {
    const r = rel[p.playerId];
    if (!r) continue;
    const tone = `${ctx.teamPrompt} ${ctx.playerPrompts[p.playerId] ?? ""}`;
    if (r.personality === "GLASS" && scold(tone)) {
      p.mentalModifier = clampM(p.mentalModifier - 0.4);
    } else if (r.personality === "FIERY" && strongAttack(tone)) {
      p.mentalModifier = clampM(p.mentalModifier + 0.4);
    } else if (r.personality === "AMBITIOUS" && strongAttack(tone)) {
      p.mentalModifier = clampM(p.mentalModifier + 0.3);
      p.behavior.shootTendency = clampM(p.behavior.shootTendency + 0.2);
    }
    if (r.trust < 40) p.mentalModifier = p.mentalModifier * 0.5;
  }
  if (ctx.teamMorale && ctx.teamMorale.streak < 0) {
    for (const p of t.players) p.mentalModifier = clampM(p.mentalModifier - 0.1);
  }
  return t;
}

/**
 * 'team-input-patch' — 벌크 패치를 키워드 결정론으로 산출(라이브 claude 는 프롬프트로 해석).
 * 게이트가 applyPatch(base) 로 최종 TacticalInput 을 만든다 → 스텁은 **패치만** 낸다(팀/그룹/개별/마킹 브랜치 재현).
 */
function stubPatch(ctx: TeamInputPatchJobContext): TacticalPatch {
  const patch: TacticalPatch = {};
  // #193 델타 모드: 변경분이 있으면 **변경 후(new) 지시**만 본다(옛 지시 무시, 삭제된 지시는 미반영).
  // 라이브 claude 는 델타 프롬프트로 같은 의미를 해석 — 스텁은 오프라인 E2E 배선용 결정론 흉내.
  const delta = ctx.promptDelta;
  const isDelta = delta !== undefined && (delta.team !== undefined || Object.keys(delta.players ?? {}).length > 0);
  const d = isDelta ? (delta?.team?.new ?? "") : ctx.teamPrompt;
  const playerPrompts: Record<string, string> = isDelta
    ? Object.fromEntries(
        Object.entries(delta?.players ?? {})
          .filter(([, e]) => e.new !== undefined && e.new.trim() !== "")
          .map(([pid, e]) => [pid, e.new as string]),
      )
    : ctx.playerPrompts;

  if (/공격|오버랩|하이라인|와이드|빠른 템포|attack|wide|overlap/i.test(d)) {
    patch.team = { defensiveLineHeight: 0.85, width: 0.85, pressIntensity: 0.8 };
    patch.byPosition = { DF: { behavior: { widthTendency: 0.9, forwardRunFreq: 0.85 } } };
  }
  if (/수비|로우|콤팩트|back four|low|defensive|compact/i.test(d)) {
    // 라인을 내리면 오프사이드 트랩은 끈다 — 게이트 G1(자기모순) 위반 회피(베이스가 트랩 ON 일 수 있음).
    patch.team = { defensiveLineHeight: 0.2, compactness: 0.85, width: 0.35, pressIntensity: 0.2, offsideTrap: false };
    patch.byPosition = { DF: { behavior: { widthTendency: 0.15, forwardRunFreq: 0.05 } } };
  }
  if (/전원|모두|다같이|전방부터|all|everyone/i.test(d) && /압박|프레스|press/i.test(d)) {
    patch.byPosition = {
      ...patch.byPosition,
      DF: { ...(patch.byPosition?.DF ?? {}), behavior: { ...(patch.byPosition?.DF?.behavior ?? {}), pressAggression: 0.9 } },
      MF: { behavior: { pressAggression: 0.9 } },
      FW: { behavior: { pressAggression: 0.9 } },
    };
  }

  // 선수별 개인 지시 → byPlayer
  const byPlayer: Record<string, { behavior?: PlayerBehaviorPatch; mentalModifier?: number }> = {};
  for (const [pid, prompt] of Object.entries(playerPrompts)) {
    if (!prompt.trim()) continue;
    if (/침투|런|run|forward/i.test(prompt)) {
      byPlayer[pid] = { ...byPlayer[pid], behavior: { ...byPlayer[pid]?.behavior, forwardRunFreq: 0.9 } };
    }
  }

  // 마킹 → markTargets(수비수 playerId → 상대 targetId). ctx.base.players 로 수비수를 찾는다.
  const opp = ctx.opponentRoster ?? [];
  if (opp.length > 0) {
    const isMark = (s: string): boolean => /막아|막아라|마크|전담|mark/i.test(s);
    const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mentionsId = (s: string, id: string): boolean => new RegExp(`\\b${escapeRe(id)}\\b`).test(s);
    const findTarget = (s: string): string | undefined =>
      opp.find((o) => mentionsId(s, o.playerId) || s.includes(o.name))?.playerId;
    const markTargets: Record<string, string> = {};

    // 개인 지시로 특정 우리 선수에게 마킹.
    for (const [pid, prompt] of Object.entries(playerPrompts)) {
      if (prompt.trim() && isMark(prompt)) {
        const target = findTarget(prompt);
        if (target) markTargets[pid] = target;
      }
    }
    // 팀 마킹 → 지목 상대들을 수비 자원에 1:1 분배(base.players 의 role 로 수비수 선별).
    if (isMark(d)) {
      const mentioned = opp.filter((o) => d.includes(o.name) || mentionsId(d, o.playerId));
      const defenders = ctx.base.players.filter((p) => /(LB|CB|RB|DM|CDM)/i.test(p.role) && !markTargets[p.playerId]);
      mentioned.forEach((o, i) => {
        const dfd = defenders[i];
        if (dfd) markTargets[dfd.playerId] = o.playerId;
      });
    }
    if (Object.keys(markTargets).length > 0) patch.markTargets = markTargets;
  }

  // 관계·사기 톤 → byPlayer.mentalModifier(방향성 흉내).
  const rel = ctx.relations ?? {};
  const scold = (s: string): boolean => /질책|혼|정신차려|압박해|blame|scold|criticiz/i.test(s);
  const strongAttack = (s: string): boolean => /공격|과감|밀어붙|강하게|attack|aggress|push/i.test(s);
  for (const p of ctx.base.players) {
    const r = rel[p.playerId];
    if (!r) continue;
    const tone = `${d} ${playerPrompts[p.playerId] ?? ""}`;
    let mm: number | undefined;
    if (r.personality === "GLASS" && scold(tone)) mm = -0.4;
    else if (r.personality === "FIERY" && strongAttack(tone)) mm = 0.4;
    else if (r.personality === "AMBITIOUS" && strongAttack(tone)) mm = 0.3;
    if (mm !== undefined) {
      if (r.trust < 40) mm = mm * 0.5;
      byPlayer[p.playerId] = { ...byPlayer[p.playerId], mentalModifier: clampM(mm) };
    }
  }

  if (Object.keys(byPlayer).length > 0) patch.byPlayer = byPlayer;
  return patch;
}
