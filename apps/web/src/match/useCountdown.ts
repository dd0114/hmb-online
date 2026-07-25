import { useEffect, useState } from "react";
import { phaseRemainingMs, type MatchClock } from "@hmb/shared";

/**
 * 현재 단계의 잔여 시간(ms)을 0.5초마다 갱신한다 — 감독시간 카운트다운(P4-D2).
 * 시계가 없는 매치(레거시·롤백·라이브 아님)는 null = 카운트다운 비활성.
 *
 * `offsetMs` 는 폴링 때 잡아둔 서버-클라 시각차(live-clock.captureOffsetMs)다. 클라 시계가 틀어져
 * 있어도 서버가 실제로 후반을 시작하는 순간과 화면의 0:00 이 어긋나지 않게 한다.
 */
export function useCountdown(clock: MatchClock | null | undefined, offsetMs: number): number | null {
  const endsAt = clock?.phaseEndsAt ?? null;
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!endsAt) {
      setRemaining(null);
      return;
    }
    const update = () => setRemaining(phaseRemainingMs(clock ?? null, Date.now() + offsetMs));
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
    // clock 객체는 폴링마다 새로 오지만 값이 같으면 재시작할 이유가 없다 — 종료시각·오프셋만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endsAt, offsetMs]);

  return remaining;
}
