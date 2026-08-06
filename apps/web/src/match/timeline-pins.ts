// 타임라인 이벤트 핀 — 순수 로직(React/DOM 의존 0). #177
//
// 구 QA 뷰어 셸(packages/engine/dev-viewer/index.html §buildMarks)이 갖고 있던 "몇 분 몇 초에
// 무슨 장면" 핀을 web 호스트로 되살린다. S3(iframe 제거)에서 셸이 사라지며 유실된 도구다.
// 색·높이·우선순위(골>PK>선방>유효슛>코너)는 구 셸과 동일하게 맞춘다 — QA 가 눈에 익은 표기를
// 그대로 쓰게(재학습 비용 0).

import { TEAM_COLORS } from "../common/team-colors";

export type PinKind = "goal" | "penalty" | "save" | "shot_on" | "corner";

export interface TimelinePin {
  /** 점프 대상 틱(=게임초). */
  tick: number;
  kind: PinKind;
  /** 타임라인 가로 위치(%) — 스냅샷 인덱스 기준(틱 기준이 아니다: 서브샘플 로그 대응). */
  pct: number;
  color: string;
  /** 핀 높이(px) — 중요할수록 크다. */
  height: number;
  width: number;
  z: number;
  /**
   * 큰 장면(골/PK/선방)인가 — 트랙 **위 레인**에 그린다. 작은 장면(유효슛/코너)은 아래 레인.
   * 90분 경기면 핀이 60개를 넘어 한 줄에 겹치고, 겹치면 뒤 핀은 **클릭조차 막힌다**(실측).
   */
  major: boolean;
  /** 툴팁 문구(`48' · GOAL`). */
  label: string;
  /** 화면에 쓸 **표기 분** 문구(`48'`). 로그가 구운 값이다 — 아래 `pinClock` 참조(#388). */
  clock: string;
}

/**
 * 틱(=엔진 1틱 = 1 게임초) → `12'34"`. **폴백 전용**(#388).
 *
 * ⚠️ 이 값은 **표기 분이 아니다.** 엔진은 45분(하프 1350틱)을 돌리고 표기만 0~90' 로 스케일해
 * (`displayMinutes`, #365) 이벤트에 `minute` 을 구워 내린다 — 그래서 틱을 직독하면 정확히 절반이
 * 나온다(로그줄 48' 옆에서 이 함수는 24'00" 라고 말했다). 지금은 `minute` 이 없는 로그(구 서버·
 * 손상 응답)에서만 쓰인다. **새 소비자를 여기에 붙이지 마라 — `pinClock` 을 써라.**
 */
export function formatMatchClock(tick: number): string {
  const t = Math.max(0, Math.floor(tick));
  return `${Math.floor(t / 60)}'${String(t % 60).padStart(2, "0")}"`;
}

/**
 * 핀/장면 목록이 쓸 시각 = **로그가 구운 표기 분** (#388).
 *
 * 로그줄(`LogPanel` 의 `l.minute`)과 **같은 출처**라 갈라질 수 없다. 초를 버리는 것은 의도다 —
 * 초까지 쓰려면 표기 스케일을 화면에서 다시 유도해야 하고, 그 재유도가 정확히 이 결함의 모양이다.
 * 축구 화면의 관례도 분이다. `minute` 이 없는 로그에서만 틱 기반 폴백으로 내려간다.
 */
export function pinClock(e: PinEventLike): string {
  return typeof e.minute === "number" && Number.isFinite(e.minute)
    ? `${Math.max(0, Math.floor(e.minute))}'`
    : formatMatchClock(typeof e.tick === "number" ? e.tick : 0);
}

export interface PinEventLike {
  tick: number;
  /** 엔진이 구워 내린 표기 분(0~90'). 로그줄이 그리는 그 값이다. */
  minute?: number;
  type?: string;
  detail?: string;
  team?: string;
}

/** 이 이벤트가 핀으로 찍히는 장면인가(아니면 null). 구 셸 규칙과 동일. */
function kindOf(e: PinEventLike): PinKind | null {
  if (e.type === "goal") return "goal";
  if (e.type === "penalty") return "penalty";
  if (e.type === "save") return "save";
  // 빗나간 슛은 핀을 찍지 않는다(유효슛만) — 핀이 과밀해지면 골을 못 찾는다.
  if (e.type === "shot" && e.detail !== "off_target") return "shot_on";
  if (e.type === "kickoff" && e.detail === "corner") return "corner";
  return null;
}

const STYLE: Record<PinKind, { height: number; width: number; z: number; color: string }> = {
  // 골 핀만 팀색이다(나머지는 장면 종류색). 홈이 기본이고 원정은 아래에서 덮는다.
  // ⚠️ 색은 `common/team-colors.ts` 가 SoT — 여기 리터럴을 되살리면 화면마다 팀색이 갈린다(#456 B4).
  goal: { height: 16, width: 3, z: 5, color: TEAM_COLORS.home.strong },
  penalty: { height: 14, width: 3, z: 4, color: "#22c55e" },
  save: { height: 11, width: 2, z: 3, color: "#38bdf8" },
  shot_on: { height: 8, width: 2, z: 2, color: "#fbbf24" },
  corner: { height: 8, width: 2, z: 1, color: "#94a3b8" },
};

const LABEL: Record<PinKind, string> = {
  goal: "GOAL",
  penalty: "PK",
  save: "Save",
  shot_on: "On target",
  corner: "Corner",
};

/**
 * 이벤트 목록 → 타임라인 핀. `idxOfTick` 은 코어 훅(틱 → 스냅샷 인덱스)이고 `snapCount` 는 총
 * 스냅샷 수 — 스크럽 바가 인덱스 비율로 움직이므로 핀도 같은 기준이어야 위치가 맞는다.
 */
/**
 * 이 간격(%)보다 가까운 같은 레인 핀은 **하나로 합친다**(우선순위 높은 쪽만 남김).
 * 90분 경기에선 1초 차 이벤트가 픽셀 단위로 겹쳐 **뒤 핀이 앞 핀의 클릭을 막는다**(실측:
 * 유효슛 t=95 위에 t=96 이 올라타 클릭 불가). 골 옆의 슛/코너보다 골을 남기는 게 QA 에 유용하다.
 */
const MIN_PIN_GAP_PCT = 0.45;

export function buildTimelinePins(
  events: readonly PinEventLike[] | null | undefined,
  idxOfTick: (tick: number) => number,
  snapCount: number,
  minGapPct: number = MIN_PIN_GAP_PCT,
): TimelinePin[] {
  if (!events || snapCount <= 1) return [];
  const pins: TimelinePin[] = [];
  for (const e of events) {
    const kind = kindOf(e);
    if (!kind || typeof e.tick !== "number") continue;
    const idx = idxOfTick(e.tick);
    if (!(idx >= 0)) continue;
    const s = STYLE[kind];
    const color = kind === "goal" && e.team === "away" ? TEAM_COLORS.away.strong : s.color;
    pins.push({
      tick: e.tick,
      kind,
      pct: Math.max(0, Math.min(100, (idx / (snapCount - 1)) * 100)),
      color,
      height: s.height,
      width: s.width,
      z: s.z,
      major: kind === "goal" || kind === "penalty" || kind === "save",
      clock: pinClock(e),
      label: `${pinClock(e)} · ${kind === "goal" && e.team ? `${e.team.toUpperCase()} GOAL` : LABEL[kind]}`,
    });
  }
  return dedupeClusters(pins, minGapPct);
}

/**
 * 레인(major/minor)별로 가까운 핀 뭉치를 하나로 — 뭉치 안에서 우선순위(z)가 가장 높은 핀,
 * 같으면 먼저 일어난 핀을 남긴다. 결과는 원래 순서(시간순)를 유지한다.
 */
function dedupeClusters(pins: TimelinePin[], minGapPct: number): TimelinePin[] {
  if (minGapPct <= 0) return pins;
  const keep = new Set<TimelinePin>();
  for (const lane of [true, false]) {
    const lanePins = pins.filter((p) => p.major === lane).sort((a, b) => a.pct - b.pct || a.tick - b.tick);
    let cluster: TimelinePin[] = [];
    const flush = () => {
      if (cluster.length === 0) return;
      const best = cluster.reduce((a, b) => (b.z > a.z || (b.z === a.z && b.tick < a.tick) ? b : a));
      keep.add(best);
      cluster = [];
    };
    for (const p of lanePins) {
      const prev = cluster[cluster.length - 1];
      if (prev && p.pct - prev.pct > minGapPct) flush();
      cluster.push(p);
    }
    flush();
  }
  return pins.filter((p) => keep.has(p));
}
