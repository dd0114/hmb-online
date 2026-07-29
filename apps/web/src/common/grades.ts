import type { components } from "../api/schema";

export type Grade = components["schemas"]["Grade"];

export const GRADE_ORDER: Grade[] = ["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"];

export const GRADE_LABELS: Record<Grade, string> = {
  BRONZE: "브론즈",
  SILVER: "실버",
  GOLD: "골드",
  DIA: "다이아",
  LEGEND: "레전드",
};

/** Display colors per grade (codex cards + gacha reveal highlights). */
export const GRADE_COLORS: Record<Grade, string> = {
  BRONZE: "#b0793f",
  SILVER: "#b8c0cc",
  GOLD: "#f2c744",
  DIA: "#5ac8e8",
  LEGEND: "#c07cf5",
};

/**
 * **카드 주변 빛의 색** — 등급 *라벨* 색이 아니라 **프레임 아트**에 맞춘 값이다 (#250, hero 확정).
 *
 * 왜 `GRADE_COLORS` 와 갈라지는가: `GRADE_COLORS.LEGEND` 는 보라(`#c07cf5`)인데 발행된
 * `frame-LEGEND.png` 의 테두리는 **금색**이다(실측 지배색 `#ffbb22`/`#fba81f`). 라벨색을 그대로
 * 후광에 쓰면 **금 프레임 위에 보라 후광**이 얹혀 카드 안팎이 서로 싸운다. 그렇다고
 * `GRADE_COLORS` 를 바꾸면 도감·덱·트레이드의 등급 **글자색**까지 전부 따라 바뀐다 — 그건 다른 축이다.
 *
 * 나머지 등급은 라벨색이 프레임과 이미 같은 계열이라(DIA `#5ac8e8` ↔ 프레임 `#6ff5ff`,
 * GOLD `#f2c744` ↔ `#ffc425`) 그대로 쓴다. **프레임 에셋을 재발행해 색이 바뀌면 여기도 같이 본다.**
 */
export const GRADE_GLOW_COLORS: Record<Grade, string> = {
  ...GRADE_COLORS,
  LEGEND: "#ffbb22",
};

/** GOLD and above get the reveal highlight (AC-W3). */
export function isHighGrade(grade: Grade): boolean {
  return grade === "GOLD" || grade === "DIA" || grade === "LEGEND";
}
