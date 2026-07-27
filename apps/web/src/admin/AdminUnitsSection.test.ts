// @vitest-environment jsdom
/**
 * 어드민 유닛 카탈로그 렌더 계약 (#207 웨이브2-C) — 훅은 wholesale mock, 화면 계약만 본다.
 *
 * 여기서 반드시 박제하는 것 = **등급 하향 409 → 영향 확인 다이얼로그 → confirmImpact 재요청**.
 * 이 플로우가 이 화면의 존재 이유다("운영자가 모르고 누르는 걸 막는다").
 * 곁들여: 비활성 유닛 시각 구분 · 사유 필수 · 변경 0건 제출 불가 · 멱등키(재요청은 새 키).
 *
 * root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { AdminUnit, AdminUnitDetail, AdminUnitPage } from "./admin-units-logic";

type MutateOpts = { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void };

let keyCounter = 0;

const fx = {
  list: { data: undefined as AdminUnitPage | undefined, isLoading: false, isError: false },
  detail: { data: undefined as AdminUnitDetail | undefined, isLoading: false, isError: false },
  update: { mutate: vi.fn(), isPending: false },
  create: { mutate: vi.fn(), isPending: false },
  setActive: { mutate: vi.fn(), isPending: false },
  lastListParams: null as unknown,
};

vi.mock("../api/admin-unit-hooks", () => ({
  ADMIN_UNITS_PATH: "/api/admin/units",
  newIdempotencyKey: () => `key-${++keyCounter}`,
  useAdminUnits: (params: unknown) => {
    fx.lastListParams = params;
    return fx.list;
  },
  useAdminUnitDetail: () => fx.detail,
  useUpdateUnit: () => fx.update,
  useCreateUnit: () => fx.create,
  useSetUnitActive: () => fx.setActive,
}));

import { AdminUnitsSection } from "./AdminUnitsSection";

const LEGEND: AdminUnit = {
  id: "P005",
  name: "유라도나",
  position: "MF",
  grade: "LEGEND",
  attributes: {
    technical: 93,
    mental: 95,
    physical: 92,
    passing: 93,
    shooting: 95,
    tackling: 86,
    pace: 93,
    stamina: 95,
    positioning: 89,
  },
  personality: "FIERY",
  active: true,
  adminLocked: false,
  dataVersion: "v2.1",
};

const RETIRED: AdminUnit = {
  ...LEGEND,
  id: "P001",
  name: "Lev Yashin",
  position: "GK",
  active: false,
  adminLocked: true,
  dataVersion: "admin",
};

const PAGE: AdminUnitPage = { items: [LEGEND, RETIRED], total: 2, limit: 25, offset: 0 };

const DETAIL: AdminUnitDetail = {
  unit: LEGEND,
  holdings: { owners: 12, copies: 19 },
  recentAudit: [
    {
      id: "A1",
      actorUserId: "admin1",
      playerId: "P005",
      action: "unit_update",
      changedFields: ["grade"],
      before: { grade: "DIA" },
      after: { grade: "LEGEND" },
      reason: "레전드 승격",
      idemKey: "k0",
      createdAt: "2026-07-26T09:00:00Z",
    },
  ],
};

const IMPACT = {
  fromGrade: "LEGEND",
  toGrade: "DIA",
  capLowered: true,
  affectedUsers: 12,
  avgOvrDelta: -3.24,
  worstOvrDelta: -7.33,
  computed: true,
};

function renderSection() {
  return render(h(AdminUnitsSection));
}

/** 상세 편집 폼을 띄운 상태로 만든다. */
function openDetail() {
  renderSection();
  fireEvent.click(screen.getByTestId("admin-unit-select-P005"));
}

beforeEach(() => {
  keyCounter = 0;
  fx.list = { data: PAGE, isLoading: false, isError: false };
  fx.detail = { data: DETAIL, isLoading: false, isError: false };
  fx.update = { mutate: vi.fn(), isPending: false };
  fx.create = { mutate: vi.fn(), isPending: false };
  fx.setActive = { mutate: vi.fn(), isPending: false };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("유닛 목록", () => {
  it("행을 렌더하고 등급 뱃지를 붙인다", () => {
    renderSection();
    expect(screen.getByTestId("admin-units-table")).toBeTruthy();
    const row = screen.getByTestId("admin-unit-row-P005");
    expect(row.textContent).toContain("유라도나");
    expect(row.textContent).toContain("레전드");
  });

  it("비활성 유닛은 시각적으로 구분된다(딤 클래스 + 상태 칩)", () => {
    renderSection();
    const off = screen.getByTestId("admin-unit-row-P001");
    const on = screen.getByTestId("admin-unit-row-P005");
    expect(off.getAttribute("data-active")).toBe("false");
    expect(on.getAttribute("data-active")).toBe("true");
    // 딤 클래스가 비활성 행에만 붙는다(CSS 모듈이라 클래스명 자체는 해시될 수 있어 '차이'로 본다).
    expect(off.className).not.toBe(on.className);
    expect(screen.getByTestId("admin-unit-state-P001").textContent).toBe("비활성");
    expect(screen.getByTestId("admin-unit-state-P005").textContent).toBe("활성");
  });

  it("등급/포지션/활성 필터가 질의로 전달된다", () => {
    renderSection();
    fireEvent.change(screen.getByTestId("admin-units-grade"), { target: { value: "LEGEND" } });
    fireEvent.change(screen.getByTestId("admin-units-position"), { target: { value: "GK" } });
    fireEvent.change(screen.getByTestId("admin-units-active"), { target: { value: "false" } });
    expect(fx.lastListParams).toMatchObject({ grade: "LEGEND", position: "GK", active: false });
  });

  it("검색어는 디바운스 후 질의로 간다", async () => {
    vi.useFakeTimers();
    try {
      renderSection();
      fireEvent.change(screen.getByTestId("admin-units-search"), { target: { value: "유라" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(fx.lastListParams).toMatchObject({ q: "유라" });
  });

  it("빈 결과는 안내 문구", () => {
    fx.list = { data: { items: [], total: 0, limit: 25, offset: 0 }, isLoading: false, isError: false };
    renderSection();
    expect(screen.getByTestId("admin-units-empty")).toBeTruthy();
  });
});

describe("유닛 상세", () => {
  it("보유 규모와 감사 이력(누가·언제·무엇을·이전→새값)을 보여준다", () => {
    openDetail();
    expect(screen.getByTestId("admin-unit-owners").textContent).toBe("12");
    expect(screen.getByTestId("admin-unit-copies").textContent).toBe("19");
    const audit = screen.getByTestId("admin-unit-audit-row-A1");
    expect(audit.textContent).toContain("admin1");
    expect(audit.textContent).toContain("grade: DIA → LEGEND");
    expect(audit.textContent).toContain("레전드 승격");
  });

  it("폼은 서버 현재값으로 채워진다", () => {
    openDetail();
    expect((screen.getByTestId("admin-unit-name") as HTMLInputElement).value).toBe("유라도나");
    expect((screen.getByTestId("admin-unit-attr-pace") as HTMLInputElement).value).toBe("93");
  });
});

describe("유닛 수정", () => {
  it("사유가 비면 제출 불가", () => {
    openDetail();
    fireEvent.change(screen.getByTestId("admin-unit-attr-pace"), { target: { value: "90" } });
    expect((screen.getByTestId("admin-unit-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("admin-unit-reason"), { target: { value: "밸런스" } });
    expect((screen.getByTestId("admin-unit-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("변경 0건이면 사유가 있어도 제출 불가", () => {
    openDetail();
    fireEvent.change(screen.getByTestId("admin-unit-reason"), { target: { value: "밸런스" } });
    expect((screen.getByTestId("admin-unit-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("바뀐 능력치만 담아 PATCH 하고, 멱등키 헤더용 키를 함께 넘긴다", () => {
    openDetail();
    fireEvent.change(screen.getByTestId("admin-unit-attr-pace"), { target: { value: "90" } });
    fireEvent.change(screen.getByTestId("admin-unit-reason"), { target: { value: "밸런스" } });
    fireEvent.click(screen.getByTestId("admin-unit-submit"));
    expect(fx.update.mutate).toHaveBeenCalledTimes(1);
    const vars = fx.update.mutate.mock.calls[0]![0];
    expect(vars.playerId).toBe("P005");
    expect(vars.body).toEqual({ reason: "밸런스", attributes: { pace: 90 } });
    expect(vars.idemKey).toBeTruthy();
  });
});

describe("등급 하향 영향 확인 플로우 (이 화면의 핵심)", () => {
  function submitDowngrade() {
    openDetail();
    fireEvent.change(screen.getByTestId("admin-unit-grade"), { target: { value: "DIA" } });
    fireEvent.change(screen.getByTestId("admin-unit-reason"), { target: { value: "강등" } });
    fireEvent.click(screen.getByTestId("admin-unit-submit"));
  }

  it("등급을 낮추면 저장 전에 경고가 먼저 보인다", () => {
    openDetail();
    fireEvent.change(screen.getByTestId("admin-unit-grade"), { target: { value: "DIA" } });
    expect(screen.getByTestId("admin-unit-downgrade-warn").textContent).toContain("레전드");
  });

  it("첫 PATCH 는 confirmImpact 없이 나간다", () => {
    submitDowngrade();
    expect(fx.update.mutate.mock.calls[0]![0].body).toEqual({ reason: "강등", grade: "DIA" });
    expect(fx.update.mutate.mock.calls[0]![0].body.confirmImpact).toBeUndefined();
  });

  it("409(detail=AdminUnitGradeImpact)는 에러 토스트가 아니라 확인 다이얼로그로 뜬다", () => {
    submitDowngrade();
    const opts = fx.update.mutate.mock.calls[0]![1] as MutateOpts;
    act(() => {
      opts.onError!(new ApiError(409, { code: "CONFLICT", message: "confirm required", detail: IMPACT }));
    });
    const dialog = screen.getByTestId("admin-unit-impact");
    expect(dialog).toBeTruthy();
    expect(screen.getByTestId("admin-unit-impact-body").textContent).toBe(
      "이 변경으로 12명의 카드가 평균 −3.2 OVR (최악 −7.3 OVR)",
    );
    expect(screen.getByTestId("admin-unit-impact-users").textContent).toBe("12명");
    expect(screen.getByTestId("admin-unit-impact-avg").textContent).toBe("−3.2 OVR");
    expect(screen.getByTestId("admin-unit-impact-worst").textContent).toBe("−7.3 OVR");
    // 에러 배너로 흘려보내지 않는다.
    expect(screen.queryAllByRole("alert").length).toBe(0);
  });

  it("확인하면 confirmImpact:true 로 **새 멱등키**를 써서 재요청한다", () => {
    submitDowngrade();
    const firstKey = fx.update.mutate.mock.calls[0]![0].idemKey;
    const opts = fx.update.mutate.mock.calls[0]![1] as MutateOpts;
    act(() => {
      opts.onError!(new ApiError(409, { code: "CONFLICT", message: "confirm required", detail: IMPACT }));
    });

    fireEvent.click(screen.getByTestId("admin-unit-impact-ok"));

    expect(fx.update.mutate).toHaveBeenCalledTimes(2);
    const second = fx.update.mutate.mock.calls[1]![0];
    expect(second.body).toEqual({ reason: "강등", grade: "DIA", confirmImpact: true });
    // 바디가 달라졌으므로 같은 키를 재사용하면 서버가 "같은 키 다른 내용" 409 를 낸다.
    expect(second.idemKey).not.toBe(firstKey);
  });

  it("취소하면 아무것도 재전송하지 않는다", () => {
    submitDowngrade();
    const opts = fx.update.mutate.mock.calls[0]![1] as MutateOpts;
    act(() => {
      opts.onError!(new ApiError(409, { code: "CONFLICT", message: "confirm required", detail: IMPACT }));
    });
    fireEvent.click(screen.getByTestId("admin-unit-impact-cancel"));
    expect(screen.queryByTestId("admin-unit-impact")).toBeNull();
    expect(fx.update.mutate).toHaveBeenCalledTimes(1);
  });

  it("멱등키 충돌 409(detail 없음)는 확인 다이얼로그가 아니라 오류로 다룬다", () => {
    submitDowngrade();
    const opts = fx.update.mutate.mock.calls[0]![1] as MutateOpts;
    act(() => {
      opts.onError!(new ApiError(409, { code: "CONFLICT", message: "중복 멱등키" }));
    });
    expect(screen.queryByTestId("admin-unit-impact")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("중복 멱등키");
  });

  it("computed=false 면 0 을 '영향 없음'처럼 보여주지 않는다", () => {
    submitDowngrade();
    const opts = fx.update.mutate.mock.calls[0]![1] as MutateOpts;
    act(() => {
      opts.onError!(
        new ApiError(409, {
          code: "CONFLICT",
          message: "x",
          detail: { ...IMPACT, computed: false, avgOvrDelta: 0, worstOvrDelta: 0 },
        }),
      );
    });
    expect(screen.getByTestId("admin-unit-impact-avg").textContent).toBe("미계산");
    expect(screen.getByTestId("admin-unit-impact-body").textContent).toContain("계산하지 못했습니다");
  });
});

describe("활성 토글", () => {
  it("사유를 입력해야 적용된다", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("admin-unit-toggle-P005"));
    expect((screen.getByTestId("admin-unit-toggle-ok") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("admin-unit-toggle-reason"), {
      target: { value: "레거시 전환" },
    });
    fireEvent.click(screen.getByTestId("admin-unit-toggle-ok"));
    expect(fx.setActive.mutate).toHaveBeenCalledTimes(1);
    expect(fx.setActive.mutate.mock.calls[0]![0]).toMatchObject({
      playerId: "P005",
      active: false,
      reason: "레거시 전환",
    });
    expect(fx.setActive.mutate.mock.calls[0]![0].idemKey).toBeTruthy();
  });

  it("비활성 유닛은 활성화로 뒤집는다", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("admin-unit-toggle-P001"));
    fireEvent.change(screen.getByTestId("admin-unit-toggle-reason"), { target: { value: "복구" } });
    fireEvent.click(screen.getByTestId("admin-unit-toggle-ok"));
    expect(fx.setActive.mutate.mock.calls[0]![0]).toMatchObject({ playerId: "P001", active: true });
  });
});

describe("신규 유닛 추가", () => {
  it("9종 능력치 + 사유가 다 있어야 생성된다", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("admin-unit-create-open"));
    const submit = () => screen.getByTestId("admin-unit-create-submit") as HTMLButtonElement;
    expect(submit().disabled).toBe(true);

    fireEvent.change(screen.getByTestId("admin-unit-create-name"), { target: { value: "권씨" } });
    for (const k of [
      "technical",
      "mental",
      "physical",
      "passing",
      "shooting",
      "tackling",
      "pace",
      "stamina",
      "positioning",
    ]) {
      fireEvent.change(screen.getByTestId(`admin-unit-create-attr-${k}`), { target: { value: "88" } });
    }
    expect(submit().disabled).toBe(true); // 사유가 아직 없다
    fireEvent.change(screen.getByTestId("admin-unit-create-reason"), { target: { value: "신규 투입" } });
    expect(submit().disabled).toBe(false);

    fireEvent.click(submit());
    expect(fx.create.mutate).toHaveBeenCalledTimes(1);
    const vars = fx.create.mutate.mock.calls[0]![0];
    expect(vars.body.name).toBe("권씨");
    expect(vars.body.reason).toBe("신규 투입");
    expect(vars.body.attributes.pace).toBe(88);
    expect(vars.idemKey).toBeTruthy();
  });
});
