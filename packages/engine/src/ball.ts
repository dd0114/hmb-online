import type { EngineConfig } from "./config";
import type { Ball } from "./simstate";
import type { Pitch } from "./pitch";
import { stepToward, isqrt } from "./fixedmath";

/**
 * ball — 공 상태 전이(고정소수). 순간이동 금지: 비행 중에는 목표를 향해 속도만큼만 전진.
 * 도착/아웃오브바운즈 여부를 알려주고, 소유권·세트피스 판정은 contest/match 가 담당한다.
 *
 * 아웃 판정: 목표가 피치 밖(패스 미스 fail_out, 빗나간 궤적)이면 공이 경계를 넘는 지점을
 * 계산해 어느 라인(사이드/골라인)을 넘었는지 반환한다. 성공 패스는 목표가 피치 안이라
 * 직선 궤적이 사각형 안에 머물러 오검출이 없다.
 */

/** 공이 넘은 경계. left/right = 골라인(x), top/bottom = 사이드라인(y). */
export interface OutCross {
  edge: "left" | "right" | "top" | "bottom";
  x: number;
  y: number;
}

export interface AdvanceResult {
  /** 목표(수신자/골)에 도달. */
  arrived: boolean;
  /** 경계를 넘어 아웃. null 이면 인플레이. */
  out: OutCross | null;
}

/** 공이 owner 에게 붙어 이동(드리블/홀드). */
export function glueBallToOwner(ball: Ball, ownerX: number, ownerY: number): void {
  ball.posFx.x = ownerX;
  ball.posFx.y = ownerY;
}

/** 선분 (fx,fy)->(tx,ty) 이 피치 경계를 처음 넘는 교점. 끝점이 안이면 null. */
function boundaryCross(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  pitch: Pitch,
): OutCross | null {
  const w = pitch.wFx;
  const h = pitch.hFx;
  if (tx >= 0 && tx <= w && ty >= 0 && ty <= h) return null;
  const dx = tx - fx;
  const dy = ty - fy;
  let bestT = Infinity;
  let best: OutCross | null = null;
  const consider = (t: number, edge: OutCross["edge"], cx: number, cy: number): void => {
    if (!(t > 0) || t > 1) return;
    if (cx < -1 || cx > w + 1 || cy < -1 || cy > h + 1) return;
    if (t < bestT) {
      const px = cx < 0 ? 0 : cx > w ? w : cx;
      const py = cy < 0 ? 0 : cy > h ? h : cy;
      bestT = t;
      best = { edge, x: Math.round(px), y: Math.round(py) };
    }
  };
  if (dx !== 0) {
    let t = (0 - fx) / dx;
    consider(t, "left", 0, fy + dy * t);
    t = (w - fx) / dx;
    consider(t, "right", w, fy + dy * t);
  }
  if (dy !== 0) {
    let t = (0 - fy) / dy;
    consider(t, "top", fx + dx * t, 0);
    t = (h - fy) / dy;
    consider(t, "bottom", fx + dx * t, h);
  }
  return best;
}

/**
 * 비행 중인 공을 한 틱 전진.
 *  - 목표를 향해 속도만큼 전진. 경계를 넘으면 out(교점) 반환.
 *  - loose(주인 없는) 공은 감속하며 굴러가고 멈추면 도착 처리.
 */
export function advanceBall(ball: Ball, config: EngineConfig, pitch: Pitch): AdvanceResult {
  const f = ball.flight;
  if (!f) return { arrived: false, out: null };

  const fromX = ball.posFx.x;
  const fromY = ball.posFx.y;
  const next = stepToward(fromX, fromY, f.toX, f.toY, f.speed);

  // 아웃 판정(성공 패스/슛은 목표가 안이라 발생하지 않음).
  const cross = boundaryCross(fromX, fromY, next.x, next.y, pitch);
  if (cross) {
    ball.posFx.x = cross.x;
    ball.posFx.y = cross.y;
    return { arrived: false, out: cross };
  }

  ball.posFx.x = next.x;
  ball.posFx.y = next.y;

  const dx = f.toX - ball.posFx.x;
  const dy = f.toY - ball.posFx.y;
  const remaining = isqrt(dx * dx + dy * dy);

  if (f.kind === "loose") {
    f.speed = Math.round(f.speed * config.ball.looseDecay);
    if (f.speed < config.fixedScale || remaining <= f.speed) return { arrived: true, out: null };
    return { arrived: false, out: null };
  }

  return { arrived: remaining <= f.speed, out: null };
}
