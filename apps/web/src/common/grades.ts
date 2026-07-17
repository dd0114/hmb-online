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

/** GOLD and above get the reveal highlight (AC-W3). */
export function isHighGrade(grade: Grade): boolean {
  return grade === "GOLD" || grade === "DIA" || grade === "LEGEND";
}
