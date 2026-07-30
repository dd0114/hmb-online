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
  /**
   * 원정 일일 한도와 **공유**한다(hero Q3-②). 모르면 null — 지어내지 않는다.
   *
   * ⚠️ **무제한(-1)도 null 이다**(#332). 서버는 한도를 끄면(`hmb.away.match.daily-limit: 0`,
   * 명시된 롤백 스위치) `remainingToday: -1` 을 준다. 그 값을 숫자로 흘리면 소비처가
   * **-1 ≤ 0** 으로 읽어 복수 버튼을 전량 잠그고("오늘 원정 횟수를 모두 썼습니다") 표시도
   * "오늘 -1회 남음"이 된다 — **서버는 실제로 수락하는데** 화면이 기능을 죽인다.
   * 센티널은 여기서 **한 번만** 걸러 아래로 안 보낸다(소비처마다 다시 걸면 한 곳이 빠진다).
   */
  remainingToday: number | null;
  /** 한도가 꺼져 있는가 — "오늘 N회 남음"을 **아예 그리지 않기** 위한 신호(-1 을 렌더하지 않는다). */
  unlimited: boolean;
}

/**
 * 큐에 사는 최대 기록 수 (설계 §4.3 — 최근 5건 슬라이딩).
 *
 * ⚠️ **이 상수는 규칙이 아니라 표시 상한이다.** 슬라이딩 창의 주인은 서버 원장(`away_reports`)이고,
 * 어뷰징을 막는 것도 서버다(§4.1 조건 ①·②는 403 `REVENGE_NOT_OWNED`/`REVENGE_EXHAUSTED`).
 * 여기서 자르는 이유는 하나 — 서버가 회귀로 30건을 보내면 원정 화면이 **복수 목록 벽**이 되기
 * 때문이다. 자물쇠로 착각하지 마라(그 순간 서버 검사가 "중복이니 빼도 되는 것"으로 보인다).
 */
export const REVENGE_QUEUE_MAX = 5;

/** 응답 정규화. 200 `{}` 를 주는 구 서버·프록시가 실재한다(#245·#251 전례). */
export function revengeView(data: RevengeResponse | undefined | null): RevengeView {
  const entries = Array.isArray(data?.entries)
    ? data!.entries
        .filter((e): e is RevengeEntry => Boolean(e) && typeof e.reportId === "string")
        // 최신이 앞이라는 전제로 **앞에서** 자른다 — 뒤에서 자르면 방금 맞은 침공이 사라진다.
        .slice(0, REVENGE_QUEUE_MAX)
    : [];
  /**
   * ⚠️ 음수는 전부 센티널로 본다(`< 0`). `=== -1` 로 좁히면 서버가 다른 음수를 쓰는 순간
   * 같은 결함이 되돌아온다 — 남은 횟수가 음수인 상태는 어차피 의미가 없다.
   * 같은 도메인의 `AwayPage` 가 이미 `remainingToday >= 0` 으로 걸러 왔다(#286 W5 만 몰랐다).
   */
  const raw = typeof data?.remainingToday === "number" ? data.remainingToday : null;
  const unlimited = raw !== null && raw < 0;
  return {
    usable: entries.length > 0,
    entries,
    remainingToday: unlimited ? null : raw,
    unlimited,
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
