import type { Directive } from "./types.js";

/**
 * long-ball — 롱볼/다이렉트 플레이. passDirectness·passRisk 로 표현. (COACH_SYSTEM passDirectness 설명 이식)
 */
export const longBall: Directive = {
  id: "long-ball",
  title: "롱볼/다이렉트",
  promptGuide: [
    "'롱볼 위주', '길게 붙여', '다이렉트하게', '뒤로 넘겨' 류는 직선적 전개 지시다.",
    "관련 선수(주로 후방 빌드업 자원·타깃맨)의 behavior.passDirectness 를 높이고 passRisk 를 다소 올린다.",
    "팀 템포를 빠르게 가져가려는 의도면 team.tempo 도 함께 상향한다.",
  ].join(" "),
  outputFields: ["players[].behavior.passDirectness", "players[].behavior.passRisk", "team.tempo"],
  contextNeeds: [],
  examples: [
    {
      instruction: "빌드업 생략하고 롱볼로 빠르게",
      effect: "후방 자원 passDirectness↑·passRisk↑, team.tempo↑(짧은 빌드업 대신 직선 전개).",
    },
  ],
};
