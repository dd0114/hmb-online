import { expect, it } from "vitest";
import { buildP421Fixture, writeP421Fixture } from "./gen-p421-fixture";

/**
 * #421 픽스처 **재생성 전용** — 기본은 돌지 않는다.
 *
 * ⚠️ `apps/web/e2e/fixtures/p421-highlight.json` 은 **커밋된 픽스처**다. 이 테스트가 게이트에서
 * 그냥 돌면 `npm test` 가 매번 그 파일을 현재 엔진으로 덮어써서, 이 웨이브가 끊어낸
 * "엔진이 움직이면 web e2e 가 깨진다"는 커플링이 그대로 되살아난다(그리고 다른 세션의 트리가
 * 매번 dirty 해진다 — apps/web CLAUDE.md 의 `HMB_WRITE_EVIDENCE` 와 같은 규율).
 *
 *   HMB_GEN_P421=1 npx vitest run apps/web/scripts/gen-p421-fixture.test.ts
 *
 * 돌 때는 **쓰기 전에** 표본 전제를 확인한다 — 엔진이 움직여 조건을 만족하는 쌍이 사라졌다면
 * 파일을 갈아엎기 전에 여기서 멈추는 편이 낫다(시드 재선정 신호). 조건의 근거는
 * `gen-p421-fixture.ts` 머리말 "시드 선정".
 */
const SHAPE = (e: { type: string; detail?: string }): string | null => {
  if (e.type === "goal") return "goal";
  if (e.type === "save") return "save";
  if (e.type === "shot" && e.detail === "saved") return "shot:saved";
  return null;
};

it.skipIf(!process.env.HMB_GEN_P421)("#421 하이라이트 픽스처 생성 (실엔진 쇼케이스 로그)", () => {
  const log = buildP421Fixture();
  const ticks = log.tickSnapshots.length;

  const shapes = new Map<number, string[]>();
  for (const e of log.events) {
    const k = SHAPE(e);
    if (!k) continue;
    shapes.set(e.tick, [...(shapes.get(e.tick) ?? []), k].sort());
  }
  const saveTicks = [...shapes.entries()]
    .filter(([t, v]) => t > 720 && t <= 864 && v.join("|") === "save|shot:saved")
    .map(([t]) => t);
  const goalTicks = [...shapes.entries()]
    .filter(([t, v]) => t > 1161 && t + 100 < ticks && v.join("|") === "goal")
    .map(([t]) => t);
  const pairs = saveTicks.flatMap((s) => goalTicks.filter((g) => g - s > 320).map((g) => [s, g]));

  // eslint-disable-next-line no-console
  console.log(
    `[p421] seed=${log.seed} ver=${log.configVersion} ticks=${ticks}\n` +
      `  S1 후보(save+shot:saved) = ${saveTicks.join(",")}\n` +
      `  S2 후보(goal)            = ${goalTicks.join(",")}\n` +
      `  성립 쌍                  = ${pairs.map(([s, g]) => `${s}→${g}`).join(" ")}`,
  );
  expect(pairs.length, "spec 의 전제를 만족하는 (S1,S2) 쌍이 없다 — 시드를 다시 골라라").toBeGreaterThan(0);
  // 스냅샷을 솎으면 "자연 재생으로는 못 온다"는 전제가 무너진다(머리말 ⚠️).
  expect(ticks).toBe(log.tickSnapshots.at(-1)!.tick + 1);

  writeP421Fixture(new URL("../e2e/fixtures/p421-highlight.json", import.meta.url).pathname);
}, 600_000);
