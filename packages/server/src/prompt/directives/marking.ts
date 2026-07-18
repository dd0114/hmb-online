import type { Directive } from "./types.js";

/**
 * marking — 전담 마크. 카탈로그의 핵심 지시(AC-C2). markTarget 매핑 + 복수 마킹 + opponentRoster 필요.
 * "손흥민 막아" / "메시랑 음바페 둘 다 마크해" 류를 해당 상대 playerId 로 해석해 수비수 markTarget 에 배정.
 */
export const marking: Directive = {
  id: "marking",
  title: "전담 마크(마킹)",
  promptGuide: [
    "감독이 특정 상대 선수를 지목하며 '막아라/마크해라/전담해라'라고 하면 대인 마킹 지시다.",
    "상대 선수 이름은 opponentRoster 에서 playerId 로 해석한다(이름 부분 일치 허용, 대소문자·공백 무시).",
    "가장 적합한 우리 수비수/수비형 미드필더의 players[].markTarget 에 그 상대 playerId 를 넣는다(태클·포지셔닝·pace 를 고려).",
    "복수 지목('둘 다 마크')이면 복수의 서로 다른 수비수에게 각 대상을 1:1 로 분배한다 — 한 수비수에 여러 markTarget 금지, 한 대상에 여러 수비수 금지.",
    "지목 대상이 opponentRoster 에 없거나 opponentRoster 가 제공되지 않으면 마킹을 생략한다(존재하지 않는 id 를 지어내지 말 것).",
  ].join(" "),
  outputFields: ["players[].markTarget"],
  contextNeeds: ["opponentRoster"],
  examples: [
    {
      instruction: "손흥민 막아",
      effect:
        "opponentRoster 에서 '손흥민'의 playerId 를 찾아, 대인 수비가 강한 우리 수비수 1명의 markTarget 에 설정.",
    },
    {
      instruction: "메시랑 음바페 둘 다 마크해",
      effect:
        "두 상대 playerId 를 서로 다른 두 수비수의 markTarget 에 각각 배정(1:1 분배, 중복 없음).",
    },
  ],
};
