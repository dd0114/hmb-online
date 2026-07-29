/**
 * #285 — 캐릭터 아트 노출 정책. **판정이 한 곳인지**를 이 파일이 지킨다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHAR_ART_MIN_GRADE, showsCharacterArt } from "./icon-policy";
import { GRADE_ORDER, type Grade } from "./grades";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const srcDir = join(here, "..");

describe("showsCharacterArt", () => {
  it("다이아 이상만 아트를 노출한다 (hero 확정 #285)", () => {
    expect(showsCharacterArt("LEGEND")).toBe(true);
    expect(showsCharacterArt("DIA")).toBe(true);
    expect(showsCharacterArt("GOLD")).toBe(false);
    expect(showsCharacterArt("SILVER")).toBe(false);
    expect(showsCharacterArt("BRONZE")).toBe(false);
  });

  it("등급 미상은 fail-closed — 정책이 열리는 쪽으로 폴백하지 않는다", () => {
    expect(showsCharacterArt(undefined)).toBe(false);
    expect(showsCharacterArt(null)).toBe(false);
    expect(showsCharacterArt("PLATINUM" as Grade)).toBe(false);
  });

  it("판정은 등급 **순서**로 한다 — 임계 한 줄을 옮기면 전 등급이 따라 움직인다", () => {
    // 임계를 바꿔 끼웠을 때의 기대치를 같은 규칙으로 재계산해 비교한다.
    // (등급 이름을 나열한 구현이면 이 검사가 임계 이동을 못 따라온다.)
    for (const threshold of GRADE_ORDER) {
      const min = GRADE_ORDER.indexOf(threshold);
      const expected = GRADE_ORDER.map((g) => GRADE_ORDER.indexOf(g) >= min);
      const actualWithRealThreshold = GRADE_ORDER.map(
        (g) => GRADE_ORDER.indexOf(g) >= GRADE_ORDER.indexOf(CHAR_ART_MIN_GRADE),
      );
      if (threshold === CHAR_ART_MIN_GRADE) {
        expect(actualWithRealThreshold).toEqual(expected);
      }
    }
    expect(GRADE_ORDER.map((g) => showsCharacterArt(g))).toEqual(
      GRADE_ORDER.map((g) => GRADE_ORDER.indexOf(g) >= GRADE_ORDER.indexOf(CHAR_ART_MIN_GRADE)),
    );
  });
});

describe("판정이 한 곳인지 — 소비처가 등급을 다시 비교하지 않는다", () => {
  /**
   * ⚠️ 이 검사가 막는 것: 화면마다 `grade === "GOLD"` 를 적어 두면 `CHAR_ART_MIN_GRADE` 를 옮겨도
   * 그 화면만 옛 임계로 남는다. 아트를 그리는 파일에서 등급 리터럴 비교를 금지한다.
   * (`grades.ts` 자신·정책 모듈·등급 라벨/색 테이블은 대상이 아니다 — 그건 표기 축이다.)
   */
  const ART_FILES = [
    "common/CharAvatar.tsx",
    "common/FullArtCard.tsx",
    "match/viewer-skins.ts",
  ];

  it("아트 렌더 파일에 등급 리터럴 비교가 없다", () => {
    const offenders: string[] = [];
    for (const rel of ART_FILES) {
      const text = readFileSync(join(srcDir, rel), "utf8");
      // 주석은 지운다 — 설명 문장에 등급 이름이 나오는 건 정상이다.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const g of GRADE_ORDER) {
        if (new RegExp(`[=!]==\\s*["'\`]${g}["'\`]|["'\`]${g}["'\`]\\s*[=!]==`).test(code)) {
          offenders.push(`${rel}: ${g}`);
        }
      }
    }
    expect(offenders, "등급 비교는 icon-policy 한 곳에서만").toEqual([]);
  });

  /**
   * ⚠️ 정책에는 **예외 문(門)이 하나** 있다: `artReviewExempt`(DEV `/design/cards` 아트 검수).
   * 문이 열려 있다는 걸 아무도 모르면 다음 사람이 제품 화면에서 "이 카드만 아트 보이게" 하려고
   * 쓴다. 그래서 사용처를 **정의(common) + 검수 도구(design)** 로 묶어 둔다.
   */
  it("정책 예외(artReviewExempt)는 검수 도구에서만 쓴다", () => {
    const used = walk(srcDir).filter((f) => readFileSync(f, "utf8").includes("artReviewExempt"));
    const rels = used.map((f) => f.slice(srcDir.length + 1).replace(/\\/g, "/")).sort();
    const stray = rels.filter((r) => !r.startsWith("design/") && !r.startsWith("common/"));
    expect(stray, "예외는 src/design(검수 도구)·src/common(정의)에서만").toEqual([]);
    expect(rels.some((r) => r.startsWith("design/")), "검수 도구가 실제로 예외를 쓴다").toBe(true);
  });
});

/** src 트리의 .ts/.tsx 를 전부 훑는다(테스트 파일 포함 — 예외가 테스트로 새 나가도 잡는다). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("실 데이터와의 정합 — 정책이 공허하지 않다", () => {
  const seedFile = readdirSync(join(repoRoot, "data", "players"))
    .filter((f) => /^players\.v[\d.]+\.json$/.test(f))
    .sort((a, b) => {
      const num = (f: string) => f.slice(9, -5).split(".").map(Number);
      const [x, y] = [num(a), num(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
      }
      return 0;
    })
    .pop()!;
  const seed = JSON.parse(readFileSync(join(repoRoot, "data", "players", seedFile), "utf8")) as Array<{
    id: string;
    grade: Grade;
  }>;
  const mapping = JSON.parse(
    readFileSync(join(repoRoot, "data", "players", "player-chars.v2.json"), "utf8"),
  ) as { players: Record<string, unknown> };

  it("아트 매핑이 붙어 있는데 정책상 숨겨야 하는 선수가 실제로 있다", () => {
    const hidden = seed.filter((p) => !showsCharacterArt(p.grade) && mapping.players[p.id] != null);
    // 이게 0 이면 "숨긴다"가 화면에서 아무 일도 하지 않는다는 뜻 = 계약이 공허하다.
    expect(hidden.length, "골드 이하 + 아트 매핑 있음 표본").toBeGreaterThan(50);
  });

  it("정책상 노출해야 하는 선수도 실제로 있다 — 전부 숨기는 게 아니다", () => {
    const shown = seed.filter((p) => showsCharacterArt(p.grade) && mapping.players[p.id] != null);
    expect(shown.length, "다이아 이상 + 아트 매핑 있음 표본").toBeGreaterThan(10);
  });
});
