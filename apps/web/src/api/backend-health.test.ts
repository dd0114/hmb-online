/**
 * #477 — 백엔드 도달 불가 판별의 **오탐 방지**가 이 파일의 전부다.
 *
 * 점검 화면은 앱을 통째로 덮는다. 그래서 "한 번 실패했다"로 띄우면 지하철에서 잠깐 끊긴 유저
 * 전원에게 장애를 선언하는 셈이 된다 — 실제 장애보다 더 나쁜 오탐이다. 확정은 **확인 프로브가
 * 연속으로 전부 실패**했을 때만이고, 그 사이 어디서든 성공 신호가 오면 즉시 취소된다.
 *
 * 프로브·딜레이는 주입한다(실제 타이머 대기 없이 상태기계만 검정).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OUTAGE_CONFIRM_PROBES,
  RECHECK_INTERVAL_MS,
  __resetBackendHealth,
  __setBackendHealthDelay,
  getBackendHealth,
  reportBackendReachable,
  reportBackendUnreachable,
  retryBackendNow,
  setBackendProbe,
  subscribeBackendHealth,
} from "./backend-health";

/** 상태기계만 보면 되므로 대기는 즉시 통과시킨다. */
const noWait = () => Promise.resolve();

/** confirm 루프가 도는 사이 마이크로태스크를 비워 준다. */
const settle = async () => {
  for (let i = 0; i < OUTAGE_CONFIRM_PROBES + 4; i++) await Promise.resolve();
};

beforeEach(() => {
  __resetBackendHealth();
  __setBackendHealthDelay(noWait);
});

describe("backend-health — outage 확정", () => {
  it("단발 실패로는 점검이 되지 않는다 — 확인 프로브가 성공하면 ok 를 유지한다", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    setBackendProbe(probe);
    const seen: string[] = [];
    subscribeBackendHealth((s) => seen.push(s));

    reportBackendUnreachable();
    await settle();

    expect(getBackendHealth()).toBe("ok");
    expect(seen).not.toContain("outage");
    expect(probe).toHaveBeenCalledTimes(1); // 첫 프로브가 살아 있으면 더 두드리지 않는다
  });

  it("확인 프로브가 연속 전부 실패해야 outage 로 확정한다", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    setBackendProbe(probe);
    const seen: string[] = [];
    subscribeBackendHealth((s) => seen.push(s));

    reportBackendUnreachable();
    await settle();

    expect(getBackendHealth()).toBe("outage");
    expect(probe).toHaveBeenCalledTimes(OUTAGE_CONFIRM_PROBES);
    expect(seen.at(-1)).toBe("outage");
  });

  it("마지막 프로브만 성공해도 outage 가 아니다 — '전부 실패' 가 조건이다", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    setBackendProbe(probe);

    reportBackendUnreachable();
    await settle();

    expect(getBackendHealth()).toBe("ok");
  });

  it("확인 중 정상 응답이 오면 프로브가 실패해도 outage 로 가지 않는다", async () => {
    // 프로브는 계속 실패하지만, 다른 요청이 성공해 reportBackendReachable 이 먼저 온 경우.
    const probe = vi.fn().mockImplementation(async () => {
      reportBackendReachable();
      return false;
    });
    setBackendProbe(probe);

    reportBackendUnreachable();
    await settle();

    expect(getBackendHealth()).toBe("ok");
  });

  /**
   * 부분 장애를 outage 로 확정하지 않는 것은 **의도된 설계**다(패널 S2 가 두 번 지적했다).
   *
   * 엔드포인트 하나가 죽었는데 카나리아(`/api/config`)가 살아 있으면 점검 화면은 뜨지 않는다.
   * 앱 전체를 덮으면 멀쩡한 기능까지 못 쓰게 되고, 그 화면의 에러 처리는 그 화면이 맡는다.
   * 우연히 그렇게 동작하는 것과 그렇게 하기로 정한 것은 다르므로 여기에 못을 박는다 —
   * 바꾸려는 사람은 이 테스트를 지우면서 바꿔야 한다.
   */
  it("부분 장애(카나리아는 살아 있음)는 outage 로 확정하지 않는다 — 의도된 설계", async () => {
    const canaryAlive = vi.fn().mockResolvedValue(true);
    setBackendProbe(canaryAlive);

    // 어떤 화면의 요청 하나가 502 로 죽어 실패를 보고했다.
    reportBackendUnreachable();
    await settle();

    expect(getBackendHealth()).toBe("ok"); // 앱 전체를 덮지 않는다
  });

  it("확인이 진행 중이면 실패 보고가 새 확인을 중복 기동하지 않는다", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    setBackendProbe(probe);

    reportBackendUnreachable();
    reportBackendUnreachable();
    reportBackendUnreachable();
    await settle();

    expect(probe).toHaveBeenCalledTimes(OUTAGE_CONFIRM_PROBES);
  });
});

describe("backend-health — 복구", () => {
  it("outage 중 정상 응답을 받으면 ok 로 돌아온다", async () => {
    setBackendProbe(async () => false);
    reportBackendUnreachable();
    await settle();
    expect(getBackendHealth()).toBe("outage");

    reportBackendReachable();
    expect(getBackendHealth()).toBe("ok");
  });

  it("retryBackendNow: 프로브 성공이면 true + ok 복귀, 실패면 false + outage 유지", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    setBackendProbe(probe);
    reportBackendUnreachable();
    await settle();
    expect(getBackendHealth()).toBe("outage");

    await expect(retryBackendNow()).resolves.toBe(false);
    expect(getBackendHealth()).toBe("outage");

    probe.mockResolvedValue(true);
    await expect(retryBackendNow()).resolves.toBe(true);
    expect(getBackendHealth()).toBe("ok");
  });

  it("자동 재확인: 유저가 아무것도 안 해도 백엔드가 살아나면 돌아온다", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn().mockResolvedValue(false);
      setBackendProbe(probe);
      reportBackendUnreachable();
      await settle(); // confirm 프로브는 주입된 noWait 로 즉시 진행
      expect(getBackendHealth()).toBe("outage");

      probe.mockResolvedValue(true); // 워치독이 터널을 되살렸다
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS + 10);

      expect(getBackendHealth()).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("정상 복귀하면 재확인 타이머가 남지 않는다", async () => {
    vi.useFakeTimers();
    try {
      setBackendProbe(async () => false);
      reportBackendUnreachable();
      await settle();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      reportBackendReachable();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("구독 해지 후에는 통지가 오지 않는다", async () => {
    setBackendProbe(async () => false);
    const seen: string[] = [];
    const off = subscribeBackendHealth((s) => seen.push(s));
    off();

    reportBackendUnreachable();
    await settle();

    expect(seen).toEqual([]);
    expect(getBackendHealth()).toBe("outage");
  });
});
