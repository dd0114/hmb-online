/**
 * 선수 기록 조회·집계 훅 (#403 W2) — 화면 둘(`PlayerStatsPanel` 탭 · `PlayerTouchCard` 피치 카드)이
 * **같은 결과**를 본다. 두 곳에서 따로 집계하면 같은 선수의 골 수가 화면 안에서 갈린다.
 *
 * ## 무엇을 언제까지 세나 (스포일러 · #233/#238)
 * **상한도 캡션도 `statsWindow` 하나가 정한다**(`player-stats-view.ts`) — 그 함수 주석이 규칙의
 * SoT 다. 여기서 상한을 다시 계산하지 마라(#233 독립검증 minor-1 이 정확히 그 형태였고,
 * #403 BL-1 은 상한과 캡션이 **따로 놀아서** 감독시간이 "7분까지의 기록" 위에 전 선수 0 을
 * 그린 사고였다).
 *  · 확정된 하프(감독시간의 전반 · 종료 후 양 하프) — **상한 없음**, 캡션 없음.
 *  · 진행 중 하프 — 플레이헤드까지, 캡션이 그 분을 말한다.
 *  · 진행 중인데 재생 위치 미상 — 그 하프는 세지 않고 "기다리는 중"이라고 말한다.
 *
 * ⚠️ 그래서 **통계(팀) 탭과 값이 다를 수 있다** — 통계 탭은 어느 상태에서든 "지금 재생 중인
 * 하프를 플레이헤드까지"만 본다(관전 동반 지표). 선수 탭은 **경기 기록**이라 축이 다르다
 * (요구 A 는 "하프"가 아니라 **경기** 진행분이다). 캡션이 그 경계를 말한다.
 *
 * ## 비용 — **보고 있을 때만 돈다**
 * `computePlayerStats` 는 O(스냅샷 × 선수)이고 증분이 아니다(모듈 주석). 그래서 ①하프별로 따로
 * 메모이즈하고(끝난 하프는 로그가 안 바뀌면 다시 안 돈다) ②`enabled` 가 거짓이면 **집계 자체를
 * 건너뛴다**.
 * ⚠️ ②를 "페치를 끄는 것"으로 구현했다가 독립검증에 잡혔다(MAJ-1): 같은 쿼리키를 `StageShell` 이
 * 이미 채워 두므로 `curLog` 는 **캐시에서 항상 채워지고** useMemo 는 그대로 돌았다 —
 * 실측 **탭 닫힘 상태에서 6초에 24회**. 주석이 지키는 게 아니라 `if (!enabled) return null` 이 지킨다.
 */
import { useMemo } from "react";
import { usePlayers, useHalfLog } from "../api/hooks";
import { halfForState } from "./stage/stage-state";
import { logAvailableFor } from "./live-clock";
import {
  combinePlayerStats,
  computePlayerStats,
  passAttributionCoverage,
  type PlayerStatsResult,
  type StatMatchLog,
} from "./player-stats";
import {
  buildRosterMeta,
  gkKeysOf,
  positionsOf,
  statsWindow,
  type RosterMeta,
  type StatsWindow,
} from "./player-stats-view";

export interface MatchPlayerStats {
  result: PlayerStatsResult | null;
  roster: ReadonlyMap<string, RosterMeta>;
  /** 패스 귀속 커버리지(0..1). null = 시도 0(아직 말할 것이 없다). */
  coverage: number | null;
  /**
   * 이 결과가 어떤 창에서 나왔나 — **상한과 캡션이 같이 들어 있다**(BL-1).
   * 화면은 `window.caption`/`window.shortLabel` 을 **그리기만** 한다. 분을 다시 조립하지 마라.
   */
  window: StatsWindow;
  isLoading: boolean;
  isError: boolean;
}

const EMPTY_ROSTER: ReadonlyMap<string, RosterMeta> = new Map();

export function useMatchPlayerStats(
  matchId: string | undefined,
  state: string | undefined,
  tick: number | null,
  /** 헤더 시계와 **같은 값**(로그가 구운 `minute`, #388 — `headerMinute` 이 준 것). 캡션에만 쓴다. */
  minute: number | null,
  /**
   * 지금 이 값을 쓰는 화면이 떠 있나(선수 탭이 열렸거나 요약 카드가 떠 있다).
   *
   * ⚠️ **끄는 것이 성능이 아니라 정확성 문제였다.** 이 집계는 O(스냅샷 × 선수)이고
   * **플레이헤드가 움직일 때마다** 다시 돈다(모듈 주석). 아무도 안 보는 동안에도 매 틱 수만 번을
   * 돌면 관전 프레임 예산을 먹는다. 계약 = `usePlayerStats.test.ts`(호출 횟수를 직접 센다).
   */
  enabled: boolean = true,
): MatchPlayerStats {
  const half = halfForState(state);

  const curEnabled = enabled && Boolean(matchId) && logAvailableFor(state, half);
  const { data: curLog, isLoading, isError } = useHalfLog(matchId, half, curEnabled);

  // 후반을 보는 중이면 전반도 같이 센다 — 요구 A 는 "하프"가 아니라 **경기** 진행분이다.
  const priorEnabled = enabled && Boolean(matchId) && half === 2 && logAvailableFor(state, 1);
  const { data: priorLog } = useHalfLog(matchId, 1, priorEnabled);

  // 카탈로그도 **보고 있을 때만** 받는다 — 선수 탭을 한 번도 안 여는 유저까지 110명을 내려받을
  // 이유가 없다(독립검증 m8). 이미 다른 화면이 받아 뒀으면 캐시라 왕복 0.
  const { data: catalog } = usePlayers(enabled);

  /**
   * 등번호는 **지금 무대가 그리는 하프의 로그**에서 뽑는다 — 경기장 토큰이 같은 규칙
   * (`viewer-skins.jerseyNumbers`)으로 번호를 달고 있어서, 표가 다른 하프로 번호를 매기면
   * 같은 선수가 한 화면에서 두 번호를 갖는다(유저는 토큰↔행을 번호로 잇는다).
   * 지난 하프에만 나온 선수(교체 아웃)는 이름·포지션만 그쪽에서 채운다.
   */
  const roster = useMemo(() => {
    if (!curLog && !priorLog) return EMPTY_ROSTER;
    const merged = new Map<string, RosterMeta>();
    if (priorEnabled && priorLog) {
      for (const [k, v] of buildRosterMeta(priorLog, catalog)) merged.set(k, { ...v, num: null });
    }
    for (const [k, v] of buildRosterMeta(curLog, catalog)) merged.set(k, v);
    return merged;
  }, [curLog, priorLog, priorEnabled, catalog]);

  const gkKeys = useMemo(() => gkKeysOf(roster), [roster]);
  const positions = useMemo(() => positionsOf(roster), [roster]);

  /**
   * 상한·캡션의 **단일 출처**(BL-1). 이 값 말고 다른 데서 창을 만들지 마라.
   * ⚠️ 객체 신원이 매 렌더 바뀌면 아래 useMemo 가 매번 다시 돈다 → 원시값으로 의존한다.
   */
  const win = useMemo(() => statsWindow(state, tick, minute), [state, tick, minute]);
  const upto = win.uptoTick;

  // 끝난 하프는 상한이 없고 로그도 안 바뀐다 → 플레이헤드가 흘러도 다시 돌지 않는다.
  const priorPart = useMemo(() => {
    if (!enabled || !priorEnabled || !priorLog) return null;
    return computePlayerStats(priorLog as unknown as StatMatchLog, { gkKeys, positions });
  }, [enabled, priorEnabled, priorLog, gkKeys, positions]);

  const curPart = useMemo(() => {
    // ⚠️ `!enabled` 가 여기 있어야 한다 — 페치를 끄는 것만으로는 캐시가 채워 줘서 안 막힌다(MAJ-1).
    if (!enabled || !curLog) return null;
    const opts = upto == null ? { gkKeys, positions } : { gkKeys, positions, uptoTick: upto };
    return computePlayerStats(curLog as unknown as StatMatchLog, opts);
  }, [enabled, curLog, upto, gkKeys, positions]);

  const result = useMemo(() => {
    const parts = [priorPart, curPart].filter((p): p is PlayerStatsResult => p != null);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0]!;
    return combinePlayerStats(parts, { positions });
  }, [priorPart, curPart, positions]);

  return {
    result,
    roster,
    coverage: result ? passAttributionCoverage(result) : null,
    window: win,
    isLoading: curEnabled && isLoading,
    isError: curEnabled && isError,
  };
}
