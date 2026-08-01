import { describe, expect, it } from "vitest";
import {
  HERO_SCENE_LINES,
  WAITING_SCENE_LINES,
  WAITING_SCENE_ROTATE_SEC,
  waitingSceneAt,
} from "./waiting-scenes";

/**
 * #382 — 경기 준비 대기 화면의 서술 문구는 **축구장 정경 묘사**여야 한다.
 *
 * hero 제보(라이브 실사용): *"'감독의 지시가 선수들에게 전달되고 있습니다 (보통 10초 안팎…)'
 * 경기 준비할 때 문구 이렇게 하지 않기로 했잖아. 축구장 상황을 묘사하는 문구로 바꿔. (…)
 * 기다리기 지루하니까."*
 *
 * 그래서 이 계약이 지키는 것은 두 가지다 — ①시스템 설명·소요시간 안내가 **다시 기어들어오지 않는다**
 * ②hero 가 직접 준 4문장이 **글자 그대로** 풀에 남아 있다(누가 "다듬는다"며 갈아치우는 것을 막는다).
 */

/** hero 원문 4문장 — 계약이 **리터럴로** 들고 있어야 풀에서 조용히 사라지는 것을 잡는다. */
const HERO_VERBATIM = [
  "선수들이 입장하고 있습니다",
  // hero 확정(2026-08-01): 원문 `선수들에게` 는 비문(`격려하다` 는 을/를)이라 조사만 바로잡았다.
  "감독이 선수들을 격려하고 있습니다",
  "선수의 신발끈을 다시 묶고 있습니다",
  "파인 잔디를 조금 보수하고 있습니다",
];

describe("WAITING_SCENE_LINES — 문구 풀", () => {
  it("hero 예시 4문장이 원문 그대로 들어 있다", () => {
    for (const line of HERO_VERBATIM) {
      expect(WAITING_SCENE_LINES, `hero 원문이 풀에서 사라졌다: "${line}"`).toContain(line);
    }
    // 모듈이 내보내는 목록과 계약의 리터럴이 어긋나면 둘 중 하나가 낡은 것이다.
    expect([...HERO_SCENE_LINES]).toEqual(HERO_VERBATIM);
  });

  it("10~20개로 확장돼 있다 (같은 문장이 곧바로 되돌아오면 지루함이 그대로다)", () => {
    expect(WAITING_SCENE_LINES.length).toBeGreaterThanOrEqual(10);
    expect(WAITING_SCENE_LINES.length).toBeLessThanOrEqual(20);
  });

  it("중복이 없다", () => {
    expect(new Set(WAITING_SCENE_LINES).size).toBe(WAITING_SCENE_LINES.length);
  });

  it("전부 현재진행형 정경 묘사다 (…고 있습니다)", () => {
    for (const line of WAITING_SCENE_LINES) {
      expect(line, `현재진행형이 아니다: "${line}"`).toMatch(/고 있습니다$/);
    }
  });

  /**
   * ⚠️ 이 목록이 이 이슈의 본체다. "AI"·"작전 반영"·"지시가 전달" 같은 **시스템 설명**과
   * "10초"·"1~2분" 같은 **소요시간 안내**가 정경 문장 사이로 다시 들어오면 hero 가 지운 것이
   * 되살아난다.
   */
  it("시스템 설명·소요시간 안내가 섞이지 않는다", () => {
    const banned = [
      "AI",
      "작전",
      "반영",
      "지시",
      "전달",
      "생성",
      "서버",
      "로딩",
      "대기",
      "처리",
      "분석",
      "초",
      "분",
    ];
    for (const line of WAITING_SCENE_LINES) {
      for (const word of banned) {
        expect(line, `시스템 용어/시간 안내가 들어갔다: "${line}" ← "${word}"`).not.toContain(word);
      }
      expect(line, `숫자로 시간을 말한다: "${line}"`).not.toMatch(/\d/);
    }
  });

  it("이모지를 쓰지 않는다 (패널 톤 유지)", () => {
    for (const line of WAITING_SCENE_LINES) {
      expect(line).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe("waitingSceneAt — 경과 시간으로 도는 로테이션", () => {
  /**
   * ⚠️ 아래 계약들이 전부 `WAITING_SCENE_ROTATE_SEC` 로 파라미터화돼 있어서, 주기를 600초로
   * 늘려도 **유닛이 한 건도 안 죽는다**(독립검증 MIN-1 실측). 그러면 "지루함 해소"라는 목적만
   * 조용히 사라진다 — 그래서 **리터럴 밴드**를 따로 박는다.
   * 하한 2초: 읽는 중에 갈린다. 상한 8초: 짧은 대기(실측 6~14초)에서 한두 문장만 보고 끝난다.
   */
  it("회전 주기가 사람이 읽을 수 있는 밴드 안이다 (2~8초)", () => {
    expect(WAITING_SCENE_ROTATE_SEC).toBeGreaterThanOrEqual(2);
    expect(WAITING_SCENE_ROTATE_SEC).toBeLessThanOrEqual(8);
  });

  it(`${WAITING_SCENE_ROTATE_SEC}초마다 다음 문장으로 넘어간다`, () => {
    const R = WAITING_SCENE_ROTATE_SEC;
    expect(waitingSceneAt(0)).toBe(WAITING_SCENE_LINES[0]);
    // 같은 창 안에서는 문장이 흔들리지 않는다(1초 틱마다 바뀌면 읽을 수 없다).
    for (let s = 0; s < R; s++) expect(waitingSceneAt(s)).toBe(WAITING_SCENE_LINES[0]);
    expect(waitingSceneAt(R)).toBe(WAITING_SCENE_LINES[1]);
    expect(waitingSceneAt(R * 2)).toBe(WAITING_SCENE_LINES[2]);
  });

  it("풀을 한 바퀴 돌면 처음으로 돌아온다", () => {
    const n = WAITING_SCENE_LINES.length;
    const R = WAITING_SCENE_ROTATE_SEC;
    expect(waitingSceneAt(R * n)).toBe(WAITING_SCENE_LINES[0]);
    expect(waitingSceneAt(R * (n + 3))).toBe(WAITING_SCENE_LINES[3]);
  });

  it("풀 전체가 실제로 노출된다 (뒤쪽 문장이 죽어 있지 않다)", () => {
    const seen = new Set(
      WAITING_SCENE_LINES.map((_, i) => waitingSceneAt(i * WAITING_SCENE_ROTATE_SEC)),
    );
    expect(seen.size).toBe(WAITING_SCENE_LINES.length);
  });

  it("이상한 입력에도 문장을 준다 (화면이 비지 않는다)", () => {
    for (const bad of [-1, -999, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      expect(WAITING_SCENE_LINES).toContain(waitingSceneAt(bad));
    }
  });
});
