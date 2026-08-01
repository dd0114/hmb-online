import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShowcaseLog } from "../packages/engine/dev-viewer/generate-demo";
import type { MatchLog } from "@hmb/shared";

/**
 * `tools/qa-match.mjs` 의 **빗나감 측정 창 가드** 계약 (#377 M3-A, 독립검증 m6).
 *
 * ## 왜 있나
 * 그 가드는 실제 오탐을 고치고 들어왔는데(off_target 다음 틱이 하프 경계면 공은 이미 킥오프로
 * 중앙에 리셋돼 "골문 안쪽에 머묾"으로 찍힌다), **출하 데모에서는 그 분기가 한 번도 안 탄다** —
 * 지금 데모의 off_target 옆에 휘슬이 없기 때문이다. 즉 가드가 조용히 깨져도 아무도 모른다.
 * 그래서 두 방향을 **합성 로그**로 직접 태운다: 휘슬이 있으면 통과, 없으면 잡는다.
 *
 * ## 왜 합성인가
 * 이 성질은 "특정 시드에 그런 장면이 있다"에 기대면 안 된다(시드 재선정 때마다 계약이 증발한다).
 * 실 로그를 베이스로 **딱 그 한 틱만** 조작해 두 세계를 만든다.
 */
function findOffTarget(log: MatchLog): number {
  const e = log.events.find((x) => x.type === "shot" && x.detail === "off_target");
  if (!e) throw new Error("합성 베이스에 off_target 이 없다 — 쇼케이스 시드 재선정 필요");
  return e.tick;
}

/** 다음 틱의 공을 정중앙(킥오프 리셋 위치)으로 옮긴다 = 오탐이 나는 좌표. */
function putBallAtCenter(log: MatchLog, tick: number): void {
  const snap = log.tickSnapshots.find((s) => s.tick === tick);
  if (!snap) throw new Error(`t${tick} 스냅샷 없음`);
  snap.ball = { ...snap.ball, x: 52.5, y: 34 };
}

function run(log: MatchLog): string {
  const dir = mkdtempSync(join(tmpdir(), "hmb-qa-"));
  const p = join(dir, "log.json");
  writeFileSync(p, JSON.stringify(log));
  return execFileSync("node", ["tools/qa-match.mjs", p], { encoding: "utf8" });
}

describe("#377 M3-A — qa-match 빗나감 측정 창 가드", () => {
  const base = buildShowcaseLog();

  it("하프 경계가 다음 틱을 잘라도 '골문 안쪽에 머묾' 오탐이 안 난다", () => {
    const log = structuredClone(base) as MatchLog;
    const t = findOffTarget(log);
    putBallAtCenter(log, t + 1);
    // 그 틱에 하프 휘슬이 있었다 = 공이 중앙인 것은 킥오프 리셋 때문이다.
    log.events.push({ tick: t + 1, type: "half_whistle" } as MatchLog["events"][number]);
    log.events.sort((a, b) => a.tick - b.tick);
    // 단언은 **기하 검사 메시지**만 본다 — 합성이 다른 검사(정지 시퀀스 매핑)를 건드릴 수 있어서
    // "빗나감"이라는 단어로 잡으면 엉뚱한 실패를 붙든다(실제로 한 번 그랬다).
    expect(run(log)).not.toContain("공이 골문 안쪽에 머묾");
  }, 120_000);

  it("휘슬이 없으면 같은 좌표를 **잡는다** — 가드가 전부를 봐주는 게 아니다", () => {
    const log = structuredClone(base) as MatchLog;
    const t = findOffTarget(log);
    putBallAtCenter(log, t + 1);
    expect(run(log)).toContain(`빗나감 t${t}: 공이 골문 안쪽에 머묾`);
  }, 120_000);
});
