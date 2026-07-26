/**
 * C5' 슬라이스 병합 (#193 정정) — merge-slices.ts 의 정정판: 베이스를 결정론 픽스처가 아니라
 * **AI 생성본**(sonnet effort-low 전량 생성 PASS 봉투의 structured_output)으로 교체.
 * 슬라이스 패치 3종(team→groups→players)을 그 위에 순서대로 applyPatch. AI 재실행 없음(병합만).
 *
 * 실행: npx tsx packages/server/scripts/merge-slices2.ts <sliceDumpDir> <baseEnvelope.json> <outFile>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TacticalInput, TacticalPatch, applyPatch, clampTacticalInput } from "@hmb/shared";
import { assertRosterConsistency } from "../src/prompt/coach.js";
import { makeTeamInputContext } from "../src/executor/test-fixtures.js";

const dir = process.argv[2];
const basePath = process.argv[3];
const out = process.argv[4];
if (!dir || !basePath || !out) throw new Error("usage: merge-slices2.ts <sliceDumpDir> <baseEnvelope.json> <outFile>");

const ctx = makeTeamInputContext();
const baseEnv = JSON.parse(readFileSync(basePath, "utf8")) as { is_error?: boolean; structured_output?: unknown };
if (baseEnv.is_error) throw new Error(`base envelope is_error=true: ${basePath}`);
let acc: TacticalInput = TacticalInput.parse(baseEnv.structured_output);

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
