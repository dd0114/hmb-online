/**
 * 재생 컨트롤 모드 판정 순수 로직 계약 (#148).
 * 플레이 모드 = 업계 표준(FM/FIFA): 진행 위주 + 배속 몇 단계. 되감기·배율·스크럽 없음.
 * admin/QA 모드 = 뷰어 풀컨트롤 노출(디버그·검수).
 */
import { describe, expect, it } from "vitest";
import {
  canSwitchControlMode,
  isControlModeReset,
  isPlaySpeed,
  parseControlOverride,
  PLAY_SPEEDS,
  resolveControlMode,
} from "./playback-controls";

describe("playback-controls — 모드 판정", () => {
  it("일반 유저(비admin·오버라이드 없음)는 플레이 모드", () => {
    expect(resolveControlMode({ isAdmin: false, search: "", stored: null })).toBe("play");
  });

  it("admin 계정(#119)은 기본 풀컨트롤", () => {
    expect(resolveControlMode({ isAdmin: true, search: "", stored: null })).toBe("full");
  });

  it("QA 플래그(?viewerControls=full)는 비admin 에서도 풀컨트롤", () => {
    expect(resolveControlMode({ isAdmin: false, search: "?viewerControls=full", stored: null })).toBe("full");
  });

  it("QA 플래그는 admin 을 플레이 모드로 되돌릴 수도 있다(플레이어 체감 검수)", () => {
    expect(resolveControlMode({ isAdmin: true, search: "?viewerControls=play", stored: null })).toBe("play");
  });

  it("localStorage 저장 플래그도 오버라이드로 인정(쿼리 우선)", () => {
    expect(resolveControlMode({ isAdmin: false, search: "", stored: "full" })).toBe("full");
    expect(resolveControlMode({ isAdmin: false, search: "?viewerControls=play", stored: "full" })).toBe("play");
  });

  it("알 수 없는 플래그 값은 무시(안전한 기본 = 계정 기준)", () => {
    expect(parseControlOverride("?viewerControls=zzz")).toBeNull();
    expect(parseControlOverride("")).toBeNull();
    expect(parseControlOverride(null)).toBeNull();
    expect(resolveControlMode({ isAdmin: false, search: "?viewerControls=zzz", stored: "nope" })).toBe("play");
  });

  it("?qa=1 단축 플래그도 풀컨트롤", () => {
    expect(parseControlOverride("?qa=1")).toBe("full");
  });

  it("?viewerControls=reset 은 저장된 QA 오버라이드를 무시한다(고착 해제 탈출구)", () => {
    expect(isControlModeReset("?viewerControls=reset")).toBe(true);
    expect(isControlModeReset("?viewerControls=off")).toBe(true);
    expect(isControlModeReset("?viewerControls=full")).toBe(false);
    expect(isControlModeReset("")).toBe(false);
    // 저장값이 full 이어도 reset 이면 계정 기준(일반 유저 = play)으로 되돌아간다.
    expect(resolveControlMode({ isAdmin: false, search: "?viewerControls=reset", stored: "full" })).toBe("play");
    expect(canSwitchControlMode({ isAdmin: false, search: "?viewerControls=reset", stored: "full" })).toBe(false);
  });

  it("모드 전환 토글은 admin/QA 자격자에게만 노출된다", () => {
    expect(canSwitchControlMode({ isAdmin: true, search: "", stored: null })).toBe(true);
    expect(canSwitchControlMode({ isAdmin: false, search: "?qa=1", stored: null })).toBe(true);
    expect(canSwitchControlMode({ isAdmin: false, search: "", stored: null })).toBe(false);
    // 일반 유저가 URL 로 play 를 명시해도 "자격"은 생기지 않는다(노출 확대 금지).
    expect(canSwitchControlMode({ isAdmin: false, search: "?viewerControls=play", stored: null })).toBe(false);
  });
});

describe("playback-controls — 배속 단계", () => {
  it("플레이 모드 배속은 진행 방향 몇 단계뿐(슬로우·되감기 없음)", () => {
    expect([...PLAY_SPEEDS]).toEqual([1, 2, 4]);
    expect(PLAY_SPEEDS.every((s) => s >= 1)).toBe(true);
  });

  it("뷰어로 보낼 배속은 화이트리스트만 통과(임의 값 주입 차단)", () => {
    expect(isPlaySpeed(2)).toBe(true);
    expect(isPlaySpeed(0.25)).toBe(false);
    expect(isPlaySpeed(8)).toBe(false);
    expect(isPlaySpeed(Number.NaN)).toBe(false);
  });
});
