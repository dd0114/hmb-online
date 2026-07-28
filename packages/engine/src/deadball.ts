import type { EngineConfig } from "./config";
import type { SimPlayer, SimState } from "./simstate";
import type { Pitch } from "./pitch";
import type { TeamSide } from "@hmb/shared";
import { isqrt, toFixed } from "./fixedmath";
import { varietyNoise } from "./decision";
import { defendGoal, clampToPitch, centerSpot } from "./pitch";

/**
 * deadball — 세트피스 정지 중 "상대는 물러나 있어야 한다"(실제 축구 규칙)의 기하 구현. (#176)
 *
 * 규칙(IFAB): Law 8 킥오프·13 프리킥·14 페널티·17 코너 = 스팟에서 9.15m 밖,
 * Law 15 스로인 = 2m 밖, Law 16 골킥 = 차는 팀 페널티에어리어 밖.
 * (수비팀이 자기 박스 안에서 차는 프리킥도 상대는 박스 밖 — Law 13.)
 *
 * 설계 원칙 — **순간이동 금지**(#59 데드볼 워킹 taker 와 같은 철학). 상대를 구역 밖으로 밀어내지
 * 않고, ①목표를 구역 밖으로 돌려 **걸어서 나가게** 하고 ②구역 안쪽으로 파고드는 이동만
 * **한 방향 벽**으로 막는다. ②가 없으면 목표가 밖이어도 **거기까지 가는 직선 경로가 구역을
 * 가로질러** 침범이 남는다(실측: 목표 재작성만으로 654→409 잔존).
 *
 * 결정론: 전역 난수 0, 좌표는 정수 고정소수만(isqrt). 부동소수로 좌표를 만들지 않는다.
 */


/**
 * 후퇴 출구 탐색용 고정 방위 테이블(22.5° 간격 ×16, cos/sin 을 RAY_SCALE 배 정수화).
 * `Math.cos/sin` 은 정확 반올림이 보장되지 않아(플랫폼 편차) 결정론 엔진에서 쓸 수 없다.
 * 인덱스 0 = 회전 없음 = **자기 방위**(가장 자연스러운 후퇴)라 동률 시 그쪽이 먼저 선택된다.
 */
const RAY_SCALE = 1_000_000;
const RAY_DIRS: readonly (readonly [number, number])[] = [
  [1_000_000, 0], [923_880, 382_683], [707_107, 707_107], [382_683, 923_880],
  [0, 1_000_000], [-382_683, 923_880], [-707_107, 707_107], [-923_880, 382_683],
  [-1_000_000, 0], [-923_880, -382_683], [-707_107, -707_107], [-382_683, -923_880],
  [0, -1_000_000], [382_683, -923_880], [707_107, -707_107], [923_880, -382_683],
];

/** 상대 접근 금지 구역. 스팟 중심 원 ∪ 페널티박스(둘 다 스팟을 포함 → 스팟 기준 star-shaped). */
export interface DeadBallZone {
  /** 재시작(수혜) 팀. 이 팀의 **상대만** 배제된다. */
  side: TeamSide;
  /** 스팟(fixed). */
  x: number;
  y: number;
  /** 스팟 중심 금지 반경(fixed). 0 이면 원 제약 없음. */
  rFx: number;
  /** 페널티박스 금지구역(fixed). null 이면 없음. */
  box: { cx: number; cy: number; hx: number; hy: number } | null;
  /**
   * `box` 가 **어느 팀의 자기 박스**인가. 그 팀 골키퍼만 Law 13/14 의 골라인 예외를 받는다(#230).
   * null = 박스 없음(원 제약만) → 예외 대상 골키퍼도 없다.
   */
  boxOwner: TeamSide | null;
}

/**
 * 정지(데드볼) 중 이 선수가 서 있을 자리(fixed) — **규칙기반 정적 배치**. (#185/#174)
 *
 * 왜 평소 오프더볼 로직을 안 쓰나 — 그 로직은 자기 현재 위치·상대 위치·시야 기억을 입력으로
 * 매 틱 다시 계산한다. 정지처럼 상황이 안 변하는 구간에서 그건 **위치 피드백 루프**가 되어
 * ①매 틱 방향이 뒤집히는 제자리 왕복(±1.4~2.2m, #185)과 ②전원이 수렴해 굳은 뒤 한 명만
 * 기억 만료로 새 타깃을 받아 혼자 풀스피드로 질주하는 그림(#174)을 만든다.
 * 목표를 **(세트피스, 자기 기본 위치)만의 순수 함수**로 두면 정지 중 목표가 변하지 않아
 * 두 현상이 원인 단계에서 사라진다(속도 캡 같은 증상 억제가 아니다).
 *
 *  - 킥오프/골 세리머니: 포메이션 기본 배치 그대로(규칙상 킥오프 대형 + 세리머니 후 복귀).
 *  - 그 외 재시작: 기본 배치를 스팟 쪽으로 shapeReach 만큼 이동(팀 형태 유지한 채 공 쪽으로).
 * 코너는 기존 박스 크라우딩 규칙(decideOffBall)이 이미 순수 함수라 그대로 쓴다.
 */
export function deadBallShapeTarget(
  state: SimState,
  pitch: Pitch,
  config: EngineConfig,
  player: SimPlayer,
  sp: NonNullable<SimState["setPiece"]>,
): { x: number; y: number } {
  const d = config.rules.deadBall;
  let tx: number;
  let ty: number;
  if (sp.kind === "kickoff" || sp.kind === "goal") {
    tx = player.baseFx.x;
    ty = player.baseFx.y;
  } else {
    // #230: 골키퍼는 별도 비율(기본 0 = 자기 자리 유지). 당김이 거리 비례라 골키퍼만
    // 기본 위치(자기 골라인)에서 스팟까지가 90m 를 넘어, 같은 비율이 33m 이탈이 된다.
    // 라이브에서 골키퍼가 "골킥을 가로채러 나오는" 것처럼 보이던 것의 실체가 이것이다.
    const rx = player.isGK ? d.gkShapeReach : d.shapeReachX;
    const ry = player.isGK ? d.gkShapeReach : d.shapeReachY;
    tx = player.baseFx.x + Math.round((sp.x - player.baseFx.x) * rx);
    ty = player.baseFx.y + Math.round((sp.y - player.baseFx.y) * ry);
  }
  // 대기 동작: 배치에 느린(주기 idlePeriodTicks) 시드 오프셋. 주기가 길어 한 번 움직이면 여러 틱
  // 가만히 있으므로 "매 틱 방향 반전"(#185)이 되지 않으면서 전원이 굳은 동상으로도 안 보인다.
  const amp = Math.round(d.idleAmpM * config.fixedScale);
  if (amp > 0) {
    // 버킷 경계에 **선수별 위상**을 준다. 전원이 같은 틱에 목표를 바꾸면 "다 같이 걷고 다 같이
    // 멈추는" 그림이 되어 정지 틱이 몰린다(실측 동상틱 21.9%). 위상을 어긋내면 매 틱 일부만 움직인다.
    const period = Math.max(1, d.idlePeriodTicks);
    const bucket = Math.floor((state.tick + (player.idHash % period)) / period);
    const nx = varietyNoise(state.seedHash, player.idHash, bucket * 2 + 1);
    const ny = varietyNoise(state.seedHash, player.idHash, bucket * 2 + 2);
    tx += Math.round((nx * 2 - 1) * amp);
    ty += Math.round((ny * 2 - 1) * amp);
  }
  return clampToPitch(pitch, tx, ty);
}

/** 정지 중 규칙기반 배치를 쓰는 세트피스인가. 코너는 기존 박스 크라우딩 규칙(순수)을 유지. */
export function deadBallUsesShape(kind: NonNullable<SimState["setPiece"]>["kind"]): boolean {
  return kind !== "corner";
}

/** side 팀이 지키는(=자기) 페널티박스(fixed). */
function ownBox(pitch: Pitch, config: EngineConfig, side: TeamSide): NonNullable<DeadBallZone["box"]> {
  const g = defendGoal(pitch, side);
  const scale = config.fixedScale;
  return {
    cx: g.x,
    cy: g.y,
    hx: toFixed(config.rules.penalty.boxDepthM, scale),
    hy: toFixed(config.rules.penalty.boxHalfWidthM, scale),
  };
}

function insideBox(b: NonNullable<DeadBallZone["box"]>, x: number, y: number): boolean {
  return Math.abs(x - b.cx) < b.hx && Math.abs(y - b.cy) < b.hy;
}

/**
 * 현재 세트피스의 상대 금지구역. 세트피스가 없거나 아직 재시작 지점이 아니면(골 세리머니,
 * shot_out 파킹) null — 그 구간엔 규칙상 "스팟"이 존재하지 않는다.
 */
export function deadBallZone(state: SimState, config: EngineConfig, pitch: Pitch): DeadBallZone | null {
  const sp = state.setPiece;
  if (!sp) return null;
  const d = config.rules.deadBall;
  const scale = config.fixedScale;
  const r = toFixed(d.opponentDistanceM, scale);
  const base = { side: sp.side, x: sp.x, y: sp.y };

  switch (sp.kind) {
    // Law 16: 상대는 차는 팀 페널티에어리어 밖(반경 제약 없음).
    case "goal_kick":
      return d.boxClear
        ? { ...base, rFx: 0, box: ownBox(pitch, config, sp.side), boxOwner: sp.side }
        : { ...base, rFx: r, box: null, boxOwner: null };
    // Law 15: 스로인 지점에서 2m.
    case "throw_in":
      return { ...base, rFx: toFixed(d.throwInDistanceM, scale), box: null, boxOwner: null };
    // Law 17(코너)·8(킥오프): 9.15m.
    case "corner":
    case "kickoff":
      return { ...base, rFx: r, box: null, boxOwner: null };
    // Law 13: 9.15m + 수비팀이 자기 박스 안에서 차면 상대는 박스 밖까지.
    case "free_kick": {
      const b = ownBox(pitch, config, sp.side);
      const on = d.boxClear && insideBox(b, sp.x, sp.y);
      return { ...base, rFx: r, box: on ? b : null, boxOwner: on ? sp.side : null };
    }
    // Law 14: 키커·수비GK 외 전원이 박스 밖 + 스팟 9.15m 밖(수비GK 는 아래 예외로 제외).
    case "penalty": {
      const def = sp.side === "home" ? "away" : "home";
      return {
        ...base,
        rFx: r,
        box: d.boxClear ? ownBox(pitch, config, def) : null,
        boxOwner: d.boxClear ? def : null,
      };
    }
    // goal(세리머니) / shot_out(골문 프레임 파킹) — 재시작 스팟이 아직 없다.
    default:
      return null;
  }
}

/**
 * 이 선수가 금지구역에서 배제되는가(= 물러나 있어야 하는가).
 *
 * 골키퍼 예외는 Law 13/14 의 **골라인 예외** — 수비 GK 는 자기 골문을 비우고 물러나지 않는다
 * (페널티에서 골라인에 선 수비 GK, 상대가 우리 박스 안에서 차는 프리킥의 우리 GK).
 *
 * ⚠️ #230: 이 예외가 원래 **모든** 골키퍼에게 무조건 걸려 있었다. 그러면 골킥처럼 구역이
 * **남의 박스**인 경우에도 상대 골키퍼가 면제돼, 그가 그 박스로 걸어 들어가도 막을 것이 없다.
 * 예외가 성립하는 조건은 "골키퍼다"가 아니라 **"그 구역이 자기 박스다"** 이므로 그렇게 좁힌다.
 */
export function deadBallExcluded(player: SimPlayer, zone: DeadBallZone): boolean {
  if (player.side === zone.side) return false;
  if (player.isGK && zone.boxOwner === player.side) return false;
  return true;
}

/**
 * 금지구역 여유(fixed). 음수면 위반(구역 안), 클수록 밖.
 * 원·박스 둘 다 있으면 더 빡빡한 쪽(작은 값).
 */
export function deadBallClearance(zone: DeadBallZone, x: number, y: number): number {
  let c = Infinity;
  if (zone.rFx > 0) {
    const dx = x - zone.x;
    const dy = y - zone.y;
    c = Math.min(c, isqrt(dx * dx + dy * dy) - zone.rFx);
  }
  const b = zone.box;
  if (b) {
    c = Math.min(c, Math.max(Math.abs(x - b.cx) - b.hx, Math.abs(y - b.cy) - b.hy));
  }
  return c;
}

/** 스팟 → 피치 중앙 방향(폴백 방위). 스팟이 곧 중앙이면 +x. */
function centerBearing(pitch: Pitch, zone: DeadBallZone): { dx: number; dy: number; d: number } {
  const c = centerSpot(pitch);
  const dx = c.x - zone.x;
  const dy = c.y - zone.y;
  const d = isqrt(dx * dx + dy * dy);
  return d === 0 ? { dx: 1, dy: 0, d: 1 } : { dx, dy, d };
}

/**
 * 스팟에서 (dx,dy) 방위로 나갈 때 구역을 벗어나는 최소 거리(fixed) + 여유.
 * 원 ∪ 박스가 스팟 기준 star-shaped 이므로 방위별 탈출거리는 둘 중 큰 쪽으로 정확히 구해진다.
 */
function exitRadius(zone: DeadBallZone, dx: number, dy: number, d: number, marginFx: number): number {
  let need = zone.rFx;
  const b = zone.box;
  if (b) {
    // 스팟은 박스 안(구성상) → 각 축이 박스 경계에 닿는 거리 중 **먼저 닿는 쪽**이 박스 탈출거리.
    let t = -1;
    if (dx !== 0) {
      const edge = dx > 0 ? b.cx + b.hx : b.cx - b.hx;
      t = Math.ceil(((edge - zone.x) * d) / dx);
    }
    if (dy !== 0) {
      const edge = dy > 0 ? b.cy + b.hy : b.cy - b.hy;
      const ty = Math.ceil(((edge - zone.y) * d) / dy);
      t = t < 0 ? ty : Math.min(t, ty);
    }
    if (t > need) need = t;
  }
  return need + marginFx;
}

/**
 * 구역 안에 있는 선수의 **가장 가까운 출구**(fixed). 없으면 null.
 *
 * 왜 "가장 가까운 출구" 여야 하나 — 여유(clearance)는 축별 침투의 max 라, 스팟 방사 방향으로
 * 내보내면 **나가는 도중 여유가 오히려 줄어드는 구간**이 생기고 일방통행 벽이 그 이동을 취소해
 * 선수가 그 자리에 굳는다(실측: 박스 안 H9 가 12틱 완전 정지). 최소 침투 축으로 내보내면 그 축의
 * 침투만 커지고 다른 축은 그대로라 **여유가 단조 증가**해 벽에 자기가 걸리지 않는다.
 */
function nearestExit(
  pitch: Pitch,
  zone: DeadBallZone,
  config: EngineConfig,
  x: number,
  y: number,
): { x: number; y: number } | null {
  const margin = toFixed(config.rules.deadBall.marginM, config.fixedScale);
  const cands: { x: number; y: number; d: number }[] = [];
  const b = zone.box;
  if (b) {
    // 네 변 전부 후보로 두고 아래서 피치 밖/여전히 위반인 것을 거른다(골라인 쪽 변은 자동 탈락).
    for (const ex of [b.cx - b.hx - margin, b.cx + b.hx + margin]) cands.push({ x: ex, y, d: Math.abs(ex - x) });
    for (const ey of [b.cy - b.hy - margin, b.cy + b.hy + margin]) cands.push({ x, y: ey, d: Math.abs(ey - y) });
  }
  if (zone.rFx > 0) {
    // 자기 방위의 링 위 점이 **피치 밖**이면(스팟이 라인 근처) 그 후보는 아래서 탈락한다.
    // 그때 중앙 방위 하나로만 폴백하면 그 경로가 스팟을 스쳐 지나가 여유가 줄어 벽에 걸린다
    // (실측: 파울러 A4 가 스팟 1.48m 옆에서 11틱 완전 정지). 그래서 **여러 방위**를 후보로 두고
    // 피치 안 + 구역 밖인 것 중 **가장 가까운** 출구를 고른다(결정론: 고정 순서, 난수 없음).
    let bx = x - zone.x;
    let by = y - zone.y;
    let bd = isqrt(bx * bx + by * by);
    if (bd === 0) ({ dx: bx, dy: by, d: bd } = centerBearing(pitch, zone));
    const need = zone.rFx + margin;
    for (const [c, sn] of RAY_DIRS) {
      // 정수 방위 테이블로 회전한다. Math.cos/sin 은 IEEE754 상 **정확 반올림이 보장되지 않아**
      // 플랫폼별로 다른 좌표가 나올 수 있다(하이진 grep 은 전역 난수·시계 API 만 본다).
      const nx = zone.x + Math.round((need * (bx * c - by * sn)) / (bd * RAY_SCALE));
      const ny = zone.y + Math.round((need * (bx * sn + by * c)) / (bd * RAY_SCALE));
      cands.push({ x: nx, y: ny, d: isqrt((nx - x) * (nx - x) + (ny - y) * (ny - y)) });
    }
  }
  let best: { x: number; y: number; d: number } | null = null;
  for (const c of cands) {
    const q = clampToPitch(pitch, c.x, c.y);
    if (q.x !== c.x || q.y !== c.y) continue; // 피치 밖 출구는 못 쓴다(클램프가 도로 안으로 끌어당김).
    if (deadBallClearance(zone, c.x, c.y) < 0) continue; // 원∪박스 중 다른 쪽에 여전히 걸림.
    if (!best || c.d < best.d) best = c;
  }
  return best ? { x: best.x, y: best.y } : null;
}

/**
 * (x,y) 에 선 상대가 물러날 지점(fixed).
 *  - 구역 **안**이면 가장 가까운 출구(최소 이동, 여유 단조 증가).
 *  - 구역 **밖**(전술 목표만 안쪽)이면 스팟에서 자기 방위로 경계까지 = 벽 세우고 서기.
 *    자기 방위를 쓰므로 구역을 가로지르지 않는다(반대편 경계로 보내면 스팟을 더 가깝게 지나친다).
 */
export function deadBallRetreatPoint(
  pitch: Pitch,
  zone: DeadBallZone,
  config: EngineConfig,
  x: number,
  y: number,
): { x: number; y: number } {
  if (deadBallClearance(zone, x, y) < 0) {
    const e = nearestExit(pitch, zone, config, x, y);
    if (e) return e;
  }
  const margin = toFixed(config.rules.deadBall.marginM, config.fixedScale);
  let dx = x - zone.x;
  let dy = y - zone.y;
  let d = isqrt(dx * dx + dy * dy);
  if (d === 0) ({ dx, dy, d } = centerBearing(pitch, zone));

  const need = exitRadius(zone, dx, dy, d, margin);
  const px = zone.x + Math.round((dx * need) / d);
  const py = zone.y + Math.round((dy * need) / d);
  const c = clampToPitch(pitch, px, py);
  // 함정: 스팟이 라인 근처면 그 방위의 탈출점이 **피치 밖**이라 클램프가 도로 구역 안으로
  // 끌어당긴다(수비수가 경계 못 넘고 고정됨) → 중앙 방위로 폴백.
  // 폴백 판정은 **클램프가 실제로 점을 옮겼는지(정수 비교)** 로만 한다. 거리 비교로 하면
  // 고정소수 반올림 때문에 매 틱 판정이 뒤집혀 목표가 진동한다(실측 7.4↔4.2m 왕복).
  if (c.x === px && c.y === py) return c;

  const b = centerBearing(pitch, zone);
  const needC = exitRadius(zone, b.dx, b.dy, b.d, margin);
  return clampToPitch(pitch, zone.x + Math.round((b.dx * needC) / b.d), zone.y + Math.round((b.dy * needC) / b.d));
}

/**
 * 일방통행 벽 — 이 이동을 취소해야 하는가. (목표가 밖이어도 **거기까지 가는 직선 경로가 구역을
 * 가로지를 수 있다**.) 밀어내지 않고 이동을 멈추는 것이라 순간이동이 생기지 않는다.
 *
 *  - 밖 → 안: 무조건 금지(진입 차단).
 *  - 이미 안: **자기 출구(targetFx)에 가까워지는 이동만 허용**. 여유(clearance)만으로 판정하면
 *    출구가 스팟 반대편일 때 나가는 길에 여유가 잠깐 줄어드는 것을 막아 **선수가 굳는다**
 *    (실측: 파울러가 스팟 1.5m 옆에서 11틱 완전 정지). 출구까지 거리는 단조 감소하므로 안전하다.
 */
export function deadBallBlocked(
  zone: DeadBallZone,
  player: SimPlayer,
  next: { x: number; y: number },
): boolean {
  const c1 = deadBallClearance(zone, next.x, next.y);
  if (c1 >= 0) return false;
  const c0 = deadBallClearance(zone, player.posFx.x, player.posFx.y);
  if (c0 >= 0) return true; // 밖 → 안 진입.
  const t = player.targetFx;
  const dNow = isqrt((player.posFx.x - t.x) * (player.posFx.x - t.x) + (player.posFx.y - t.y) * (player.posFx.y - t.y));
  const dNext = isqrt((next.x - t.x) * (next.x - t.x) + (next.y - t.y) * (next.y - t.y));
  return dNext >= dNow;
}
