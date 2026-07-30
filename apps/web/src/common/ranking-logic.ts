import type { RankingBoardResponse, RankRow } from "../api/hooks-p286";

/**
 * 랭킹보드 정규화 (#286 W5) — **순수**.
 *
 * ⚠️ 응답 형태를 믿지 않는다. 이 엔드포인트들은 **아직 서버에 없고**(#319 = W4), 그동안
 * 프록시·구 서버가 200 `{}` 를 줄 수 있다. `data.entries.map` 을 바로 부르면 그 순간
 * 원정·리그 화면이 **흰 화면**이 된다(#245 가 로비에서 똑같이 당했다).
 */
export interface RankingView {
  /** 그릴 게 있는가. false 면 화면은 **그 구역을 통째로 생략한다**(빈 껍데기 금지). */
  usable: boolean;
  entries: RankRow[];
  me: (Partial<RankRow> & { total?: number | null }) | null;
  seasonNo: number | null;
}

export function rankingView(data: RankingBoardResponse | undefined | null): RankingView {
  const entries = Array.isArray(data?.entries)
    ? data!.entries.filter((e): e is RankRow => Boolean(e) && typeof e.rank === "number")
    : [];
  const me = data?.me && typeof data.me === "object" ? data.me : null;
  return {
    // 내 순위만 있고 목록이 비는 경우도 있다(집계 전) — 둘 중 하나라도 있으면 그린다.
    usable: entries.length > 0 || me !== null,
    entries,
    me,
    seasonNo: typeof data?.seasonNo === "number" ? data.seasonNo : null,
  };
}

/**
 * 한 행의 **오른쪽 지표**. 원정은 레이팅(+연승), 리그는 승점(+경기수).
 *
 * ⚠️ 지표 이름을 화면에 박지 말고 여기서 고른다 — 같은 컴포넌트가 두 랭킹을 그리므로,
 * 화면이 분기하면 한쪽 규칙이 조용히 다른 쪽에 새 나간다.
 */
export function rankMetric(row: Partial<RankRow>, kind: "away" | "league"): string {
  if (kind === "away") {
    const rating = typeof row.rating === "number" ? `${row.rating}` : "—";
    return typeof row.streak === "number" && row.streak > 0
      ? `${rating} · ${row.streak}연승`
      : rating;
  }
  const points = typeof row.points === "number" ? `${row.points}점` : "—";
  return typeof row.played === "number" ? `${points} · ${row.played}경기` : points;
}

/** 내 순위 한 줄. 순위를 모르면 **지어내지 않는다**(집계 전이면 그 사실을 말한다). */
export function myRankLine(me: RankingView["me"], kind: "away" | "league"): string | null {
  if (!me) return null;
  if (typeof me.rank !== "number") return "아직 순위에 오르지 않았습니다";
  const total = typeof me.total === "number" ? ` / ${me.total}명` : "";
  return `${me.rank}위${total} · ${rankMetric(me, kind)}`;
}
