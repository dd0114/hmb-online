import type { Directive } from "./types.js";

/**
 * overlap — 풀백/윙어 오버랩(측면 전진 가담). 기존 coach.ts COACH_SYSTEM 인라인 예시("풀백 오버랩"→
 * widthTendency·forwardRunFreq↑)를 카탈로그로 이식.
 */
export const overlap: Directive = {
  id: "overlap",
  title: "오버랩(측면 전진 가담)",
  promptGuide: [
    "'풀백 오버랩', '측면 밀고 올라가', '윙백 공격 가담' 류는 측면 수비수/윙어의 전진 오버랩 지시다.",
    "해당 풀백(LB/RB)·윙어의 behavior.widthTendency 와 behavior.forwardRunFreq 를 높이고, 필요 시 team.width 를 넓힌다.",
    "pace/stamina 가 낮은 선수에게 과도한 오버랩을 부여하지 않는다(현실성).",
  ].join(" "),
  outputFields: ["players[].behavior.widthTendency", "players[].behavior.forwardRunFreq", "team.width"],
  contextNeeds: [],
  examples: [
    {
      instruction: "양쪽 풀백 적극적으로 오버랩",
      effect: "LB·RB 의 widthTendency·forwardRunFreq↑, team.width↑(측면 폭 확대).",
    },
  ],
};
