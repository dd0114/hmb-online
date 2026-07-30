/**
 * 실시간 통계 — 계산 정의는 **dev-viewer 의 검증된 순수 모듈(`stats.mjs`)이 SoT**이고,
 * 이 파일은 그것에 타입을 입혀 게임화면에 노출하는 얇은 표면이다.
 *
 * ⚠️ S1(#169) 한정 구조다. 재구현/복사 금지(§2 재발명 금지) — 계산을 옮기면 두 벌이 되어
 * QA(뷰어 HUD)와 게임화면 수치가 갈라진다. **S2(코어 추출)에서 `stats.mjs` 원본이 이 패키지로
 * 이동**하고, 그때 이 파일이 구현을 흡수하며 dev-viewer 가 여기서 import 하게 된다(방향 반전 완료).
 */
// 실시간 통계 순수 모듈(JSDoc 만 있음). S2 에서 dev-viewer → 이 패키지로 이동(방향 반전 완료).
// 아래에서 타입을 입혀 재수출한다. dev-viewer(QA)는 이 .mjs 를 인라인 소비.
import * as devViewerStats from "./stats.impl.mjs";
import type { LogEvent } from "./log-lines";

export interface TeamLiveStats {
  shots: number;
  onTarget: number;
  goals: number;
  offTarget: number;
  saves: number;
  xg: number;
  passCompleted: number;
  passAttempts: number;
  passPct: number;
  corners: number;
  fouls: number;
  offsides: number;
  yellow: number;
  red: number;
}

export interface LiveStats {
  home: TeamLiveStats;
  away: TeamLiveStats;
}

/** 점유 누적(스냅샷 인덱스별). */
export interface CumulativePossession {
  cumHome: number[];
  cumAway: number[];
}

interface DevViewerStats {
  liveEventStats(events: readonly LogEvent[], uptoTick: number): LiveStats;
  /**
   * ⚠️ `players`·`ball` 이 **필요하다**(#324). 소유팀은 `ballOwner` 문자열이 아니라 그 스냅샷의
   * players 에서 찾기 때문이다 — 예전 타입(`{ ballOwner }` 만)은 구현과 어긋난 **거짓 계약**이었고,
   * 그 상태로 캐스팅해 넘기면 타입은 통과하지만 런타임엔 점유가 0 으로 집계된다.
   */
  computeCumulativePossession(
    snaps: readonly {
      ballOwner?: string | null;
      // ⚠️ **필수다**(#324). optional 로 두면 요구가 주석으로만 남고 호출부는 `{ ballOwner }` 만
      // 캐스팅해도 컴파일을 통과한다 — 실제로 그 상태였고, 런타임엔 점유가 0 으로 집계된다.
      ball: { x: number; y: number };
      players: readonly { playerId: string; team?: string; pos: { x: number; y: number } }[];
    }[],
  ): CumulativePossession;
  possessionPct(cumHome: number[], cumAway: number[], idx: number): number;
  momentum(cumHome: number[], cumAway: number[], idx: number, window?: number): number;
}

const impl = devViewerStats as unknown as DevViewerStats;

/** 이벤트 시계열에서 uptoTick(포함)까지의 누적 팀 스탯. */
export const liveEventStats: DevViewerStats["liveEventStats"] = (events, uptoTick) =>
  impl.liveEventStats(events, uptoTick);

/** 스냅샷별 누적 점유(ballOwner) 카운트. */
export const computeCumulativePossession: DevViewerStats["computeCumulativePossession"] = (snaps) =>
  impl.computeCumulativePossession(snaps);

/** idx 까지의 홈 점유율(%). 소유 틱이 없으면 50. */
export const possessionPct: DevViewerStats["possessionPct"] = (cumHome, cumAway, idx) =>
  impl.possessionPct(cumHome, cumAway, idx);

/** 최근 window 스냅샷 기준 모멘텀(−1..1, 홈 양수). */
export const momentum: DevViewerStats["momentum"] = (cumHome, cumAway, idx, window) =>
  impl.momentum(cumHome, cumAway, idx, window);

/** tick → 스냅샷 인덱스(첫 `snap.tick >= tick`). 점유/모멘텀이 인덱스 기반이라 필요. */
export function snapshotIndexOfTick(snaps: readonly { tick: number }[], tick: number): number {
  if (snaps.length === 0) return 0;
  const i = snaps.findIndex((s) => s.tick >= tick);
  return i < 0 ? snaps.length - 1 : i;
}
