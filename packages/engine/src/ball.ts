import type { EngineConfig } from "./config";
import type { Ball } from "./simstate";
import type { Pitch } from "./pitch";
import { stepToward, isqrt } from "./fixedmath";
import { clampToPitch } from "./pitch";

/**
 * ball — 공 상태 전이(고정소수). 순간이동 금지: 비행 중에는 목표를 향해 속도만큼만 전진.
 * 도착 여부는 boolean 으로 알려주고, 소유권 판정은 contest/match 가 담당한다.
 */

/** 공이 owner 에게 붙어 이동(드리블/홀드). */
export function glueBallToOwner(ball: Ball, ownerX: number, ownerY: number): void {
  ball.posFx.x = ownerX;
  ball.posFx.y = ownerY;
}

/**
 * 비행 중인 공을 한 틱 전진. 도착하면 true.
 * loose(주인 없는) 공은 감속하며 굴러가고 멈추면 도착 처리.
 */
export function advanceBall(ball: Ball, config: EngineConfig, pitch: Pitch): boolean {
  const f = ball.flight;
  if (!f) return false;

  const next = stepToward(ball.posFx.x, ball.posFx.y, f.toX, f.toY, f.speed);
  const clamped = clampToPitch(pitch, next.x, next.y);
  ball.posFx.x = clamped.x;
  ball.posFx.y = clamped.y;

  const dx = f.toX - ball.posFx.x;
  const dy = f.toY - ball.posFx.y;
  const remaining = isqrt(dx * dx + dy * dy);

  if (f.kind === "loose") {
    // 감속: 속도를 배수만큼 줄이고, 아주 느려지면 정지=도착.
    f.speed = Math.round(f.speed * config.ball.looseDecay);
    if (f.speed < config.fixedScale || remaining <= f.speed) return true;
    return false;
  }

  return remaining <= f.speed;
}
