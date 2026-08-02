/**
 * #406 요구 5-4 / hero 확정 ④ — 로그 라벨 **한글화** 계약.
 *
 * <p>핵심은 "몇 개를 한글로 적었나"가 아니라 <b>영어가 새는 경로가 없나</b>다. 그래서 라벨을
 * 손으로 나열해 비교하지 않고, <b>코어(`logLines`)를 실제로 통과시킨 뒤</b> 결과에 로마자가
 * 남아 있는지를 본다 — 코어가 라벨을 바꾸거나 detail 변종이 늘면 여기가 먼저 깨진다.
 *
 * <p>⚠️ `packages/viewer-core` 는 <b>QA dev-viewer 와 공용</b>이고 그쪽은 전면 영어다
 * (`packages/engine/dev-viewer/e2e/{log,captions}.spec.ts` 가 영어 라벨에 걸려 있다).
 * 그래서 한글화는 **호스트(web)** 에서만 한다 — 이 경계 자체도 아래에서 계약으로 건다.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { logLines, type LogEvent } from "@hmb/viewer-core";
import { MatchEventType } from "@hmb/shared";
import { koLogLabel, KO_LABEL_TYPES } from "./log-labels";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..", "..");

/**
 * `MatchEventType` 전수 — **리터럴로 박는다**(앱/스키마와 같은 상수를 그대로 쓰면 타입이 늘어도
 * 계약이 같이 늘어나 아무것도 못 잡는다, `apps/web/CLAUDE.md` 거짓말 #2). 대신 아래에서
 * shared 열거와 **대조**해 추가/삭제를 잡는다.
 */
const ALL_TYPES = [
  "kickoff",
  "pass",
  "interception",
  "tackle",
  "clearance",
  "shot",
  "goal",
  "save",
  "foul",
  "offside",
  "free_kick",
  "penalty",
  "card",
  "substitution",
  "half_whistle",
  "full_whistle",
] as const;

/** 엔진이 실제로 싣는 detail (없으면 `undefined`). */
const DETAILS: Record<string, Array<string | undefined>> = {
  kickoff: [undefined, "corner", "goal_kick", "throw_in"],
  shot: [undefined, "saved", "off_target", "one_on_one", "penalty"],
  card: ["yellow", "red"],
  free_kick: [undefined, "foul", "offside"],
  pass: [undefined, "header", "long"],
  interception: [undefined, "long"],
};

function lineFor(type: string, detail: string | undefined) {
  const e: LogEvent = { tick: 10, minute: 1, type, detail: detail ?? null, team: "home", playerId: "P001" };
  // `isLogged` 를 우회하지 않는다 — 코어가 안 보여주는 조합은 라인이 안 나오는 게 정상이다.
  const [line] = logLines([e], 999);
  return line;
}

describe("koLogLabel — 알려진 타입 전수 매핑", () => {
  it("shared MatchEventType 이 16종 그대로다 (타입이 늘면 매핑을 같이 늘려라)", () => {
    expect([...MatchEventType.options].sort()).toEqual([...ALL_TYPES].sort());
    expect(ALL_TYPES).toHaveLength(16);
  });

  it("16종 전부 한글 라벨이 있다 — `clearance` 포함", () => {
    const missing = ALL_TYPES.filter((t) => !KO_LABEL_TYPES.includes(t));
    expect(missing, "타입 매핑 누락").toEqual([]);
    expect(KO_LABEL_TYPES).toContain("clearance");
  });

  /**
   * ★ 본 계약 — 코어가 만든 라인을 통과시키면 <b>로마자가 하나도 안 남는다</b>.
   * (detail 변종까지 전수. `Shot · off target` 같은 조합이 여기서 걸린다.)
   */
  it("코어가 실제로 만드는 라인은 전부 로마자가 없다", () => {
    const leaks: string[] = [];
    for (const type of ALL_TYPES) {
      for (const detail of DETAILS[type] ?? [undefined]) {
        const line = lineFor(type, detail);
        if (!line) continue; // 코어가 안 보여주는 조합(pass·clearance 등)
        const ko = koLogLabel(line);
        if (/[A-Za-z]/.test(ko)) leaks.push(`${type}/${detail ?? "-"} → ${ko}`);
      }
    }
    expect(leaks, "영어가 새는 조합").toEqual([]);
  });

  it("코어가 안 보여주는 타입도 매핑은 있다 — SHOWN 이 넓어지는 날 그 타입만 영어로 새지 않게", () => {
    // 지금 `pass`·`clearance` 는 티커에 안 오른다(라인 자체가 안 나온다) = 백스톱이 필요한 이유.
    expect(lineFor("pass", undefined)).toBeUndefined();
    expect(lineFor("clearance", undefined)).toBeUndefined();
    expect(koLogLabel({ type: "pass", label: "pass" })).toBe("패스");
    expect(koLogLabel({ type: "clearance", label: "clearance" })).toBe("걷어내기");
  });

  it("실제로 바뀐다 — 코어 영어 라벨과 다르다(신선도 가드)", () => {
    for (const [type, detail] of [
      ["goal", undefined],
      ["shot", "saved"],
      ["shot", "off_target"],
      ["kickoff", "corner"],
      ["card", "red"],
      ["half_whistle", undefined],
    ] as const) {
      const line = lineFor(type, detail)!;
      expect(line, `${type}/${detail}`).toBeTruthy();
      expect(koLogLabel(line)).not.toBe(line.label);
    }
  });

  it("hero 확정 표기 — 목업 §4 대응표 그대로", () => {
    expect(koLogLabel(lineFor("goal", undefined)!)).toBe("⚽ 골!");
    expect(koLogLabel(lineFor("shot", "saved")!)).toBe("슛 · 선방 🧤");
    expect(koLogLabel(lineFor("shot", "off_target")!)).toBe("슛 · 빗나감");
    expect(koLogLabel(lineFor("shot", "one_on_one")!)).toBe("일대일 찬스!");
    expect(koLogLabel(lineFor("kickoff", "throw_in")!)).toBe("스로인");
    expect(koLogLabel(lineFor("card", "yellow")!)).toBe("🟨 경고");
    expect(koLogLabel(lineFor("card", "red")!)).toBe("🟥 퇴장");
    expect(koLogLabel(lineFor("interception", undefined)!)).toBe("가로챔");
    expect(koLogLabel(lineFor("half_whistle", undefined)!)).toBe("전반 종료");
    expect(koLogLabel(lineFor("full_whistle", undefined)!)).toBe("경기 종료");
  });

  it("프리킥 사유는 괄호 안까지 한글이다", () => {
    expect(koLogLabel(lineFor("free_kick", "foul")!)).toBe("프리킥 (파울)");
    expect(koLogLabel(lineFor("free_kick", "offside")!)).toBe("프리킥 (오프사이드)");
    // 모르는 사유가 생겨도 라벨 자체는 한글로 남고 사유만 원문으로 통과한다.
    expect(koLogLabel({ type: "free_kick", label: "Free kick (mystery)" })).toBe("프리킥 (mystery)");
  });

  it("모르는 타입은 코어 라벨로 떨어진다 — 빈 줄을 만들지 않는다", () => {
    expect(koLogLabel({ type: "meteor_strike", label: "Meteor" })).toBe("Meteor");
  });
});

/**
 * ★ 경계 계약 — **코어를 한글로 바꾸지 않았다.** dev-viewer 가 그 코어를 인라인해 영어 티커를
 * 그리고 있고 `packages/engine/dev-viewer/e2e/log.spec.ts` 가 영어 라벨에 걸려 있다.
 * 누군가 "여기만 고치면 되겠네" 하고 코어를 손대면 QA 뷰어 계약이 뒤늦게 깨진다 — 여기서 먼저 잡는다.
 */
describe("경계 — 코어는 데이터, 표기는 호스트", () => {
  const coreText = readFileSync(
    join(repoRoot, "packages", "viewer-core", "src", "log-lines.impl.mjs"),
    "utf8",
  );
  /** 주석은 지운다 — 그 파일의 설명문은 한국어다(정상). 검사 대상은 **코드의 문자열 리터럴**뿐. */
  const core = coreText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("viewer-core 의 라벨은 여전히 영어다", () => {
    expect(core).toContain('"⚽ GOAL"');
    expect(core).toContain('"Shot · saved 🧤"');
    // 코드에 한글 문자열 리터럴이 생기면 = 코어를 한글화한 것 → dev-viewer e2e 가 뒤늦게 깨진다.
    const koLiterals = core.match(/"[^"\n]*[가-힣][^"\n]*"/g) ?? [];
    expect(koLiterals, "코어에 한글 리터럴이 들어왔다").toEqual([]);
  });

  it("한글화는 web 안에서만 일어난다", () => {
    const line = lineFor("goal", undefined)!;
    expect(line.label, "코어가 준 라벨").toBe("⚽ GOAL");
    expect(koLogLabel(line), "호스트가 그리는 라벨").toBe("⚽ 골!");
  });
});
