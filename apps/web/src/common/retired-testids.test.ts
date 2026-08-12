// @vitest-environment node
/**
 * **은퇴한 testid 를 참조하는 스펙이 남아 있지 않은지** 훑는다 (#286 W2, 독립검증 BL-2/BL-3).
 *
 * 왜 필요한가: 화면을 갈아엎으면 스펙의 `getByTestId("...")` 는 **조용히 아무것도 못 찾는다**.
 * 운이 나쁘면 그 클릭이 `.catch(() => {})` 로 삼켜져 **계약이 tautology 가 된 채 green** 이 된다
 * (실제로 `p245-away-report` 2건이 그렇게 됐고, 커밋 메시지가 그 green 을 증빙으로 썼다).
 * 라이브 데모에 붙는 스펙(`match-flow`·`w3-viewer-smoke`)은 목킹 게이트에서 제외돼 더 오래 숨는다.
 *
 * 그래서 **정적으로** 막는다. 새 화면으로 옮길 때 여기 한 줄만 추가하면, 남은 참조가 전부 빨간불이다.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** #286 에서 사라진 진입점들 → 새 자리. */
const RETIRED: Record<string, string> = {
  "play-cta": "home-tile-game → /game 의 mode-*",
  "lobby-deck": "home-tile-deck",
  "lobby-shop": "home-tile-recruit",
  "lobby-codex": "home-tile-players",
  "resume-match-card": "home-lock-card",
  "resume-match-note": "home-lock-note",
  "resume-match": "home-resume",
  "abandon-match": "home-abandon",
  "nav-growth": "육성 탭 소멸 — nav-players 로 병합",
  "nav-shop": "nav-recruit",
  "nav-logs": "nav-me",
  "nav-trade": "nav-recruit",
  "nav-codex": "nav-players",
  // 육성 화면(`GrowthHubPage`)은 #286 에서 **삭제**됐다 — 도감의 [보유] 스코프가 그 일을 한다.
  "growth-owned-total": "codex-owned-total (도감 [보유] 스코프)",
  "growth-grid": "codex 그리드",
  "growth-empty": "codex 빈 상태",
  // #382 — 대기 화면의 시스템 설명 한 줄이 **정경 로테이션**으로 교체됐다.
  "genwait-note": "genwait-scene (축구장 정경 로테이션, match/waiting-scenes.ts)",
  // #493 W5 — W1 의 1분 미니게임(`/welcome`)이 hero 판정으로 통째로 걷혔다. 첫 경험은 관전이
  // 아니라 홈 [게임 시작]에서 제안하는 **진짜 연습경기**다(home/PracticeTutorialDialog).
  "minigame-skip": "소멸 — 홈 [게임 시작] → practice-tutorial-dialog (#493 W5)",
  "minigame-cta": "소멸 — practice-tutorial-accept (#493 W5)",
  "minigame-end": "소멸 — 미니게임 자체가 없다 (#493 W5)",
};

const E2E_DIR = new URL("../../e2e/", import.meta.url).pathname;

/** 캡처 하니스는 게이트가 아니라 **과거 화면의 기록**이라 제외한다(파일 상단에 RETIRED 로 명시). */
function specFiles(): string[] {
  return readdirSync(E2E_DIR).filter((f) => f.endsWith(".spec.ts"));
}

describe("은퇴한 testid (#286)", () => {
  it("어떤 e2e 스펙도 사라진 진입점을 참조하지 않는다", () => {
    const offenders: string[] = [];
    for (const file of specFiles()) {
      const src = readFileSync(join(E2E_DIR, file), "utf8");
      for (const [id, moved] of Object.entries(RETIRED)) {
        // 문자열 리터럴로 쓰인 경우만 본다(주석에서 "play-cta 는 소멸" 같은 설명은 허용).
        if (src.includes(`"${id}"`) || src.includes(`'${id}'`) || src.includes(`\`${id}\``)) {
          offenders.push(`${file}: "${id}" → ${moved}`);
        }
      }
    }
    expect(offenders, `은퇴한 testid 참조가 남아 있다:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("스펙 파일을 실제로 훑었다 (경로가 어긋나면 이 가드가 통째로 공허해진다)", () => {
    expect(specFiles().length).toBeGreaterThan(20);
  });
});
