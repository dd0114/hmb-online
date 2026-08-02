/**
 * #407 ⑦ — `penalty-spot.test.ts` 의 PK 시드 재스캔(분석 전용, 프로덕션 무수정).
 *
 * 그 계약은 "PK 정지 동안 공이 스팟에서 안 움직인다"를 보는데, **경기당 PK 1건이 상한**이라
 * 전개가 바뀌면 고른 시드에서 PK 가 통째로 사라진다(파일 주석의 재스캔 이력 6회). 엔진 동작이
 * 바뀔 때마다 같은 절차를 반복하므로 스캐너를 남긴다.
 *
 * 실행:
 *   node tools/run-gate.mjs --label e407-ofs -- npx tsx research/e407-probe/e407-pk-seed-scan.ts
 * 환경변수: HMB_FROM(기본 1) · HMB_TO(기본 300)
 */
import { defaultEngineConfig } from "../../packages/engine/src/config";
import { runMatch } from "../../packages/engine/src/match";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures";

const FROM = Number(process.env.HMB_FROM || 1);
const TO = Number(process.env.HMB_TO || 300);
const select = makeSelectData();

const hits: { seed: string; pk: number; goals: number }[] = [];
for (let i = FROM; i <= TO; i++) {
  const seed = String(i);
  const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, defaultEngineConfig);
  const pk = log.events.filter((e) => e.type === "penalty").length;
  if (!pk) continue;
  hits.push({ seed, pk, goals: log.events.filter((e) => e.type === "goal").length });
}
console.log(`# PK 보유 시드 ${FROM}~${TO} — ${hits.length}개 (engine@${defaultEngineConfig.version})`);
for (const h of hits.sort((a, b) => b.goals - a.goals)) {
  console.log(`  ${h.seed}(PK${h.pk}·골${h.goals})`);
}
