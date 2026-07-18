import type { Directive } from "./types.js";

/**
 * press-trigger — 압박 강도·트리거 라인. 기존 COACH_SYSTEM('하이라인·강한 압박', '로우블록'→pressAggression↓)
 * 인라인 지시를 카탈로그로 이식. 팀 pressingScheme + 개인 pressAggression 양쪽을 다룬다.
 */
export const pressTrigger: Directive = {
  id: "press-trigger",
  title: "압박/프레스 트리거",
  promptGuide: [
    "'강하게 압박', '전방부터 압박', '하이프레스' 류는 압박 강도·시작 지점 지시다.",
    "team.pressingScheme.intensity 를 높이고 triggerLine 을 상대 진영 쪽(높게)으로 올린다.",
    "특정 선수에게 앞선 압박을 맡기면 그 선수의 behavior.pressAggression 을 높인다.",
    "반대로 '내려서 수비', '로우블록', '압박 자제'면 intensity·triggerLine 을 낮추고 pressAggression 을 줄인다.",
  ].join(" "),
  outputFields: [
    "team.pressingScheme.intensity",
    "team.pressingScheme.triggerLine",
    "players[].behavior.pressAggression",
  ],
  contextNeeds: [],
  examples: [
    {
      instruction: "전방부터 강하게 압박",
      effect: "pressingScheme.intensity↑·triggerLine↑(상대 진영), 전방 자원 pressAggression↑.",
    },
    {
      instruction: "무리하지 말고 내려서 로우블록",
      effect: "pressingScheme.intensity↓·triggerLine↓, pressAggression↓(자기 진영 블록).",
    },
  ],
};
