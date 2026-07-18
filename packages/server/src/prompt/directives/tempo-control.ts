import type { Directive } from "./types.js";

/**
 * tempo-control — 경기 템포·라인 높이 조절. team.tempo·defensiveLineHeight·compactness 로 표현.
 * (COACH_SYSTEM '하이라인'→defensiveLineHeight↑, '로우블록'→compactness↑ 인라인 지시 이식)
 */
export const tempoControl: Directive = {
  id: "tempo-control",
  title: "템포/라인 높이 조절",
  promptGuide: [
    "'빠른 템포로', '천천히 점유', '하이라인', '라인 내려' 류는 경기 속도·수비 라인 높이 지시다.",
    "빠른 템포는 team.tempo↑, 느린 점유는 team.tempo↓.",
    "하이라인은 team.defensiveLineHeight↑, 라인 하강은 defensiveLineHeight↓ + compactness↑(간격 압축).",
    "'수비 컴팩트하게'는 compactness↑, '넓게 벌려'는 team.width↑.",
  ].join(" "),
  outputFields: ["team.tempo", "team.defensiveLineHeight", "team.compactness", "team.width"],
  contextNeeds: [],
  examples: [
    {
      instruction: "하이라인에 빠른 템포",
      effect: "team.defensiveLineHeight↑, team.tempo↑(전방 압박형 빠른 전개).",
    },
    {
      instruction: "라인 내리고 천천히 점유",
      effect: "defensiveLineHeight↓·compactness↑, team.tempo↓(안정 지향).",
    },
  ],
};
