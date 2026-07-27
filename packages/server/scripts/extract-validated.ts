/**
 * 계측 덤프 봉투 → 프로덕션 검증 게이트(KINDS[kind].validate) 통과본을 파일로 저장 (#193 블라인드 심사 소재).
 * validate-dumps.ts 와 동일 컨텍스트(fullContext) — PASS/FAIL 출력 대신 최종 JSON 을 남긴다.
 *
 * 실행: npx tsx packages/server/scripts/extract-validated.ts <envelopeFile> <outFile> [kind]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
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

const file = process.argv[2];
const out = process.argv[3];
if (!file || !out) throw new Error("usage: extract-validated.ts <envelopeFile> <outFile> [kind]");
const kind = (process.argv[4] ?? (basename(file).startsWith("team-input-patch") ? "team-input-patch" : "team-input")) as AiJobKind;

// measure-ai-latency.ts fullContext 와 동일 소재.
function fullContext(k: AiJobKind): unknown {
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
  return k === "team-input" ? makeTeamInputContext(common) : makeTeamInputPatchContext(common);
}

const env = JSON.parse(readFileSync(file, "utf8")) as { structured_output?: unknown };
const validated = KINDS[kind].validate(env.structured_output, fullContext(kind));
writeFileSync(out, JSON.stringify(validated, null, 2));
console.log(`OK kind=${kind} out=${out} chars=${JSON.stringify(validated).length}`);
