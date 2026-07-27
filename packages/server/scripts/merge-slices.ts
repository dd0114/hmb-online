/**
 * C5 슬라이스 병합 (#193 계측 보조) — measure-ai-latency `--kind slices` 덤프(3개 패치 봉투)를
 * applyPatch 로 base 에 순서대로(team → groups → players) 머지해 최종 TacticalInput 을 만든다.
 *
 * 실행: npx tsx packages/server/scripts/merge-slices.ts <sliceDumpDir> <outFile>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TacticalPatch, applyPatch, clampTacticalInput, type TacticalInput } from "@hmb/shared";
import { assertRosterConsistency } from "../src/prompt/coach.js";
import { makeBaseTacticalInput, makeTeamInputContext } from "../src/executor/test-fixtures.js";

const dir = process.argv[2];
const out = process.argv[3];
if (!dir || !out) throw new Error("usage: merge-slices.ts <sliceDumpDir> <outFile>");

const ctx = makeTeamInputContext();
let acc: TacticalInput = makeBaseTacticalInput(ctx.seed);

// measure-ai-latency slices 모드는 team/groups/players 순으로 iter 1..3 을 덤프한다.
for (const file of ["team-input-patch-1.envelope.json", "team-input-patch-2.envelope.json", "team-input-patch-3.envelope.json"]) {
  const env = JSON.parse(readFileSync(join(dir, file), "utf8")) as { structured_output?: unknown };
  const patch = TacticalPatch.parse(env.structured_output);
  acc = applyPatch(acc, patch, { seed: ctx.seed });
  console.log(`merged ${file} keys=${Object.keys(env.structured_output as Record<string, unknown>).join(",")}`);
}

const final = clampTacticalInput(acc);
assertRosterConsistency(final, ctx.roster);
writeFileSync(out, JSON.stringify(final, null, 2));
console.log(`OK final=${out} chars=${JSON.stringify(final).length}`);
