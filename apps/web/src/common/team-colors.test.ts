import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEAM_COLORS, teamColorVar, type TeamSide } from "./team-colors";

/**
 * 팀색 토큰이 **두 벌**인 것을 계약으로 붙잡는다(#456 B4).
 *
 * CSS(`index.css :root`)와 TS(`team-colors.ts`)가 같은 값을 각자 들고 있는 이유는
 * `team-colors.ts` 머리말에 있다 — 타임라인 핀은 TS 가 색 문자열을 만들어 인라인으로 넘기므로
 * CSS 변수만으로는 못 덮는다. 두 벌이면 **갈라질 수 있다**는 뜻이고, 이 파일이 그 드리프트를
 * red 로 만든다.
 *
 * ⚠️ 기대값을 상수에서 import 해 오면(양쪽 다 `TEAM_COLORS` 를 보면) 이 검사는 **자기 자신을
 * 검사한다** — 그래서 CSS 쪽은 **파일을 읽어** 문자열로 비교한다(루트 CLAUDE.md "초록으로
 * 거짓말하는 방식" #2).
 */
const CSS = readFileSync(new URL("../index.css", import.meta.url), "utf8");

function cssVarValue(name: string): string | null {
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(CSS);
  return m ? m[1]!.trim() : null;
}

const SIDES: TeamSide[] = ["home", "away"];
const ROLES = ["text", "strong", "soft"] as const;

describe("#456 B4 — 팀색 단일 출처", () => {
  it("CSS 변수와 TS 상수가 같은 값이다(두 벌이 갈라지면 화면마다 팀색이 달라진다)", () => {
    for (const side of SIDES) {
      for (const role of ROLES) {
        const name = teamColorVar(side, role);
        expect(cssVarValue(name), `${name} 가 index.css 에 없다`).toBeTruthy();
        expect(cssVarValue(name), `${name} ↔ TEAM_COLORS.${side}.${role}`).toBe(
          TEAM_COLORS[side][role],
        );
      }
    }
  });

  /*
   * 값 자체를 리터럴로 박는다 — 이 웨이브가 *"값은 하나도 안 바꿨다"* 고 주장하는 근거이자,
   * 다음 사람이 색을 옮길 때 **화면 다섯 개가 같이 움직인다는 사실을 보게 하는** 자리다.
   * (여기가 red 가 되면 "리팩터인 줄 알았는데 시각 변경"이라는 뜻이다.)
   */
  it("출하 값 = 토큰화 이전에 각 파일이 쓰던 값 그대로", () => {
    expect(TEAM_COLORS).toEqual({
      home: { text: "#7ab0ff", strong: "#3b82f6", soft: "#6ab7ff" },
      away: { text: "#ff8f8f", strong: "#ef4444", soft: "#ff8a7a" },
    });
  });

  it("홈과 원정이 어느 역할에서도 같은 색이 아니다(구분이 성립한다)", () => {
    for (const role of ROLES) {
      expect(TEAM_COLORS.home[role], `${role} 역할에서 두 팀 색이 같다`).not.toBe(
        TEAM_COLORS.away[role],
      );
    }
  });

  /*
   * 리터럴 재발 방지. 토큰을 만들어 두고 옆 파일에 `#7ab0ff` 를 다시 적는 것이 이 웨이브가
   * 걷어낸 바로 그 상태다 — `src/**` 전수 스캔으로 막는다(자기 파일과 이 계약은 예외).
   */
  it("팀색 리터럴이 다른 파일에 남아 있지 않다", () => {
    const root = new URL("../", import.meta.url).pathname;
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) =>
      /\.(ts|tsx|css)$/.test(f),
    );
    const hexes = SIDES.flatMap((s) => ROLES.map((r) => TEAM_COLORS[s][r]));
    /*
     * 예외는 **사유와 함께** 적는다(조용한 예외를 허용하면 이 계약이 다시 거짓말한다).
     * ⚠️ `*.test.ts` 를 통째로 빼지 않는다 — 클래스 단위 면제는 앞으로 생길 모든 테스트에
     *   적용돼 "이 자리는 왜 토큰을 안 쓰나"를 아무도 다시 묻지 않게 만든다(#406 W8 결정).
     */
    const EXEMPT: Record<string, string> = {
      "common/team-colors.ts": "SoT — 값이 사는 곳",
      "common/team-colors.test.ts": "이 계약(기대값을 리터럴로 박는 자리)",
      "index.css": "CSS 쪽 한 벌 — 위 드리프트 계약이 TS 와 묶는다",
      "match/timeline-pins.test.ts":
        "핀 색 기대값을 리터럴로 박는다(상수를 import 하면 자기 자신을 검사한다 — 루트 표 #2)",
    };
    const offenders: string[] = [];
    for (const rel of files) {
      if (Object.keys(EXEMPT).some((e) => rel.endsWith(e))) continue;
      const src = readFileSync(`${root}${rel}`, "utf8");
      for (const hex of hexes) {
        if (src.includes(hex)) offenders.push(`${rel} :: ${hex}`);
      }
    }
    expect(offenders, "팀색 리터럴은 `common/team-colors.ts` 에서만 산다").toEqual([]);
  });

  it("예외 목록이 전부 실재한다(낡은 예외가 조용히 남지 않게)", () => {
    for (const rel of ["common/team-colors.ts", "index.css", "match/timeline-pins.test.ts"]) {
      expect(() => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")).not.toThrow();
    }
  });
});
