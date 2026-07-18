import { makeTacticalInput } from "@hmb/engine";
import { TeamInputJobContext } from "@hmb/shared";
import type { AiExecutor } from "../executor.js";
import type { ExecutorJob } from "../kinds.js";

/**
 * 결정론 스텁 executor — 키/네트워크/로그인 0 (테스트·오프라인·CI·폴백). AC-T2 의 오프라인 축.
 * 실제 AI 대체가 아니라 폴링→검증→complete 배선 검증용. 잡 seed 로 결정론 베이스 인풋을 만들고
 * teamPrompt 키워드로 성향만 거칠게 조정(기존 W1 stub 의미론 유지), playerId 는 로스터 실 id 로 재매핑.
 */
export function stubExecutor(): AiExecutor {
  return {
    name: "stub",
    execute(job: ExecutorJob): Promise<unknown> {
      if (job.kind !== "team-input") throw new Error(`stub: 미지원 kind ${String(job.kind)}`);
      const ctx = TeamInputJobContext.parse(job.context);

      // 엔진 fixture 헬퍼로 시드 결정론 베이스(4-3-3 슬롯·중립 behavior) 생성 후,
      // playerId 를 로스터 실제 id(슬롯 순서)로 재매핑 — 검증 게이트(로스터 정합)를 통과해야 한다.
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
      // 선수별 개인 지시: 침투 계열 키워드만 거칠게 반영(스텁 관측성 — 실 번역은 claude-code 몫).
      for (const p of t.players) {
        const pp = ctx.playerPrompts[p.playerId];
        if (pp && /침투|런|run|forward/i.test(pp)) p.behavior.forwardRunFreq = 0.9;
      }

      // 마킹(카탈로그 marking 지시의 stub 흉내 — AC-C2): 마킹 키워드 + opponentRoster 이름/ id 지목 →
      // markTarget 설정. 라이브(claude-code)는 카탈로그 프롬프트로 해석, stub 은 키워드로 방향성만 재현.
      const opp = ctx.opponentRoster ?? [];
      if (opp.length > 0) {
        const isMark = (s: string): boolean => /막아|막아라|마크|전담|mark/i.test(s);
        // playerId 는 **단어경계** 매칭("A10 막아"가 A1 을 매칭하지 않게, W0 이월 수정). 이름은 부분일치.
        const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const mentionsId = (s: string, id: string): boolean => new RegExp(`\\b${escapeRe(id)}\\b`).test(s);
        const findTarget = (s: string): string | undefined =>
          opp.find((o) => mentionsId(s, o.playerId) || s.includes(o.name))?.playerId;

        // 개인 지시로 특정 우리 선수에게 마킹을 붙인 경우 → 그 선수 markTarget.
        for (const p of t.players) {
          const pp = ctx.playerPrompts[p.playerId];
          if (pp && isMark(pp)) {
            const target = findTarget(pp);
            if (target) p.markTarget = target;
          }
        }

        // 팀 지시에 마킹이 있으면 지목된 상대들을 수비 자원에 1:1 분배(복수 마킹).
        if (isMark(ctx.teamPrompt)) {
          const mentioned = opp.filter(
            (o) => ctx.teamPrompt.includes(o.name) || mentionsId(ctx.teamPrompt, o.playerId),
          );
          const defenders = t.players.filter((p) => /(LB|CB|RB|DM|CDM)/i.test(p.role) && !p.markTarget);
          mentioned.forEach((o, i) => {
            const d = defenders[i];
            if (d) d.markTarget = o.playerId;
          });
        }
      }

      // 관계·사기 방향성 흉내(AC-C4 계약 테스트용, 최소한). 라이브는 성격 규칙 프롬프트로 해석 —
      // stub 은 성격+톤 키워드로 mentalModifier 방향만 재현(값 정확성 아님).
      const rel = ctx.relations ?? {};
      const scold = (s: string): boolean => /질책|혼|정신차려|압박해|blame|scold|criticiz/i.test(s);
      const strongAttack = (s: string): boolean => /공격|과감|밀어붙|강하게|attack|aggress|push/i.test(s);
      const clampM = (v: number): number => Math.max(-1, Math.min(1, v));
      for (const p of t.players) {
        const r = rel[p.playerId];
        if (!r) continue;
        const tone = `${ctx.teamPrompt} ${ctx.playerPrompts[p.playerId] ?? ""}`;
        if (r.personality === "GLASS" && scold(tone)) {
          p.mentalModifier = clampM(p.mentalModifier - 0.4); // 유리멘탈: 질책에 위축(역효과)
        } else if (r.personality === "FIERY" && strongAttack(tone)) {
          p.mentalModifier = clampM(p.mentalModifier + 0.4); // 불꽃: 강한 지시에 과반응
        } else if (r.personality === "AMBITIOUS" && strongAttack(tone)) {
          p.mentalModifier = clampM(p.mentalModifier + 0.3); // 야심가: 공격 지시 선호
          p.behavior.shootTendency = clampM(p.behavior.shootTendency + 0.2);
        }
        // 신뢰 낮으면 지시 이행도 완화 — 반응을 중립 쪽으로 절반 눌러 보수화.
        if (r.trust < 40) p.mentalModifier = p.mentalModifier * 0.5;
      }
      // 팀 사기: 연패 흐름(streak<0)이면 팀 전반 mentalModifier 소폭 하향(문맥 흉내).
      if (ctx.teamMorale && ctx.teamMorale.streak < 0) {
        for (const p of t.players) p.mentalModifier = clampM(p.mentalModifier - 0.1);
      }
      return Promise.resolve(t);
    },
  };
}
