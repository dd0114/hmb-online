/**
 * 하프 리포트의 **평점 어댑터** — #421 이 소유하는 격리막 1파일 (W2 스텁 → **W7 플립**).
 *
 * ⚠️ **평점 산식의 SoT 는 #403 의 `apps/web/src/match/player-stats.ts` 다. 여기에 다시 만들지
 * 않는다(#57 재발명 금지).** 이 파일이 하는 일은 셋뿐이다:
 *  ① 손상 입력을 걸러 `computePlayerStats` 에 **모양이 맞는 것만** 넘긴다.
 *  ② 팀 필터(우리 팀 최고)를 얹는다 — #403 의 `motm` 원형은 **양 팀 통합 1명**이다.
 *  ③ 카드에 띄울 하이라이트 스탯을 `PlayerStatLine` 에서 고른다(값은 전부 #403 이 센 것).
 *
 * ── ② 우리 팀 최고인가, 양 팀 통합인가 ────────────────────────────────────────────────
 * #421 리포트는 유저가 **자기 팀 서사**를 읽는 화면이라 우리 팀 최고가 자연스럽다 →
 * `opts.team` 으로 **소비자가 고른다**(모듈 수정 불요). 현재 소비자 기본값 = **우리 팀**
 * (`myTeamSide` 를 아는 경우), 사이드를 모르면 필터 없이 양 팀 통합(= `result.motm` 그대로)으로
 * 떨어진다(거짓 소속을 지어내지 않는다).
 *
 * ⚠️ **팀 필터의 tie-break 는 #403 `pickMotm` 과 같은 전순서여야 한다** — 평점 → 골 → 어시스트 →
 * 키(`playerKey` 사전순). 그래야 같은 하프에서 화면이 항상 같은 사람을 고른다(결정론).
 * `pickMotm` 은 **export 되어 있지 않다**(모듈 내부 함수) → 그 순서를 여기 다시 적되, 근거는
 * `player-stats.ts` 의 그 함수 주석이다. **순서를 바꾸지 마라** — 바꾸면 팀 필터를 켠 화면과
 * 선수 탭의 MOTM 표식이 서로 다른 사람을 가리킬 수 있다.
 * (⚠️ `pickMotm` 이 언젠가 export 되면 이 블록을 지우고 그걸 부른다.)
 *
 * ── ③ UI 는 `null` 을 견뎌야 한다 ──────────────────────────────────────────────────────
 * 로그가 비었거나(아직 안 온 하프) 출전 기록이 하나도 없으면 여전히 `null` 이다. 그때 스택은
 * **1장(타임라인)** 으로 줄고 페이저·도트가 그에 맞게 사라진다 — `HalfReportModal.test.ts` 가
 * 그 성질을 계약으로 박는다. **손상 입력 경로는 사라지지 않았다.**
 */
import {
  computePlayerStats,
  findPlayerStat,
  playerKey,
  type PlayerPosition,
  type PlayerStatLine,
  type PlayerStatsResult,
  type StatMatchLog,
  type TeamSide,
} from "./player-stats";

/**
 * 하프 최고 평점 인물.
 *
 * `line` 은 #403 의 `PlayerStatLine`(골·어시·선방·키패스·태클·패스%·뛴거리) 그대로다 —
 * W2 시절 `unknown` 이던 자리를 **모듈이 머지된 지금** 좁혔다.
 */
export interface TopRated {
  team: TeamSide;
  playerId: string;
  rating: number;
  line: PlayerStatLine | null;
  /**
   * **양 팀 통합** 최우수(= #403 `result.motm`)와 같은 사람인가.
   * 팀 필터를 켜면 "우리 팀 최고"이지 "이 경기 최우수"가 아닐 수 있어서, 평점 뱃지 등급
   * (`player-stats-view.ratingTier`)이 이 값을 필요로 한다.
   */
  isMotm: boolean;
}

export interface TopRatedOptions {
  /** 이 팀에서만 고른다("home"|"away"). 생략하면 양 팀 통합(= #403 `motm` 원형). */
  team?: string;
  /**
   * `computePlayerStats` 로 그대로 넘어가는 평점 보정 입력. 소비자가 `player-stats-view` 의
   * `buildRosterMeta` → `gkKeysOf`/`positionsOf` 로 만든다(#57 — 여기서 로스터를 다시 짜지 않는다).
   * 없으면 보정 없이 계산한다(선수 탭과 값이 갈리므로 **주는 쪽이 옳다**).
   */
  gkKeys?: ReadonlySet<string>;
  positions?: Readonly<Record<string, PlayerPosition>>;
}

/**
 * 하프 로그 → 그 하프 최고 평점 인물. 모양이 아닌 입력·기록 없는 하프에는 `null`.
 *
 * 반환이 `null` 이라고 화면이 깨지면 안 된다 — 그게 이 함수의 두 번째 계약이다.
 */
export function topRatedOfHalf(halfLog: unknown, opts: TopRatedOptions = {}): TopRated | null {
  const log = asStatLog(halfLog);
  if (!log) return null;

  const result = computePlayerStats(log, {
    ...(opts.gkKeys ? { gkKeys: opts.gkKeys } : {}),
    ...(opts.positions ? { positions: opts.positions } : {}),
  });

  const side = opts.team === "home" || opts.team === "away" ? opts.team : null;
  const best = side ? pickTopOfTeam(result.players, side) : bestOf(result);
  if (!best) return null;

  return {
    team: best.team,
    playerId: best.playerId,
    rating: best.rating,
    line: findPlayerStat(result, best.team, best.playerId) ?? null,
    isMotm: result.motm?.key === playerKey(best.team, best.playerId),
  };
}

/** 팀 필터가 없을 때 = #403 이 이미 뽑아 둔 양 팀 통합 MOTM 을 그대로 쓴다. */
function bestOf(result: PlayerStatsResult): { team: TeamSide; playerId: string; rating: number } | null {
  return result.motm ? { team: result.motm.team, playerId: result.motm.playerId, rating: result.motm.rating } : null;
}

/**
 * 그 팀 최고 1명. **`pickMotm` 과 같은 전순서**(평점 → 골 → 어시스트 → 키) — 위 머리말 ② 참조.
 * 출전하지 않은 선수(`ticksPlayed <= 0`)는 후보가 아니다(원형과 동일).
 */
function pickTopOfTeam(players: readonly PlayerStatLine[], team: TeamSide): PlayerStatLine | null {
  let best: PlayerStatLine | null = null;
  for (const p of players) {
    if (p.team !== team) continue;
    if (p.ticksPlayed <= 0) continue;
    if (!best) {
      best = p;
      continue;
    }
    if (p.rating !== best.rating) {
      if (p.rating > best.rating) best = p;
      continue;
    }
    if (p.goals !== best.goals) {
      if (p.goals > best.goals) best = p;
      continue;
    }
    if (p.assists !== best.assists) {
      if (p.assists > best.assists) best = p;
      continue;
    }
    if (p.key < best.key) best = p;
  }
  return best;
}

/**
 * 손상 입력 방어 — **배열인 것만** 통과시킨다.
 *
 * ⚠️ `computePlayerStats` 는 `log.tickSnapshots ?? []` 로 받으므로 `null`·`undefined` 는 견디지만
 * **문자열·객체**가 들어오면 `.filter` 에서 던진다. 리포트가 화면을 죽이면 안 되므로 여기서 자른다
 * (구 서버·목의 `200 {}` 는 이 앱의 상시 입력이다 — apps/web CLAUDE.md).
 */
function asStatLog(v: unknown): StatMatchLog | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as { tickSnapshots?: unknown; events?: unknown };
  const snaps = Array.isArray(o.tickSnapshots) ? (o.tickSnapshots as StatMatchLog["tickSnapshots"]) : undefined;
  const events = Array.isArray(o.events) ? (o.events as StatMatchLog["events"]) : undefined;
  if (!snaps && !events) return null;
  return { tickSnapshots: snaps, events };
}

// ── 카드에 띄울 하이라이트 스탯 ─────────────────────────────────────────────

export interface HighlightStat {
  label: string;
  value: string;
}

/** 카드 한 장에 올릴 최대 개수 — 더 실으면 이름·평점이 밀린다(폰 390px). */
const MAX_HIGHLIGHTS = 4;

/**
 * 평점 옆에 붙일 **기록 요약**. 값은 전부 #403 이 센 것이고, 여기서 고르는 것은 **무엇을 말할까**뿐이다.
 *
 * · 0 인 항목은 싣지 않는다 — `골 0 · 어시스트 0` 은 정보가 아니라 소음이다.
 * · **골키퍼만 예외로 `실점` 을 0 이어도 싣는다** — 무실점은 그 자체가 성과다.
 * · 아무것도 안 남으면 패스·터치로 떨어진다(빈 줄을 남기지 않는다). 그것도 0 이면 `[]` —
 *   카드는 이름·평점만으로도 성립한다.
 *
 * ⚠️ 손상 입력(`line` 이 `null` 이거나 필드가 비었을 때)에 **던지지 않는다**: 숫자가 아닌 값은
 * 없는 것으로 본다.
 */
export function highlightStatsOf(
  line: PlayerStatLine | null | undefined,
  opts: { isGk?: boolean } = {},
): HighlightStat[] {
  if (!line || typeof line !== "object") return [];
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const out: HighlightStat[] = [];
  const push = (label: string, value: number, always = false): void => {
    if (out.length >= MAX_HIGHLIGHTS) return;
    if (value <= 0 && !always) return;
    out.push({ label, value: String(value) });
  };

  if (opts.isGk) {
    push("선방", n(line.saves), true);
    push("실점", n(line.goalsConceded), true);
  }
  push("골", n(line.goals));
  push("어시스트", n(line.assists));
  push("키패스", n(line.keyPasses));
  push("유효슛", n(line.shotsOnTarget));
  push("태클", n(line.tackles));
  push("가로채기", n(line.interceptions));
  push("걷어내기", n(line.clearances));

  if (out.length === 0) {
    push("패스 성공", n(line.passesCompleted));
    push("터치", n(line.touches));
  }
  return out;
}
