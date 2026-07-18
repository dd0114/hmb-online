import type { Directive } from "./types.js";

/**
 * forward-run — 오프더볼 침투(전진 런). 기존 개인 지시 stub 의 '침투/런' 의미론 + COACH_SYSTEM
 * forwardRunFreq 설명을 카탈로그로 이식.
 */
export const forwardRun: Directive = {
  id: "forward-run",
  title: "침투(오프더볼 전진 런)",
  promptGuide: [
    "'침투해라', '뒷공간 노려', '적극적으로 뛰어 들어가' 류는 오프더볼 전진 침투 지시다.",
    "해당 선수의 behavior.forwardRunFreq 를 높이고, 공격 가담 깊이(supportDepth)도 함께 올린다.",
    "최전방·2선 공격 자원에 우선 적용하며, pace 가 받쳐줄 때 더 강하게 반영한다.",
  ].join(" "),
  outputFields: ["players[].behavior.forwardRunFreq", "players[].behavior.supportDepth"],
  contextNeeds: [],
  examples: [
    {
      instruction: "9번 계속 뒷공간 침투",
      effect: "지목된 공격수의 forwardRunFreq↑, supportDepth↑(라인 뒤 침투 빈도 상승).",
    },
  ],
};
