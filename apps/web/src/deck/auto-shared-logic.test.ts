import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * #439 AC5 — **덱셋팅과 경기전이 같은 함수를 탄다**.
 *
 * hero 질문(*"덱셋팅도 그렇고 auto도 그렇고 빈자리 채우기로만 하자. 그러면 같은 로직을 쓸 수
 * 있지?"*)의 답이 코드에 남아 있는지 본다. 두 화면이 각자 auto 를 구현하면 한쪽만 고쳐지는
 * 회귀가 구조적으로 생긴다 — 그 회귀를 e2e 로는 못 잡는다(양쪽이 **다른 규칙으로** 각각
 * 초록일 수 있다).
 *
 * ⚠️ 같이 박는 것이 하나 더 있다: **`autoBuildLineup` 을 다시 배선하면 red 다.**
 * 그 함수는 배치된 선수 전원의 프롬프트를 기본문구로 덮고 팀 전술을 초기화한다 = hero 가
 * 없애라고 한 [초기화] 와 같은 피해다(STATE 4 ⚠️1). 파일은 롤백 자산으로 남기되 **소비처는 0** 이다.
 */

/**
 * ⚠️ **주석은 걷어내고 본다.** 되돌리지 말라는 경고를 주석에 적는 것이 이 리포의 규율인데
 * (`DeckPage.tsx` 가 정확히 그렇게 적고 있다), 원문을 그대로 훑으면 그 경고가 스스로를 red 로
 * 만든다 = 경고를 쓰지 못하게 하는 계약이 된다. 문자열 리터럴 안의 `//` 는 이 파일들에 없어
 * 단순 제거로 충분하다(있게 되면 이 스캐너가 먼저 깨져 알려 준다).
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));

const SCREENS: Array<[string, string]> = [
  ["덱셋팅(DeckPage)", "./DeckPage.tsx"],
  ["경기전(BriefingPanel)", "../match/BriefingPanel.tsx"],
];

describe("#439 auto = 한 함수, 후보 풀만 주입", () => {
  for (const [label, rel] of SCREENS) {
    it(`${label} 는 fillEmptySlots 를 쓴다`, () => {
      const src = read(rel);
      expect(src, `${label} 가 공용 함수를 import 하지 않는다`).toMatch(
        /import\s*\{[^}]*\bfillEmptySlots\b[^}]*\}\s*from\s*"[^"]*fill-empty"/,
      );
      expect(src).toMatch(/\bfillEmptySlots\s*\(/);
    });

    it(`${label} 는 autoBuildLineup(전면 재구성)을 쓰지 않는다`, () => {
      expect(read(rel)).not.toMatch(/\bautoBuildLineup\b/);
    });
  }

  it("경기전 화면은 auto 를 실제로 내려보낸다(onAuto 미전달 = 버튼 0개였던 상태의 회귀 가드)", () => {
    expect(read("../match/BriefingPanel.tsx")).toMatch(/onAuto=\{/);
  });
});
