// @vitest-environment jsdom
/**
 * TutorialProvider 진행 계약 (PRD-v4 §B): 자동 시작 → 다음 → 완료 저장 / 건너뛰기 /
 * 대상 부재 스텝 자동 스킵 / ESC=건너뛰기 / 다시보기.
 *
 * 훅(useMe·useToken)은 wholesale mock — 쿼리/네트워크 없이 상태 기계만 본다.
 * jsdom 은 레이아웃이 없어 getBoundingClientRect 가 전부 0 이므로, 대상 testid 별 rect 를
 * 주입해 "존재/부재"를 표현한다(부재 = rect 없음 → 스킵 경로).
 *
 * root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TutorialStep } from "./tutorial-steps";

const fx = {
  token: "t" as string | null,
  user: { id: "u1" } as { id: string; tutorialDone?: boolean } | undefined,
  /** /api/me 자체가 아직 안 왔거나 user 없이 온 경우를 표현. */
  meMissing: false,
};

vi.mock("../api/hooks", () => ({
  useMe: () => ({
    data: fx.meMissing ? {} : { user: fx.user, wallet: { points: 0 }, records: {} },
  }),
}));

vi.mock("../auth/TokenContext", () => ({
  useToken: () => ({ token: fx.token, provider: null, login: vi.fn(), logout: vi.fn() }),
}));

const { TutorialProvider } = await import("./TutorialProvider");
const { markTutorialPending, readLocalDone, persistTutorialDone, clearTutorialPending } =
  await import("./tutorial-storage");

/** 화면에 "존재"하는 대상들의 rect. 여기 없는 testid = DOM 에 없거나 크기 0 = 스킵 대상. */
const rects: Record<string, { left: number; top: number; width: number; height: number }> = {};

function stubRects() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const id = this.getAttribute("data-testid") ?? "";
    const r = rects[id] ?? { left: 0, top: 0, width: 0, height: 0 };
    return {
      ...r,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
      toJSON: () => r,
    } as DOMRect;
  });
}

/** 대상이 항상 존재하는 스텝만 — "끝까지 진행하면 저장" 계약 검증용. */
const REACHABLE_STEPS: TutorialStep[] = [
  { id: "s1", targetTestId: "t1", title: "첫 번째", body: "b1", enabled: true },
  { id: "s2", targetTestId: "t2", title: "두 번째", body: "b2", enabled: true },
];

/** 중간에 **대상이 아예 없는** 스텝을 끼운 세트 — 스킵/미시청 계약 검증용. */
const STEPS: TutorialStep[] = [
  { id: "s1", targetTestId: "t1", title: "첫 번째", body: "b1", enabled: true },
  { id: "gone", targetTestId: "missing", title: "없는 대상", body: "b?", enabled: true },
  { id: "s2", targetTestId: "t2", title: "두 번째", body: "b2", enabled: true },
  { id: "off", targetTestId: "disabled-stub", title: "stub", body: "b!", enabled: false },
];

/**
 * 프로바이더는 useLocation 을 쓰고(자동 시작은 로비 경로에서만) 대상 부재 유예를 갖는다.
 * 유닛에서는 유예 0 = 즉시 스킵으로 두어 동기 단언이 가능하게 한다.
 */
/** 라우트 이동 버튼 — 프로바이더를 **언마운트하지 않고** 화면 전환을 흉내낸다. */
function Nav() {
  const navigate = useNavigate();
  return h(
    "div",
    null,
    h(
      "button",
      { type: "button", "data-testid": "go-away", onClick: () => navigate("/shop") },
      "떠나기",
    ),
    h(
      "button",
      { type: "button", "data-testid": "go-deck", onClick: () => navigate("/deck") },
      "덱",
    ),
    h(
      "button",
      { type: "button", "data-testid": "go-lobby", onClick: () => navigate("/lobby") },
      "로비",
    ),
  );
}

function tree(steps: TutorialStep[], extra: ReturnType<typeof h>[], missingGraceMs = 0) {
  return h(
    MemoryRouter,
    { initialEntries: ["/lobby"] },
    h(
      TutorialProvider,
      { steps, missingGraceMs },
      h("button", { type: "button", "data-testid": "t1" }, "대상1"),
      h("button", { type: "button", "data-testid": "t2" }, "대상2"),
      h("button", { type: "button", "data-testid": "t3" }, "대상3"),
      h(Nav, { key: "nav" }),
      ...extra,
    ),
  );
}

function renderApp(
  steps: TutorialStep[] = STEPS,
  extra: ReturnType<typeof h>[] = [],
  /** 기본 0 = 즉시 스킵(동기 단언용). 유예의 **체감**을 봐야 하는 테스트만 올려 쓴다. */
  missingGraceMs = 0,
) {
  const utils = render(tree(steps, extra, missingGraceMs));
  return {
    ...utils,
    /** 훅 모킹(fx)을 바꾼 뒤 같은 인스턴스를 다시 렌더한다(언마운트 없음). */
    refresh: () => utils.rerender(tree(steps, extra, missingGraceMs)),
  };
}

/** 대상이 모두 사라진 채 다른 화면으로 이동 — 실제 이탈과 같은 경로. */
function leaveScreen() {
  act(() => {
    delete rects.t1;
    delete rects.t2;
    window.dispatchEvent(new Event("resize"));
  });
  act(() => {
    fireEvent.click(screen.getByTestId("go-away"));
  });
}

function returnToLobby() {
  act(() => {
    rects.t1 = { left: 40, top: 100, width: 120, height: 44 };
    rects.t2 = { left: 40, top: 200, width: 120, height: 44 };
    fireEvent.click(screen.getByTestId("go-lobby"));
  });
}

beforeEach(() => {
  localStorage.clear();
  clearTutorialPending();
  fx.token = "t";
  fx.user = { id: "u1" };
  fx.meMissing = false;
  for (const k of Object.keys(rects)) delete rects[k];
  rects.t1 = { left: 40, top: 100, width: 120, height: 44 };
  rects.t2 = { left: 40, top: 200, width: 120, height: 44 };
  rects["tutorial-bubble"] = { left: 0, top: 0, width: 320, height: 150 };
  stubRects();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("자동 시작 (AC-B1)", () => {
  it("신규 신호가 있으면 첫 스텝부터 시작한다", () => {
    markTutorialPending();
    renderApp();
    expect(screen.getByTestId("tutorial-overlay")).toBeTruthy();
    expect(screen.getByTestId("tutorial-title").textContent).toBe("첫 번째");
  });

  it("신규 신호가 없으면 뜨지 않는다 (기존 유저 무회귀)", () => {
    renderApp();
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
  });

  it("이미 완료한 계정은 신규 신호가 있어도 뜨지 않는다 (재로그인 미노출)", () => {
    persistTutorialDone("u1");
    markTutorialPending();
    renderApp();
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
  });

  it("서버가 tutorialDone=true 를 주면 로컬과 무관하게 뜨지 않는다", () => {
    markTutorialPending();
    fx.user = { id: "u1", tutorialDone: true };
    renderApp();
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
  });

  it("서버가 tutorialDone=false 를 주면 신규 신호 없이도 시작한다", () => {
    fx.user = { id: "u1", tutorialDone: false };
    renderApp();
    expect(screen.getByTestId("tutorial-overlay")).toBeTruthy();
  });

  it("다른 계정의 완료 표시에 간섭받지 않는다", () => {
    persistTutorialDone("other-user");
    markTutorialPending();
    renderApp();
    expect(screen.getByTestId("tutorial-overlay")).toBeTruthy();
  });
});

describe("진행", () => {
  it("'다음' 은 대상이 없는 스텝을 건너뛰고 다음 대상으로 간다", () => {
    markTutorialPending();
    renderApp();
    expect(screen.getByTestId("tutorial-title").textContent).toBe("첫 번째");

    fireEvent.click(screen.getByTestId("tutorial-next"));

    // 두 번째 스텝(대상 없음)은 표시되지 않고 곧바로 세 번째로.
    expect(screen.getByTestId("tutorial-title").textContent).toBe("두 번째");
  });

  it("진행 표시는 실행 대상(enabled) 스텝 수를 쓴다", () => {
    markTutorialPending();
    renderApp();
    expect(screen.getByTestId("tutorial-progress").textContent).toBe("1 / 3");
  });

  it("모든 스텝을 다 보여준 뒤 '시작하기' → 오버레이 종료 + 완료 저장", () => {
    markTutorialPending();
    renderApp(REACHABLE_STEPS);
    fireEvent.click(screen.getByTestId("tutorial-next")); // → s2 (마지막)
    expect(screen.getByTestId("tutorial-next").textContent).toBe("시작하기");

    fireEvent.click(screen.getByTestId("tutorial-next"));
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
    expect(readLocalDone("u1")).toBe(true);
  });

  /**
   * 대상이 **영영 없는** 스텝이 섞이면 끝까지 눌러도 저장하지 않는다.
   * (그 스텝을 보여준 적이 없으므로 — 유저는 '건너뛰기'로만 명시적으로 끝낼 수 있다.)
   */
  it("한 스텝이라도 못 보여줬으면 '다음'을 끝까지 눌러도 저장하지 않는다", () => {
    markTutorialPending();
    renderApp(); // "gone" 포함
    fireEvent.click(screen.getByTestId("tutorial-next")); // gone 스킵 → s2
    expect(screen.getByTestId("tutorial-title").textContent).toBe("두 번째");

    fireEvent.click(screen.getByTestId("tutorial-next"));
    expect(readLocalDone("u1")).toBe(false);
  });

  it("모든 대상이 사라지면 무한 대기 없이 종료된다 — 단 완료로 저장하지 않는다", () => {
    delete rects.t1;
    delete rects.t2;
    markTutorialPending();
    renderApp();
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
    // 유저가 끝낸 게 아니다 — 저장했다면 온보딩을 영구히 잃는다(blocker).
    expect(readLocalDone("u1")).toBe(false);
  });

  it("진행 중 대상이 사라져 중단돼도 완료로 저장하지 않는다", () => {
    markTutorialPending();
    renderApp();
    expect(screen.getByTestId("tutorial-title").textContent).toBe("첫 번째");

    // 유저가 하이라이트된 버튼을 눌러 다른 화면으로 갔다고 가정 — 남은 대상 전부 소실.
    act(() => {
      delete rects.t1;
      delete rects.t2;
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
    expect(readLocalDone("u1")).toBe(false);
  });

  /**
   * ⚠️ 프로바이더를 **언마운트하지 않고** 검증한다. 언마운트하면 resumeIndex ref 가
   * 초기화돼 "재개 인덱스"를 사실상 검증하지 못한다(그래서 계정전환 버그를 놓쳤다).
   */
  it("못 본 스텝을 남기고 이탈하면 저장 없이 중단되고, 돌아오면 그 스텝부터 재개한다", () => {
    markTutorialPending();
    renderApp(REACHABLE_STEPS);
    // s1 만 본 상태에서 이탈 → s2 는 아직 못 봤다.
    expect(screen.getByTestId("tutorial-title").textContent).toBe("첫 번째");

    leaveScreen();
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
    expect(readLocalDone("u1")).toBe(false);

    returnToLobby();
    // 1스텝으로 되감기지 않고 못 본 s2 에서 재개한다.
    expect(screen.getByTestId("tutorial-title").textContent).toBe("두 번째");
    expect(screen.getByTestId("tutorial-progress").textContent).toBe("2 / 2");
  });
});

/**
 * BLK-1 — 로그아웃/세션만료(401)는 리로드 없는 SPA 전환이라 모듈 변수·ref 가 살아남는다.
 * 계정 경계에서 튜토리얼 세션 상태가 전부 버려지는지 검증한다.
 */
describe("계정 경계 — 세션 상태 격리 (BLK-1)", () => {
  /** 401 세션만료 → 같은 탭에서 다른 계정 로그인. */
  function switchAccount(
    app: ReturnType<typeof renderApp>,
    next: { id: string; isNew: boolean },
  ) {
    act(() => {
      fx.token = null; // UnauthorizedBridge 의 logout() 과 같은 상태
      app.refresh();
    });
    act(() => {
      fx.token = "tok2";
      fx.user = { id: next.id };
      if (next.isNew) markTutorialPending();
      app.refresh();
    });
  }

  it("재현 A: 이탈한 신규 유저 뒤에 기존 유저가 로그인해도 튜토리얼이 뜨지 않는다", () => {
    markTutorialPending();
    const app = renderApp();
    fireEvent.click(screen.getByTestId("tutorial-next")); // u1 이 2번째 스텝까지 봄
    leaveScreen();

    // 세션 만료 → 기존 유저 u2 로그인(isNew 아님, 완료 기록 없음).
    switchAccount(app, { id: "u2", isNew: false });
    returnToLobby();

    // u1 의 pending 신호가 남아 u2 에게 튀면 안 된다.
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
  });

  it("재현 B: 다음 신규 유저는 1스텝부터 시작한다 (남의 재개 지점 승계 금지)", () => {
    markTutorialPending();
    const app = renderApp();
    fireEvent.click(screen.getByTestId("tutorial-next")); // u1 resumeIndex = 1 로 이탈
    leaveScreen();

    switchAccount(app, { id: "u2", isNew: true });
    returnToLobby();

    expect(screen.getByTestId("tutorial-overlay")).toBeTruthy();
    expect(screen.getByTestId("tutorial-title").textContent).toBe("첫 번째");
    expect(screen.getByTestId("tutorial-progress").textContent).toBe("1 / 3");
  });

  it("계정이 바뀌면 이전 계정의 완료 기록에도 영향받지 않는다", () => {
    persistTutorialDone("u1");
    const app = renderApp();
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();

    switchAccount(app, { id: "u2", isNew: true });
    expect(screen.getByTestId("tutorial-overlay")).toBeTruthy();
    expect(screen.getByTestId("tutorial-progress").textContent).toBe("1 / 3");
  });

  it("로그아웃하면 진행 중이던 오버레이가 즉시 내려간다", () => {
    markTutorialPending();
    const app = renderApp();
    expect(screen.getByTestId("tutorial-overlay")).toBeTruthy();

    act(() => {
      fx.token = null;
      app.refresh();
    });
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
    // 저장도 하지 않는다 — 유저가 끝낸 게 아니다.
    expect(readLocalDone("u1")).toBe(false);
  });
});

describe("건너뛰기 · 접근성", () => {
  it("'건너뛰기' 는 즉시 종료하고 완료로 저장한다", () => {
    markTutorialPending();
    renderApp();
    fireEvent.click(screen.getByTestId("tutorial-skip"));
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
    expect(readLocalDone("u1")).toBe(true);
  });

  it("ESC 도 건너뛰기로 동작한다", () => {
    markTutorialPending();
    renderApp();
    fireEvent.keyDown(screen.getByTestId("tutorial-overlay"), { key: "Escape" });
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
    expect(readLocalDone("u1")).toBe(true);
  });

  it("role=dialog + 라벨, 그리고 '다음' 에 포커스가 간다", () => {
    markTutorialPending();
    renderApp();
    const overlay = screen.getByTestId("tutorial-overlay");
    expect(overlay.getAttribute("role")).toBe("dialog");
    expect(overlay.getAttribute("aria-labelledby")).toBe("tutorial-title");
    expect(document.activeElement).toBe(screen.getByTestId("tutorial-next"));
  });

  /**
   * 비-모달 계약: 딤이 입력을 막지 않으므로 aria-modal 을 선언하지 않고 Tab 도 가두지 않는다.
   * (가두면 스크린리더 계약과 실제 상호작용이 어긋나고, 튜토리얼 중 로그아웃 같은 조작이 막힌다.)
   */
  it("비-모달이다 — aria-modal 없음, Tab 을 가두지 않음", () => {
    markTutorialPending();
    renderApp();
    const overlay = screen.getByTestId("tutorial-overlay");
    expect(overlay.hasAttribute("aria-modal")).toBe(false);

    const skip = screen.getByTestId("tutorial-skip");
    skip.focus();
    fireEvent.keyDown(overlay, { key: "Tab" });
    // 코치마크가 포커스를 강제로 되돌리지 않는다(브라우저 기본 이동에 맡긴다).
    expect(document.activeElement).toBe(skip);
  });

  it("딤은 시각 강조일 뿐 뒤 UI 의 클릭을 막지 않는다", () => {
    markTutorialPending();
    renderApp();
    // 로그아웃 등 화면 밖 조작을 위해 딤은 pointer-events 를 받지 않아야 한다.
    const dims = document.querySelectorAll<HTMLElement>('[data-testid="tutorial-overlay"] > div');
    expect(dims.length).toBeGreaterThan(0);
  });
});

describe("다시 보기", () => {
  it("완료한 뒤에도 restart() 로 처음부터 다시 열 수 있다", async () => {
    const { useTutorial } = await import("./tutorial-context");
    persistTutorialDone("u1");

    let controls: { restart: () => void } | null = null;
    function Probe() {
      controls = useTutorial();
      return null;
    }
    renderApp(STEPS, [h(Probe, { key: "probe" })]);
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();

    act(() => controls!.restart());

    expect(screen.getByTestId("tutorial-title").textContent).toBe("첫 번째");
    expect(readLocalDone("u1")).toBe(false);
  });
});

/**
 * "본 적 없는 스텝이 완료 처리되는" 사고를 구조로 막았는지 검증한다.
 * 진행 상태의 SoT = **실제로 그려진 스텝 집합(seen)**.
 */
describe("seen 집합이 완료를 결정한다 (BLK-2)", () => {
  it("연쇄 스킵이 중간에 끊겨도 못 본 스텝은 완료 전에 반드시 보여준다", () => {
    markTutorialPending();
    renderApp(REACHABLE_STEPS);
    // s1 은 봤다.
    expect(screen.getByTestId("tutorial-title").textContent).toBe("첫 번째");

    // t2 가 잠깐 사라져 s2 가 건너뛰어진다(지연/조건부 렌더 상황).
    act(() => {
      delete rects.t2;
      window.dispatchEvent(new Event("resize"));
    });
    fireEvent.click(screen.getByTestId("tutorial-next")); // gone → s2 모두 스킵 → 중단
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
    expect(readLocalDone("u1")).toBe(false);

    // 대상이 돌아오고 화면을 재방문 → 못 본 s2 부터 재개된다.
    act(() => {
      fireEvent.click(screen.getByTestId("go-away"));
    });
    returnToLobby();
    expect(screen.getByTestId("tutorial-title").textContent).toBe("두 번째");

    // 모든 스텝을 보여준 뒤에야 저장된다.
    fireEvent.click(screen.getByTestId("tutorial-next"));
    expect(readLocalDone("u1")).toBe(true);
  });

  it("한 번도 안 본 스텝이 남아 있으면 '시작하기'가 저장하지 않는다", () => {
    markTutorialPending();
    renderApp(REACHABLE_STEPS);
    act(() => {
      delete rects.t2; // s2 는 끝까지 못 본다
      window.dispatchEvent(new Event("resize"));
    });
    fireEvent.click(screen.getByTestId("tutorial-next"));
    expect(readLocalDone("u1")).toBe(false);
  });
});

/**
 * 라우트를 넘나드는 스텝(로비 → 덱, #106 머지 후 실연결).
 *
 * 계약 두 줄:
 *  1. 다른 화면의 스텝은 **여기서 소비되지 않는다** — 로비에서 헛되이 스킵해 시도 횟수를
 *     태우지 않고, 완료 저장도 되지 않는다(그 스텝을 아직 안 보여줬으므로).
 *  2. 그 화면에 실제로 들어가면 **이어서 뜬다** — 안 그러면 못 본 스텝이 영구히 남아
 *     완료가 절대 저장되지 않는다(요구 3의 시나리오).
 */
describe("라우트 넘나듦 (로비 → 덱)", () => {
  /** lobby1 → deck1(덱 화면 전용) → lobby2. 실제 TUTORIAL_STEPS 와 같은 모양. */
  const CROSS_STEPS: TutorialStep[] = [
    { id: "lobby1", targetTestId: "t1", title: "로비1", body: "b", enabled: true, route: "/lobby" },
    { id: "deck1", targetTestId: "t2", title: "덱보드", body: "b", enabled: true, route: "/deck" },
    { id: "lobby2", targetTestId: "t3", title: "로비2", body: "b", enabled: true, route: "/lobby" },
  ];

  /** 화면 전환 = 그 화면에 없는 대상은 실제로 사라진다(rect 제거). */
  function goDeck() {
    act(() => {
      delete rects.t1;
      delete rects.t3;
      rects.t2 = { left: 40, top: 300, width: 200, height: 200 };
      fireEvent.click(screen.getByTestId("go-deck"));
      window.dispatchEvent(new Event("resize"));
    });
  }

  function goLobby() {
    act(() => {
      delete rects.t2;
      rects.t1 = { left: 40, top: 100, width: 120, height: 44 };
      rects.t3 = { left: 40, top: 200, width: 120, height: 44 };
      fireEvent.click(screen.getByTestId("go-lobby"));
      window.dispatchEvent(new Event("resize"));
    });
  }

  beforeEach(() => {
    delete rects.t2; // 로비에서 시작 — 덱 화면 대상은 아직 없다
    rects.t3 = { left: 40, top: 200, width: 120, height: 44 };
  });

  it("로비에서는 덱 스텝을 건너뛰지 않고 로비 스텝만 진행한다", () => {
    markTutorialPending();
    renderApp(CROSS_STEPS);
    expect(screen.getByTestId("tutorial-title").textContent).toBe("로비1");

    fireEvent.click(screen.getByTestId("tutorial-next"));
    // deck1 은 이 화면 후보가 아니다 → 곧바로 lobby2.
    expect(screen.getByTestId("tutorial-title").textContent).toBe("로비2");
  });

  /**
   * 라우트 필터가 **실제로 일하는지**를 가르는 테스트.
   *
   * 필터가 없으면 로비의 '다음'이 덱 스텝을 먼저 집어 들고, 그 스텝은 대상이 없으니
   * **유예(운영 400ms)가 만료될 때까지 아무것도 안 그린다** — 유저에겐 말풍선이 사라졌다가
   * 뒤늦게 다음 스텝이 튀어나오는 공백으로 보인다(스텝마다 누적된다). 게다가 그 사이
   * 덱 스텝의 시도 횟수(MAX_ATTEMPTS)까지 태워서, 정작 덱 화면에 도착했을 때 기회를 잃는다.
   * 그래서 유예를 켜 두고 **'다음' 직후에 곧바로 다음 로비 스텝이 그려져 있는지**를 본다.
   */
  it("'다음' 이 다른 화면 스텝을 거치느라 화면을 비우지 않는다", () => {
    markTutorialPending();
    renderApp(CROSS_STEPS, [], 200); // 유예 200ms — 거쳐 갔다면 여기서 화면이 빈다
    expect(screen.getByTestId("tutorial-title").textContent).toBe("로비1");

    fireEvent.click(screen.getByTestId("tutorial-next"));

    expect(screen.queryByTestId("tutorial-overlay")).not.toBeNull();
    expect(screen.getByTestId("tutorial-title").textContent).toBe("로비2");
  });

  /** 라벨이 저장과 어긋나면 안 된다 — '시작하기'인데 완료가 안 되면 유저는 끝난 줄 안다. */
  it("다른 화면에 못 본 스텝이 남아 있으면 '시작하기'라고 하지 않는다", () => {
    markTutorialPending();
    renderApp(CROSS_STEPS);
    fireEvent.click(screen.getByTestId("tutorial-next")); // 로비의 마지막 스텝(로비2)
    expect(screen.getByTestId("tutorial-title").textContent).toBe("로비2");
    // 이 화면엔 다음 후보가 없지만 덱 스텝이 남아 있다 → 아직 끝이 아니다.
    expect(screen.getByTestId("tutorial-next").textContent).toBe("다음");
  });

  it("덱 스텝을 못 봤으면 로비를 다 봐도 완료로 저장하지 않는다", () => {
    markTutorialPending();
    renderApp(CROSS_STEPS);
    fireEvent.click(screen.getByTestId("tutorial-next")); // lobby2
    fireEvent.click(screen.getByTestId("tutorial-next")); // 더 볼 게 없다 → 중단

    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
    expect(readLocalDone("u1")).toBe(false);
  });

  it("덱 화면에 들어가면 못 본 덱 스텝이 이어서 뜨고, 그때 완료된다", () => {
    markTutorialPending();
    renderApp(CROSS_STEPS);
    fireEvent.click(screen.getByTestId("tutorial-next"));
    fireEvent.click(screen.getByTestId("tutorial-next")); // 로비 몫 종료(저장 없음)
    expect(readLocalDone("u1")).toBe(false);

    goDeck();
    expect(screen.getByTestId("tutorial-title").textContent).toBe("덱보드");
    // 마지막 남은 스텝이므로 여기서 끝내면 저장된다.
    expect(screen.getByTestId("tutorial-next").textContent).toBe("시작하기");
    fireEvent.click(screen.getByTestId("tutorial-next"));
    expect(readLocalDone("u1")).toBe(true);
  });

  it("골든 패스: 하이라이트된 버튼으로 덱에 들어가면 진행 중인 튜토리얼이 그대로 이어진다", () => {
    markTutorialPending();
    renderApp(CROSS_STEPS);
    expect(screen.getByTestId("tutorial-title").textContent).toBe("로비1");

    // lobby1 을 보고 있는 상태에서 그대로 덱으로 이동(코치마크는 클릭을 막지 않는다).
    goDeck();
    expect(screen.getByTestId("tutorial-title").textContent).toBe("덱보드");
  });

  /**
   * 자동시작 잠금이 **경로가 바뀔 때마다** 풀리는지 — 잠금이 남으면 덱에 다녀온 뒤
   * 로비로 돌아왔을 때 남은 로비 스텝이 영영 재개되지 않는다(effect 선언 순서 회귀 가드).
   */
  it("덱에 다녀온 뒤 로비로 돌아오면 남은 로비 스텝이 재개된다", () => {
    markTutorialPending();
    renderApp(CROSS_STEPS);
    expect(screen.getByTestId("tutorial-title").textContent).toBe("로비1");

    goDeck();
    expect(screen.getByTestId("tutorial-title").textContent).toBe("덱보드");
    fireEvent.click(screen.getByTestId("tutorial-next")); // 덱에서는 더 볼 게 없다 → 중단
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();

    goLobby();
    expect(screen.getByTestId("tutorial-title").textContent).toBe("로비2");
    expect(readLocalDone("u1")).toBe(false);

    fireEvent.click(screen.getByTestId("tutorial-next"));
    expect(readLocalDone("u1")).toBe(true);
  });

  it("스텝 대상이 없는 화면(/shop)에서는 자동 시작하지 않는다", () => {
    markTutorialPending();
    renderApp(CROSS_STEPS);
    fireEvent.click(screen.getByTestId("tutorial-skip"));
    localStorage.clear(); // 완료 기록만 지우고 세션은 유지

    act(() => {
      fireEvent.click(screen.getByTestId("go-away")); // /shop
    });
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
  });
});

describe("저장 대상 계정 고정 (BLK-1)", () => {
  /**
   * 로그아웃을 거치지 않는 계정 전환(=stale 캐시가 뒤늦게 갱신되는 창)에서도
   * **진행 상태가 승계되면 안 된다**. "저장 안 함"만 보면 owner 가드에 가려 이 분기를
   * 검증하지 못하므로, 다음 계정이 **1스텝부터** 시작하는지를 본다.
   */
  it("토큰은 그대로인데 userId 만 바뀌면 진행 상태를 버리고 처음부터 시작한다", () => {
    markTutorialPending();
    const app = renderApp(REACHABLE_STEPS);
    fireEvent.click(screen.getByTestId("tutorial-next")); // u1 은 2스텝까지 진행
    expect(screen.getByTestId("tutorial-title").textContent).toBe("두 번째");

    // 로그아웃 없이 /api/me 가 다른 계정을 돌려준 상황.
    act(() => {
      fx.user = { id: "u2" };
      app.refresh();
    });

    // u2 는 남의 진행 상태를 물려받지 않는다.
    expect(screen.getByTestId("tutorial-title").textContent).toBe("첫 번째");
    expect(screen.getByTestId("tutorial-progress").textContent).toBe("1 / 2");
    expect(readLocalDone("u1")).toBe(false);
  });

  it("시작 계정과 저장 시점 계정이 다르면 저장하지 않는다", () => {
    markTutorialPending();
    const app = renderApp();
    expect(screen.getByTestId("tutorial-overlay")).toBeTruthy();

    // stale 창: 오버레이는 u1 으로 시작됐는데 그 사이 실제 계정은 u2 가 됐다.
    act(() => {
      fx.user = { id: "u2" };
      app.refresh();
    });
    // 남아 있는 오버레이가 있다면 ESC 로 종료해도 u1 에는 쓰지 않는다.
    const overlay = screen.queryByTestId("tutorial-overlay");
    if (overlay) fireEvent.keyDown(overlay, { key: "Escape" });

    expect(readLocalDone("u1")).toBe(false);
  });
});

describe("다른 모달과의 공존 (AC-B2)", () => {
  it("모달이 열리면 코치마크가 비켜나고, 닫히면 같은 스텝으로 돌아온다", () => {
    markTutorialPending();
    renderApp();
    expect(screen.getByTestId("tutorial-title").textContent).toBe("첫 번째");

    // 모드 선택 모달 같은 다이얼로그가 열린 상황.
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    act(() => {
      document.body.appendChild(modal);
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();

    act(() => {
      modal.remove();
      window.dispatchEvent(new Event("resize"));
    });
    // 스텝은 유지된다 — 비켜난 것이지 진행된 게 아니다.
    expect(screen.getByTestId("tutorial-title").textContent).toBe("첫 번째");
    expect(readLocalDone("u1")).toBe(false);
  });
});

describe("깨지기 쉬운 /api/me 응답", () => {
  it("user 없는 응답이 와도 자식 트리를 죽이지 않는다 (흰 화면 방지)", () => {
    fx.meMissing = true;
    markTutorialPending();
    renderApp();
    // 자식은 그대로 렌더되고, 튜토리얼은 조용히 대기한다.
    expect(screen.getByTestId("t1")).toBeTruthy();
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
  });
});

describe("로그아웃", () => {
  it("토큰이 없으면 오버레이를 띄우지 않는다", () => {
    fx.token = null;
    markTutorialPending();
    renderApp();
    expect(screen.queryByTestId("tutorial-overlay")).toBeNull();
  });
});
