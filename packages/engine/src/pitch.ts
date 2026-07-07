import type { EngineConfig } from "./config";
import type { TeamSide } from "@hmb/shared";
import { toFixed, fdist } from "./fixedmath";

/**
 * pitch — 좌표계·거리·구역 유틸(config 기반, 고정소수).
 *
 * 규약: 홈은 +x(우측 골대) 로 공격, 어웨이는 -x(좌측 골대) 로 공격한다.
 *  - 홈 공격 골대: (width, height/2)
 *  - 어웨이 공격 골대: (0, height/2)
 * 정규화 슬롯(공격 프레임: x=0 자기골, x=1 상대골)을 실좌표로 변환할 때 어웨이는 x·y 를 미러한다.
 */

export interface Pitch {
  scale: number;
  wFx: number; // 폭(길이 방향, x) fixed
  hFx: number; // 높이(폭 방향, y) fixed
}

export function createPitch(config: EngineConfig): Pitch {
  const scale = config.fixedScale;
  return {
    scale,
    wFx: toFixed(config.pitch.width, scale),
    hFx: toFixed(config.pitch.height, scale),
  };
}

/** 정규화 슬롯(0..1, 공격 프레임) → 실좌표 fixed. 어웨이는 미러. */
export function slotToReal(
  pitch: Pitch,
  nx: number,
  ny: number,
  side: TeamSide,
): { x: number; y: number } {
  const ax = side === "home" ? nx : 1 - nx;
  const ay = side === "home" ? ny : 1 - ny;
  return {
    x: Math.round(ax * pitch.wFx),
    y: Math.round(ay * pitch.hFx),
  };
}

/** 해당 팀이 공격하는(=득점하려는) 골대 중앙 fixed. */
export function attackGoal(pitch: Pitch, side: TeamSide): { x: number; y: number } {
  return {
    x: side === "home" ? pitch.wFx : 0,
    y: Math.round(pitch.hFx / 2),
  };
}

/** 해당 팀이 지키는 골대 중앙 fixed. */
export function defendGoal(pitch: Pitch, side: TeamSide): { x: number; y: number } {
  return {
    x: side === "home" ? 0 : pitch.wFx,
    y: Math.round(pitch.hFx / 2),
  };
}

/** 상대 골대까지 거리 fixed. */
export function distToAttackGoal(pitch: Pitch, side: TeamSide, x: number, y: number): number {
  const g = attackGoal(pitch, side);
  return fdist(x, y, g.x, g.y);
}

/** 좌표를 피치 안으로 클램프. */
export function clampToPitch(pitch: Pitch, x: number, y: number): { x: number; y: number } {
  return {
    x: x < 0 ? 0 : x > pitch.wFx ? pitch.wFx : x,
    y: y < 0 ? 0 : y > pitch.hFx ? pitch.hFx : y,
  };
}

/** 센터 스팟 fixed. */
export function centerSpot(pitch: Pitch): { x: number; y: number } {
  return { x: Math.round(pitch.wFx / 2), y: Math.round(pitch.hFx / 2) };
}
