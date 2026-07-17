import type { MatchLog } from "@hmb/shared";
import type { ResultCache } from "./ai/cache.js";
import { runMatchWithHomeInput } from "./pipeline.js";

/**
 * 리플레이 계약(에픽 #32 · W3 AC5): L1 결과캐시에 저장된 TacticalInput 은
 * "같은 seed + 같은 input → 같은 MatchLog" 를 보장하는 재현 번들이다.
 * fingerprint = 결정론 지문(마지막 tick hash + 스코어 + tick/event 수). desync 0 이면 동일.
 */
export interface MatchFingerprint {
  /** 마지막 틱 상태 해시 — 결정론 divergence 의 최종 지문. */
  lastHash: string;
  finalScore: { home: number; away: number };
  ticks: number;
  events: number;
}

export function matchFingerprint(log: MatchLog): MatchFingerprint {
  const last = log.tickSnapshots.at(-1);
  if (last === undefined) throw new Error("empty match log (no tick snapshots)");
  return {
    lastHash: last.hash,
    finalScore: { home: log.finalScore.home, away: log.finalScore.away },
    ticks: log.tickSnapshots.length,
    events: log.events.length,
  };
}

/** 두 지문이 동일한가(결정론 재현). */
export function fingerprintsEqual(a: MatchFingerprint, b: MatchFingerprint): boolean {
  return (
    a.lastHash === b.lastHash &&
    a.finalScore.home === b.finalScore.home &&
    a.finalScore.away === b.finalScore.away &&
    a.ticks === b.ticks &&
    a.events === b.events
  );
}

/**
 * L1 저장분(promptHash=id)으로 매치를 재현한다.
 * 저장된 TacticalInput 을 다시 검증(runMatchWithHomeInput 내부 parse)하고 결정론 엔진으로 재실행.
 * 캐시 미스면 throw — 재현 번들이 없다는 신호.
 */
export async function replayFromCache(cache: ResultCache, id: string, seed: string): Promise<MatchLog> {
  const stored = await cache.get(id);
  if (stored === null) throw new Error(`replay: no cached input for id=${id}`);
  return runMatchWithHomeInput(stored, seed);
}
