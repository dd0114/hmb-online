import { describe, expect, it } from "vitest";
import { autoCopy, canToggleAuto, suppressHalftimePanel } from "./auto-mode";

describe("canToggleAuto (#249)", () => {
  it("hero 요구 1 — 경기 시작 전(브리핑)과 전반 경기 중에 켜고 끌 수 있다", () => {
    expect(canToggleAuto("BRIEFING")).toBe(true);
    expect(canToggleAuto("FIRST_HALF")).toBe(true);
    // 전반 생성 대기(GEN1)도 아직 경계 전이다 — 여기서 숨기면 대기 화면에서 켤 길이 없다.
    expect(canToggleAuto("GEN1")).toBe(true);
  });

  it("감독시간엔 숨긴다 — 그 화면엔 [후반 시작]이 이미 있어 같은 일을 하는 컨트롤이 둘이 된다", () => {
    expect(canToggleAuto("HALFTIME")).toBe(false);
    expect(canToggleAuto("H1_BREAK")).toBe(false);
  });

  it("후반이 열린 뒤엔 숨긴다 — 감독시간은 지나갔고 서버도 409 로 거부한다", () => {
    expect(canToggleAuto("GEN2")).toBe(false);
    expect(canToggleAuto("SECOND_HALF")).toBe(false);
    expect(canToggleAuto("FINISHED")).toBe(false);
    expect(canToggleAuto("FAILED")).toBe(false);
    expect(canToggleAuto("ABANDONED")).toBe(false);
    expect(canToggleAuto(undefined)).toBe(false);
  });
});

describe("suppressHalftimePanel (#249)", () => {
  it("오토 매치는 감독 패널을 열지 않는다 — 서버의 0초 감독시간이 한 프레임 보여도 화면엔 안 뜬다", () => {
    expect(suppressHalftimePanel("HALFTIME", true)).toBe(true);
    expect(suppressHalftimePanel("H1_BREAK", true)).toBe(true);
  });

  it("오토가 아니면 감독 패널은 그대로 열린다 (회귀 — 이 가드가 정상 흐름을 먹으면 안 된다)", () => {
    expect(suppressHalftimePanel("HALFTIME", false)).toBe(false);
    expect(suppressHalftimePanel("HALFTIME", undefined)).toBe(false);
  });

  it("감독시간이 아닌 상태는 오토 여부와 무관하게 관여하지 않는다", () => {
    expect(suppressHalftimePanel("FIRST_HALF", true)).toBe(false);
    expect(suppressHalftimePanel("SECOND_HALF", true)).toBe(false);
    expect(suppressHalftimePanel("FINISHED", true)).toBe(false);
  });
});

describe("autoCopy (#249)", () => {
  it("상태 이름이 아니라 다음에 일어날 일을 말한다", () => {
    expect(autoCopy(true).hint).toContain("감독시간 없이");
    expect(autoCopy(false).hint).toContain("감독시간");
    expect(autoCopy(false).hint).toContain("3분");
  });

  it("오토여도 후반 지시가 살아있다는 걸 문구가 알려준다 (지시 포기가 아니다)", () => {
    expect(autoCopy(true).hint).toContain("후반 지시");
  });

  it("pressed 는 서버 값을 그대로 따른다 (낙관적 갱신 없음)", () => {
    expect(autoCopy(true).pressed).toBe(true);
    expect(autoCopy(false).pressed).toBe(false);
    expect(autoCopy(undefined).pressed).toBe(false); // 구 매치 = 기본 off
  });
});
