// @vitest-environment jsdom
/**
 * #477 — **어느 라우트도 게이트 밖으로 빠져나갈 수 없다** (3R · 패널 S2 반박).
 *
 * 패널이 두 번 같은 것을 짚었다: e2e 가 `/login`·`/home` 두 경로만 본다 = 나머지 라우트는
 * "게이트가 라우터 바깥이니 당연히 덮인다"는 **주장**으로만 덮여 있다. 라우트마다 e2e 를 하나씩
 * 다는 것은 그 주장을 표본으로 바꿀 뿐이고(12개를 달아도 13번째가 남는다) 비싸다.
 *
 * 그래서 표본이 아니라 **구조**를 검정한다 — outage 상태에서 App 을 어떤 URL 로 마운트해도
 * 라우터 트리가 **아예 렌더되지 않고** 점검 화면만 남는다. 이건 라우트 목록에 의존하지 않으므로
 * 새 라우트가 추가돼도 성질이 유지된다(그게 이 검정을 표본보다 강하게 만드는 지점이다).
 *
 * root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import {
  OUTAGE_CONFIRM_PROBES,
  __resetBackendHealth,
  __setBackendHealthDelay,
  getBackendHealth,
  reportBackendUnreachable,
  setBackendProbe,
} from "../api/backend-health";

/** App.tsx 의 라우트 표에 실제로 있는 경로들 + 매치·공유 딥링크 + 미등록 경로(캐치올). */
const ROUTES = [
  "/",
  "/login",
  "/home",
  "/game",
  "/away",
  "/deck",
  "/players",
  "/recruit",
  "/me",
  "/league",
  "/match/m-1",
  "/share/notice/n-1",
  "/admin",
  "/lobby",
  "/nonexistent-route",
];

const settle = async () => {
  for (let i = 0; i < OUTAGE_CONFIRM_PROBES + 4; i++) await Promise.resolve();
};

async function forceOutage() {
  __setBackendHealthDelay(() => Promise.resolve());
  setBackendProbe(async () => false);
  reportBackendUnreachable();
  await settle();
  expect(getBackendHealth()).toBe("outage"); // 전제가 성립했는지 먼저 확인
}

beforeEach(() => {
  __resetBackendHealth();
});

afterEach(() => {
  cleanup();
  __resetBackendHealth();
});

describe("MaintenanceGate — 라우트 전수", () => {
  it.each(ROUTES)("outage 면 %s 에서도 라우터 트리 대신 점검 화면만 렌더된다", async (path) => {
    window.history.pushState({}, "", path);
    await forceOutage();

    render(h(App));

    expect(screen.getByTestId("maintenance-screen")).toBeTruthy();
    // 라우터가 통째로 안 그려졌다는 것 — 어떤 화면의 조각도 남지 않는다.
    expect(screen.queryByTestId("app-nav")).toBeNull();
    expect(screen.queryByTestId("provider-choose")).toBeNull();
  });

  it.each(ROUTES)("정상(ok)이면 %s 에서 점검 화면이 뜨지 않는다", async (path) => {
    window.history.pushState({}, "", path);
    expect(getBackendHealth()).toBe("ok");

    render(h(App));

    // 게이트가 켜져 있지 않다 = 라우터가 산다(무엇이 그려지는지는 라우트별 관심사이고
    // e2e 가 본다. 여기서 볼 것은 "게이트가 상시 ON 으로 굳지 않았다" 하나다).
    expect(screen.queryByTestId("maintenance-screen")).toBeNull();
  });
});
