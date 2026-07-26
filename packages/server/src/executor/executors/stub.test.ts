import { describe, it, expect } from "vitest";
import { TacticalInput, applyPatch, type TacticalPatch } from "@hmb/shared";
import { stubExecutor } from "./stub.js";
import {
  makeTeamInputContext,
  makeTeamInputPatchContext,
  makeBaseTacticalInput,
  makeOpponentRoster,
} from "../test-fixtures.js";

/**
 * 스텁 executor 의 **재시도 피드백 수용** (#193 검증 M-2).
 *
 * ExecutorLoop 는 게이트 실패 시 그 메시지를 `execute(job, {feedback})` 로 실어 1회 재시도한다.
 * 스텁이 2번째 인자를 무시하면 같은 산출을 다시 내 재시도가 구조적으로 무의미하고(2연속 실패 확정),
 * 오프라인 E2E 는 "재시도가 실제로 고친다"는 경로를 한 번도 태우지 못한다.
 *
 * 라이브 claude 는 피드백을 자연어로 해석한다 — 스텁은 게이트 메시지의 키워드로 결정론 흉내를 낸다.
 * (결정론: 인덱스 기반만, Math.random 금지 — 같은 입력이면 항상 같은 산출.)
 */

const job = (kind: "team-input" | "team-input-patch", context: unknown) =>
  ({ id: "j1", kind, context }) as never;

describe("stub executor — 게이트 피드백 수용(재시도 2회차)", () => {
  const opponentRoster = makeOpponentRoster();

  it("markTarget 피드백 → 로스터 첫 수비수에 markTarget 을 세운다(team-input)", async () => {
    const ctx = makeTeamInputContext({ teamPrompt: "상대 에이스를 전담 마크", opponentRoster });
    const ex = stubExecutor();

    const first = TacticalInput.parse(await ex.execute(job("team-input", ctx)));
    expect(first.players.filter((p) => p.markTarget).length).toBe(0); // 지목이 없어 스스로는 안 고른다

    const retry = TacticalInput.parse(
      await ex.execute(job("team-input", ctx), {
        feedback: "마킹 지시가 있으나 markTarget 미설정 — 상대 로스터에서 대상을 골라 설정하라",
      }),
    );
    const marked = retry.players.filter((p) => p.markTarget !== undefined && p.markTarget !== "");
    expect(marked).toHaveLength(1);
    expect(opponentRoster.map((o) => o.playerId)).toContain(marked[0]!.markTarget);
  });

  it("markTarget 피드백 → 패치에 markTargets 를 채운다(team-input-patch)", async () => {
    const ctx = makeTeamInputPatchContext({ teamPrompt: "상대 에이스를 전담 마크", opponentRoster });
    const patch = (await stubExecutor().execute(job("team-input-patch", ctx), {
      feedback: "마킹 지시가 있으나 markTarget 미설정 — 상대 로스터에서 대상을 골라 설정하라",
    })) as TacticalPatch;
    expect(Object.keys(patch.markTargets ?? {})).toHaveLength(1);
    const merged = applyPatch(ctx.base, patch, { seed: ctx.seed });
    expect(merged.players.filter((p) => p.markTarget).length).toBe(1);
  });

  it("오프사이드트랩 피드백 → 트랩을 끈다(두 kind)", async () => {
    const base = makeBaseTacticalInput();
    const trapped = { ...base, team: { ...base.team, offsideTrap: true, defensiveLineHeight: 0.1 } };
    const feedback =
      "낮은 수비라인(defensiveLineHeight 0.1)에서 오프사이드트랩 활성은 자기모순 — 트랩을 끄거나 라인을 0.45 이상으로 올려라";

    const full = TacticalInput.parse(
      await stubExecutor().execute(job("team-input", makeTeamInputContext()), { feedback }),
    );
    expect(full.team.offsideTrap).toBe(false);

    const ctx = makeTeamInputPatchContext({ base: trapped });
    const patch = (await stubExecutor().execute(job("team-input-patch", ctx), { feedback })) as TacticalPatch;
    expect(applyPatch(ctx.base, patch, { seed: ctx.seed }).team.offsideTrap).toBe(false);
  });

  it("겹침 피드백 → basePosition 을 분산해 밀집을 푼다(결정론)", async () => {
    const base = makeBaseTacticalInput();
    // 3명이 한 점에 붕괴한 베이스 = G3 위반 상태.
    const collapsed = {
      ...base,
      players: base.players.map((p, i) => (i < 3 ? { ...p, basePosition: { x: 0.5, y: 0.5 } } : p)),
    };
    const ctx = makeTeamInputPatchContext({ base: collapsed });
    const feedback = "배치 파손 — basePosition (0.500,0.500) 에 3명이 겹침(H0,H1,H2). 서로 다른 좌표로 분산하라";

    const patch = (await stubExecutor().execute(job("team-input-patch", ctx), { feedback })) as TacticalPatch;
    const merged = applyPatch(ctx.base, patch, { seed: ctx.seed });
    const spots = merged.players.map((p) => `${p.basePosition.x.toFixed(3)},${p.basePosition.y.toFixed(3)}`);
    const worst = Math.max(...spots.map((s) => spots.filter((o) => o === s).length));
    expect(worst).toBeLessThanOrEqual(2);

    // 결정론 — 같은 (컨텍스트, 피드백)이면 같은 산출.
    const again = (await stubExecutor().execute(job("team-input-patch", ctx), { feedback })) as TacticalPatch;
    expect(JSON.stringify(again)).toBe(JSON.stringify(patch));
  });

  it("피드백이 없으면 기존 산출 그대로(회귀 없음)", async () => {
    const ctx = makeTeamInputContext({ teamPrompt: "하이라인·와이드 공격" });
    const a = await stubExecutor().execute(job("team-input", ctx));
    const b = await stubExecutor().execute(job("team-input", ctx), { feedback: "" });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
