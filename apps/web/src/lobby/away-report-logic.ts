/**
 * 원정 리포트 화면 로직(#245) — 순수 함수만. 렌더에서 분리해 테스트로 박제한다.
 *
 * ⚠️ **집계는 서버가 SoT 다**(`GET /api/me/away-reports` 의 `summary`). 여기 있는 것은 그 숫자를
 * 문장으로 바꾸는 일뿐 — 승/무/패나 득실을 클라가 다시 세지 않는다. 다시 세면 규칙이 바뀔 때
 * 화면과 서버가 조용히 어긋난다(#217 에서 확인된 원칙).
 */

export interface AwayReport {
  id: string;
  matchId: string;
  attackerName: string;
  goalsFor: number;
  goalsAgainst: number;
  result: "WIN" | "DRAW" | "LOSS";
  ratingDelta: number;
  createdAt: string;
  seen: boolean;
}

export interface AwaySummary {
  matches: number;
  opponents: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  ratingDelta: number;
}

export interface AwayReportsResponse {
  reports: AwayReport[];
  summary: AwaySummary;
  rating: number;
  unseen: number;
}

/**
 * 팝업을 띄울까 — 미확인이 0이면 빈 모달을 띄우지 않는다.
 *
 * ⚠️ **응답 형태를 믿지 않는다.** 이 엔드포인트가 없는 구 서버(또는 프록시)가 200 `{}` 를 주면
 * `data.reports.length` 가 예외를 던져 **로비 전체가 흰 화면**이 된다 — 부가 기능 하나가 앱의
 * 진입점을 죽이는 건 어떤 경우에도 허용되지 않는다(#217 회귀 스펙이 실제로 이걸 잡았다).
 * 그래서 배열·요약이 실제로 있는지까지 확인한 뒤에만 연다.
 */
export function shouldShowAwayPopup(data: AwayReportsResponse | undefined): boolean {
  return Boolean(
    data && Array.isArray(data.reports) && data.reports.length > 0 && data.summary,
  );
}

/**
 * 헤드라인(요구 1+3) — "누구에게 당했고 어땠나"를 한 줄로.
 * 단건이면 상대 이름을, 다건이면 팀 수를 말한다(이름을 나열하면 리스트와 중복이다).
 */
export function headline(summary: AwaySummary, reports: AwayReport[]): string {
  if (summary.matches === 0) return "";
  const only = reports[0];
  if (summary.matches === 1 && only) {
    const verdict =
      only.result === "WIN" ? "막아냈습니다" : only.result === "LOSS" ? "패했습니다" : "비겼습니다";
    return `${only.attackerName}이(가) 원정을 왔고, ${verdict}`;
  }
  return `${summary.opponents}팀이 우리 홈구장을 찾아왔습니다 — ${recordText(summary)}`;
}

/** "1승 2패" — 0인 항목은 빼서 짧게. 전부 0이면(있을 수 없지만) "0경기". */
export function recordText(summary: AwaySummary): string {
  const parts: string[] = [];
  if (summary.wins > 0) parts.push(`${summary.wins}승`);
  if (summary.draws > 0) parts.push(`${summary.draws}무`);
  if (summary.losses > 0) parts.push(`${summary.losses}패`);
  return parts.length > 0 ? parts.join(" ") : `${summary.matches}경기`;
}

/** 레이팅 증감 표기 — 0 도 부호 없이 "0" 이 아니라 "±0" 으로 두면 변동 없음이 드러난다. */
export function ratingDeltaText(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `${delta}`;
  return "±0";
}

/**
 * 몰수인가 — <b>0:0 인데 무승부가 아니면</b> 몰수다(#245 D1: 원정 자발적 포기 = 몰수패).
 * 실제로 뛴 0:0 은 언제나 DRAW 이므로 이 조합은 몰수에서만 나온다 — 별도 필드 없이 구분된다.
 */
export function isForfeit(report: Pick<AwayReport, "goalsFor" | "goalsAgainst" | "result">): boolean {
  return report.goalsFor === 0 && report.goalsAgainst === 0 && report.result !== "DRAW";
}

/** 승/무/패 → 짧은 뱃지 글자(리스트 행 앞). */
export function resultBadge(result: AwayReport["result"]): string {
  return result === "WIN" ? "승" : result === "LOSS" ? "패" : "무";
}
