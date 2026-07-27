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
    execute(job: ExecutorJob, attempt?: { feedback: string }): Promise<unknown> {
      const feedback = attempt?.feedback ?? "";
      if (job.kind === "team-input")
        return Promise.resolve(stubTeamInput(TeamInputJobContext.parse(job.context), feedback));
      if (job.kind === "team-input-patch")
        return Promise.resolve(stubPatch(TeamInputPatchJobContext.parse(job.context), feedback));
      throw new Error(`stub: 미지원 kind ${String(job.kind)}`);
    },
  };
}

const clampM = (v: number): number => Math.max(-1, Math.min(1, v));
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * 게이트 피드백(재시도 사유) 해석 — 라이브 claude 는 자연어로 읽고 고치지만, 스텁은 게이트 메시지의
 * 키워드로 <b>결정론</b> 흉내를 낸다(#193 검증 M-2). 피드백을 무시하면 2회차도 같은 산출이라
 * ExecutorLoop 의 1회 재시도가 구조적으로 무의미해진다(오프라인 E2E 가 재시도 경로를 못 태운다).
 *
 * 인덱스 기반만 사용 — Math.random/Date 금지(결정론, 루트 §2-5).
 */
interface GateFix {
  markTarget: boolean;
  offsideTrap: boolean;
  spread: boolean;
}

function readFeedback(feedback: string): GateFix {
  return {
    markTarget: /markTarget/i.test(feedback),
    offsideTrap: /오프사이드트랩|offsideTrap|오프사이드/i.test(feedback),
    spread: /겹침|겹|배치 파손/.test(feedback),
  };
}

/** 마킹 대상 폴백 — 지시가 지목한 상대(게이트와 같은 판정), 없으면 로스터 첫 상대. */
function fallbackMarkTarget(
  texts: readonly string[],
  opponentRoster: readonly { playerId: string; name: string }[],
): string | undefined {
  const designated = opponentRoster.find((o) =>
    texts.some((t) => t.includes(o.name) || new RegExp(`\\b${o.playerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)),
  );
  return (designated ?? opponentRoster[0])?.playerId;
}

/** 수비 자원 판별 — role 또는 position 문자열(두 계약 모두 커버). */
const isDefenderRole = (role: string): boolean => /(LB|CB|RB|DM|CDM|DF)/i.test(role);

/** 밀집 해소용 결정론 오프셋 — 인덱스마다 다른 y 를 준다(같은 입력 → 같은 값). */
const spreadY = (y: number, index: number): number => Number(clamp01(y + (index % 11) * 0.02 + 0.01).toFixed(3));

/** 'team-input' — 시드 결정론 베이스(4-3-3) + teamPrompt/개인지시/마킹/관계 키워드 반영(기존 W1 의미론). */
function stubTeamInput(ctx: TeamInputJobContext, feedback = ""): TacticalInput {
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

  // ── 재시도: 게이트가 지적한 것만 고친다(#193 검증 M-2).
  const fix = readFeedback(feedback);
  if (fix.offsideTrap) t.team.offsideTrap = false;
  if (fix.markTarget && opp.length > 0 && !t.players.some((p) => p.markTarget)) {
    const target = fallbackMarkTarget([ctx.teamPrompt, ...Object.values(ctx.playerPrompts)], opp);
    const defender = t.players.find((p) => isDefenderRole(p.role)) ?? t.players[1];
    if (target && defender) defender.markTarget = target;
  }
  if (fix.spread) {
    t.players.forEach((p, i) => {
      p.basePosition.y = spreadY(p.basePosition.y, i);
    });
  }
  return t;
}

/**
 * 'team-input-patch' — 벌크 패치를 키워드 결정론으로 산출(라이브 claude 는 프롬프트로 해석).
 * 게이트가 applyPatch(base) 로 최종 TacticalInput 을 만든다 → 스텁은 **패치만** 낸다(팀/그룹/개별/마킹 브랜치 재현).
 */
function stubPatch(ctx: TeamInputPatchJobContext, feedback = ""): TacticalPatch {
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

  // ── 재시도: 게이트가 지적한 것만 고친다(#193 검증 M-2). 패치는 "변경분만" 계약이라 최소 필드만 얹는다.
  const fix = readFeedback(feedback);
  if (fix.offsideTrap) patch.team = { ...patch.team, offsideTrap: false };
  if (fix.markTarget && opp.length > 0 && Object.keys(patch.markTargets ?? {}).length === 0) {
    const target = fallbackMarkTarget([d, ...Object.values(playerPrompts)], opp);
    const defender = ctx.base.players.find((p) => isDefenderRole(p.role)) ?? ctx.base.players[1];
    if (target && defender) patch.markTargets = { [defender.playerId]: target };
  }
  if (fix.spread) {
    const spread: Record<string, { basePosition: { y: number } }> = {};
    ctx.base.players.forEach((p, i) => {
      spread[p.playerId] = { basePosition: { y: spreadY(p.basePosition.y, i) } };
    });
    patch.byPlayer = Object.fromEntries(
      Object.entries(spread).map(([pid, v]) => [pid, { ...byPlayer[pid], ...v }]),
    );
    return patch;
  }

  if (Object.keys(byPlayer).length > 0) patch.byPlayer = byPlayer;
  return patch;
}
