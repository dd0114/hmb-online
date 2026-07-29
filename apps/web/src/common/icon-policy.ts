import { GRADE_ORDER, type Grade } from "./grades";

/**
 * 캐릭터 아트 노출 정책 — **판정은 여기 한 곳**이다 (#285, hero 확정 2026-07-29).
 *
 * 규칙: **다이아 이상만 얼굴이 뜬다.** 골드 이하는 덱 세팅·경기장 토큰·목록·카드 — 어디서도
 * 캐릭터 아트를 그리지 않고 등번호 / 팀색 마커 / 등급색+이니셜로 떨어진다.
 *
 * 왜 등급으로 판정하나: 이전 판정 근거는 `unitIsSharedDefault`(= "이 유닛이 등급 공용 디폴트냐")
 * 였다. 지금 데이터에선 공용 디폴트 = GOLD·SILVER·BRONZE 133명이라 **우연히** 같은 답을 내지만,
 * 발행측이 골드 한 명에게 고유 아트를 주는 순간 정책이 조용히 뚫린다. 정책은 등급이 결정하고,
 * 발행물은 "무슨 아트가 있나"만 말한다 — 두 축을 섞지 않는다.
 *
 * ⚠️ **등급 이름을 소비처에 적지 마라.** `grade === "GOLD" || …` 를 화면마다 쓰면 임계를 옮길 때
 * 조용히 어긋난다(#250 `FX_CONFIG.threshold` 와 같은 원칙). 임계를 바꾸려면 아래 한 줄만 고친다.
 */
export const CHAR_ART_MIN_GRADE: Grade = "DIA";

/**
 * 이 등급이 캐릭터 아트(얼굴 타일·풀아트·경기장 토큰 얼굴)를 노출하나.
 *
 * **등급 미상은 `false`(fail-closed)** — 등급을 못 읽는 경로에서 정책이 열리면 안 된다.
 * 아트가 없어도 화면은 성립하지만(이니셜·등번호 폴백), 정책이 뚫리면 그건 회귀다.
 */
export function showsCharacterArt(grade: Grade | null | undefined): boolean {
  if (!grade) return false;
  const at = GRADE_ORDER.indexOf(grade);
  const min = GRADE_ORDER.indexOf(CHAR_ART_MIN_GRADE);
  return at >= 0 && min >= 0 && at >= min;
}
