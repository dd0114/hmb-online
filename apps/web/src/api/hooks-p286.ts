import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import { useToken } from "../auth/TokenContext";

/**
 * #286 W5 — 원정 복수 · 랭킹보드 2종 · 모드별 전적 (**서버 신규 API 5종**, 계약 = #319 = W4).
 *
 * ⚠️ **서버보다 web 이 먼저 나간다 — 그래서 부재가 정상 상태다.**
 * 이 훅들이 가리키는 엔드포인트는 아직 서버에 없다. 그래도 화면을 지금 만드는 이유는 계약이
 * `docs/plan-v5/home-nav.md` §5 에 응답 형상까지 프리즈돼 있어서, 기다릴 이유가 없기 때문이다.
 * 대신 **부재가 라이브를 깨지 않는 것**이 이 파일의 제1 규칙이다:
 *
 *  · `retry: false` — 404 는 재시도해도 404 다. 무의미한 요청으로 로그를 더럽히지 않는다.
 *  · 소비하는 화면은 **`data` 가 없으면 그 구역을 통째로 그리지 않는다**(빈 껍데기·스켈레톤 금지).
 *    "아직 없는 기능"을 로딩 실패처럼 보이게 하면 유저는 앱이 고장 났다고 읽는다.
 *  · 응답 **형태를 믿지 않는다** — 200 `{}` 를 주는 구 서버·프록시가 실재한다(#245·#251 전례).
 *    정규화는 각 화면의 순수 로직이 하고, 배열이 아니면 빈 배열로 떨어진다.
 *
 * ⚠️ **목을 서버 형상에 맞추는 것이 계약의 절반이다**(#251: 클라가 지어낸 status 를 목이 쓰는
 * 바람에 "종료된 시즌 전부가 미지급으로 뜨는" 결함을 계약이 green 으로 덮었다). 여기 타입은
 * §5 의 JSON 을 그대로 옮긴 것이고, 서버가 다르게 주면 **서버가 계약 위반**이다.
 */

// ── 원정 복수 ──────────────────────────────────────────────────────────────

/** 복수 큐 한 건의 상태. `AVENGED` = 이미 갚음, `EXHAUSTED` = 2회 소진. */
export type RevengeState = "AVAILABLE" | "EXHAUSTED" | "AVENGED";

export interface RevengeEntry {
  reportId: string;
  opponent: { userId: string; nickname: string; rating?: number | null };
  attackedAt: string;
  /** 그때 결과 — **수비자(나) 관점**이다. */
  theirScore: number;
  myScore: number;
  /** 내가 막았나: WIN|DRAW|LOSS. */
  defenceResult: "WIN" | "DRAW" | "LOSS";
  ratingDelta: number;
  attemptsUsed: number;
  attemptsMax: number;
  state: RevengeState;
}

export interface RevengeResponse {
  entries: RevengeEntry[];
  /** 원정 일일 한도와 **공유**한다(hero Q3-②: 복수 판도 횟수를 먹는다). */
  remainingToday: number;
}

/** `GET /api/away/revenge` — 복수 큐 ≤5 + 남은 시도. */
export function useAwayRevenge(enabled = true) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["away", "revenge"],
    queryFn: () => apiFetch<RevengeResponse>("/api/away/revenge"),
    enabled: Boolean(token) && enabled,
    retry: false,
  });
}

/**
 * `POST /api/away/revenge/{reportId}/matches` — 지목 복수 경기 생성.
 *
 * ⚠️ **이 엔드포인트는 일부러 닫아 둔 문을 다시 여는 것이다**(설계 §4.1). V22 가 `away_offers`
 * 주석에서 지목 원정을 어뷰징 경로로 명시하며 닫았고, 복수는 그 문을 **"나를 친 상대에게만,
 * 2회까지"** 로 좁혀 다시 연다. 자물쇠는 서버에 있다(403 `REVENGE_NOT_OWNED`) — 클라가
 * 버튼을 숨기는 것은 안내이지 방어가 아니다.
 */
export function useStartRevengeMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reportId: string) =>
      apiFetch<{ id: string; state: string }>(
        `/api/away/revenge/${encodeURIComponent(reportId)}/matches`,
        { method: "POST" },
      ),
    // 성공하면 큐·리포트·활성 매치가 전부 바뀐다. 실패에도 무효화한다(429/410 이면 상태가
    // 이미 서버에서 바뀐 뒤다 — 화면이 옛 숫자를 계속 보여주면 유저가 다시 누른다).
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["away", "revenge"] });
      qc.invalidateQueries({ queryKey: ["awayReports"] });
      qc.invalidateQueries({ queryKey: ["activeMatch"] });
    },
  });
}

/** 복수 실패 문구. **서버 코드마다 다른 말을 해야** 유저가 다음 행동을 고를 수 있다. */
export function revengeError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "REVENGE_NOT_OWNED":
        return "이 경기는 나를 상대로 한 원정이 아닙니다";
      case "REVENGE_AVENGED":
        return "이미 복수한 상대입니다";
      case "REVENGE_EXHAUSTED":
        return "이 상대에게는 더 도전할 수 없습니다 (2회 소진)";
      case "AWAY_DAILY_LIMIT":
        return "오늘 원정 횟수를 모두 썼습니다 — 내일 다시 도전하세요";
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : "복수 경기를 시작하지 못했습니다";
}

// ── 랭킹보드 2종 ───────────────────────────────────────────────────────────

export interface RankRow {
  rank: number;
  userId: string;
  nickname: string;
  isMe: boolean;
  /** 원정 = 레이팅·연승 / 리그 = 승점·경기수·디비전. 화면이 무엇을 그릴지 정한다. */
  rating?: number | null;
  streak?: number | null;
  points?: number | null;
  played?: number | null;
  division?: number | null;
  divisionName?: string | null;
}

export interface RankingBoardResponse {
  seasonNo?: number | null;
  entries: RankRow[];
  me?: (Partial<RankRow> & { total?: number | null }) | null;
}

/** `GET /api/away/rankings` — 원정 레이팅 랭킹 + 내 순위. */
export function useAwayRankings(enabled = true) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["away", "rankings"],
    queryFn: () => apiFetch<RankingBoardResponse>("/api/away/rankings?limit=50"),
    enabled: Boolean(token) && enabled,
    retry: false,
  });
}

/** `GET /api/league/rankings` — 디비전 통합 랭킹 + 내 순위. */
export function useLeagueRankings(enabled = true) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["league", "rankings"],
    queryFn: () => apiFetch<RankingBoardResponse>("/api/league/rankings?scope=global&limit=50"),
    enabled: Boolean(token) && enabled,
    retry: false,
  });
}

// ── 모드별 전적 ────────────────────────────────────────────────────────────

export interface RecordBlock {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  /** 서버가 계산한 승률(0~1). ⚠️ 클라가 다시 나누지 않는다 — 무승부 취급이 서버 규칙이다. */
  winRate?: number | null;
}

export interface MyRecordResponse {
  overall: RecordBlock;
  byMode?: Partial<Record<"practice" | "league" | "away", RecordBlock>> | null;
  /** 최근 10경기, **최신이 앞**. */
  recentForm?: Array<"WIN" | "DRAW" | "LOSS"> | null;
  streak?: { current?: number | null; best?: number | null; awayBest?: number | null } | null;
}

/** `GET /api/me/record` — 모드별 전적 + 최근 폼. */
export function useMyRecord(enabled = true) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["me", "record"],
    queryFn: () => apiFetch<MyRecordResponse>("/api/me/record"),
    enabled: Boolean(token) && enabled,
    retry: false,
  });
}
