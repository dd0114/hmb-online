/**
 * 덤프된 claude 응답을 **프로덕션 검증 게이트**(KINDS[kind].validate)로 통과시켜 본다 (#193 W1).
 * 사고 예산을 낮췄을 때(effort/MAX_THINKING_TOKENS) 산출이 여전히 계약을 만족하는지 확인하는 용도.
 *
 * 실행: npx tsx packages/server/scripts/validate-dumps.ts <dumpDir>
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KINDS, type AiJobKind } from "../src/executor/kinds.js";
import {
  makeConditions,
  makeManualTactics,
  makeOpponentRoster,
  makeRelations,
  makeTeamInputContext,
  makeTeamInputPatchContext,
  homeRosterIds,
} from "../src/executor/test-fixtures.js";

const dir = process.argv[2];
if (!dir) throw new Error("usage: validate-dumps.ts <dumpDir>");

// measure-ai-latency.ts 의 fullContext 와 동일 소재(검증 게이트가 컨텍스트를 참조하므로 같아야 한다).
function fullContext(kind: AiJobKind): unknown {
  const ids = homeRosterIds();
  const playerPrompts: Record<string, string> = {};
  ids.slice(0, 5).forEach((id, i) => {
    playerPrompts[id] = [
      "상대 풀백 뒤 공간을 계속 노려라. 볼 없을 때 하프스페이스로 침투하고, 뒤에서 커버가 늦으면 바로 뒤로 달려라.",
      "빌드업에서는 낮게 내려와 받아주고, 전환 순간에는 한 번에 전진 패스를 시도해라.",
      "상대 10번을 계속 따라다녀라. 볼을 뺏으면 곧바로 전방으로 붙여라.",
      "측면을 넓게 벌려 크로스 각을 만들고, 반대 윙이 들어오는 타이밍에 맞춰라.",
      "박스 안에서 기다리지 말고 니어포스트로 먼저 움직여 수비를 끌어라.",
    ][i] as string;
  });
  const common = {
    teamPrompt:
      "전방압박을 강하게 유지하되 뒤 공간이 열리면 라인을 내려라. 측면 전환 빠르게, 박스 안에서는 슛보다 확실한 각을 만들어라.",
    playerPrompts,
    manualTactics: makeManualTactics(),
    conditions: makeConditions(),
    teamMorale: { morale: 62, streak: 2 },
    relations: makeRelations(),
    opponentRoster: makeOpponentRoster(),
  };
  return kind === "team-input" ? makeTeamInputContext(common) : makeTeamInputPatchContext(common);
}

for (const file of readdirSync(dir).sort()) {
  if (!file.endsWith("envelope.json")) continue;
  const kind = (file.startsWith("team-input-patch") ? "team-input-patch" : "team-input") as AiJobKind;
  const env = JSON.parse(readFileSync(join(dir, file), "utf8")) as { structured_output?: unknown; usage?: Record<string, number> };
  try {
    const out = KINDS[kind].validate(env.structured_output, fullContext(kind));
    const s = JSON.stringify(out);
    console.log(`PASS ${file} kind=${kind} outTok=${env.usage?.["output_tokens"]} finalChars=${s.length}`);
  } catch (e) {
    console.log(`FAIL ${file} kind=${kind} — ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
}
