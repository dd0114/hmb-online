import type { RevengeEntry, RevengeResponse } from "../api/hooks-p286";

/**
 * 원정 복수 큐 — **순수 판정** (#286 W5, 설계 §4).
 *
 * ⚠️ **복수는 일부러 닫아 둔 문을 다시 여는 기능이다**(§4.1). V22 가 `away_offers` 주석에서
 * 지목 원정을 **어뷰징 경로**로 명시하며 닫았다. 복수는 그 문을 *"나를 친 상대에게만, 2회까지"*
 * 로 좁혀 다시 연다. 그래서 여기 규칙은 편의가 아니라 **자물쇠의 일부**다.
 *
 * ⚠️ 다만 **진짜 자물쇠는 서버에 있다**(403 `REVENGE_NOT_OWNED`). 이 파일이 하는 일은 버튼을
 * 잠그고 이유를 말해 주는 **안내**이지 방어가 아니다 — 클라 판정을 방어로 착각하면 서버 검사가
 * "중복이니 빼도 되는 것"으로 보이기 시작한다.
 */

export interface RevengeView {
  /** 그릴 게 있는가. false 면 화면은 이 구역을 통째로 생략한다. */
  usable: boolean;
  entries: RevengeEntry[];
  /** 원정 일일 한도와 **공유**한다(hero Q3-②). 모르면 null — 지어내지 않는다. */
  remainingToday: number | null;
}

/** 응답 정규화. 200 `{}` 를 주는 구 서버·프록시가 실재한다(#245·#251 전례). */
export function revengeView(data: RevengeResponse | undefined | null): RevengeView {
  const entries = Array.isArray(data?.entries)
    ? data!.entries.filter((e): e is RevengeEntry => Boolean(e) && typeof e.reportId === "string")
    : [];
  return {
    usable: entries.length > 0,
    entries,
    remainingToday: typeof data?.remainingToday === "number" ? data.remainingToday : null,
  };
}

/**
 * 한 건을 지금 칠 수 있나 — 못 치면 **이유**까지 준다.
 *
 * 버튼을 그냥 비활성으로 두면 유저는 "왜 안 되지"에서 멈춘다. 상태마다 다른 문장을 주는 것이
 * 이 함수의 존재 이유다(hero 확정: 복수의 복수는 없다 · 리포트당 2회 · 일일 횟수 공유).
 */
export function revengeAction(
  entry: RevengeEntry,
  remainingToday: number | null,
): { can: boolean; reason: string | null; label: string } {
  /**
   * ⚠️ **방어에 성공한 침공은 복수 대상이 아니다 — hero 확정 ④**(설계 §4.2·§4.3).
   *
   * 이 분기가 제일 먼저 오는 이유: 갚을 것이 애초에 없다. 빼먹으면 **이미 이긴 상대에게
   * 지목 원정 2판이 더 생긴다** — §4.1 이 좁혀서 여는 문(“나를 친 기록 1건당 2판”)을
   * hero 가 정한 것보다 넓게 여는 것이고, 그건 V22 가 닫았던 어뷰징 경로다.
   * 실제로 1차 구현에서 이 규칙이 통째로 빠졌고 독립검증 BL-1 이 잡았다.
   */
  if (entry.defenceResult === "WIN") {
    return { can: false, reason: "막아낸 경기입니다", label: "방어함" };
  }
  if (entry.state === "AVENGED") {
    return { can: false, reason: "복수 완료", label: "복수함" };
  }
  if (entry.state === "EXHAUSTED" || entry.attemptsUsed >= entry.attemptsMax) {
    return { can: false, reason: `${entry.attemptsMax}회 모두 도전했습니다`, label: "기회 소진" };
  }
  // ⚠️ 일일 한도는 **원정과 공유**다(hero Q3-②). 복수만 따로 세면 "복수로 무한 재도전"이 열린다.
  if (remainingToday !== null && remainingToday <= 0) {
    return { can: false, reason: "오늘 원정 횟수를 모두 썼습니다", label: "내일 가능" };
  }
  const left = entry.attemptsMax - entry.attemptsUsed;
  return { can: true, reason: null, label: left < entry.attemptsMax ? `복수 (${left}회 남음)` : "복수하러 가기" };
}

/**
 * 그때 무슨 일이 있었나 — 한 줄.
 *
 * ⚠️ **점수는 수비자(나) 관점으로 온다**(`theirScore`/`myScore`). 여기서 뒤집으면 유저는
 * 자기가 이긴 경기를 진 것으로 읽는다. 무승부도 침공으로 치는 것이 hero 확정이라
 * `DRAW` 가 큐에 남는 것이 정상이다.
 */
export function revengeSummary(entry: RevengeEntry): string {
  const score = `${entry.myScore} : ${entry.theirScore}`;
  const verdict =
    entry.defenceResult === "WIN" ? "막아냄" : entry.defenceResult === "DRAW" ? "무승부" : "실점 패";
  const delta =
    typeof entry.ratingDelta === "number" && entry.ratingDelta !== 0
      ? ` · 레이팅 ${entry.ratingDelta > 0 ? "+" : ""}${entry.ratingDelta}`
      : "";
  return `${score} ${verdict}${delta}`;
}
