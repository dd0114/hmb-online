// QA 초단위 시간 컨트롤 — 순수 로직(React/DOM 의존 0). #180
//
// 왜: hero 가 게임 QA 중 "몇 분 몇 초에 무엇이 있었다"를 정확히 짚어야 하는데, 재생이 빨라
// 초 단위로 세울 수단이 없었다(#177 로 시계는 돌아왔지만 **이동**은 여전히 거칠었다).
//
// ⚠️ 코어 계약 주의: `jumpToTick(t)` 은 맥락을 보여주려고 **3 스냅샷 앞**으로 되감는다
// (`viewer.impl.mjs` jumpToTick). 정확히 그 초에 세우려면 `hooks.seek(t)` 를 써야 한다.
// 이 모듈은 "어느 틱으로 갈지"만 계산하고, 호출은 컴포넌트가 seek 으로 한다.

/** 엔진 1틱 = 1 게임초. */
export const TICK_PER_SECOND = 1;

/** 재생 위치 범위 안으로 자른다. */
export function clampTick(tick: number, lastTick: number): number {
  if (!Number.isFinite(tick)) return 0;
  return Math.max(0, Math.min(Math.round(tick), Math.max(0, Math.round(lastTick))));
}

/** 현재 틱에서 초 단위로 이동한 목표 틱(범위 클램프). */
export function stepSeconds(current: number, deltaSeconds: number, lastTick: number): number {
  return clampTick(current + deltaSeconds * TICK_PER_SECOND, lastTick);
}

/**
 * `mm:ss` 입력 → 틱. 사람이 실제로 치는 형태를 관대하게 받는다:
 * `12:34` · `12'34"` · `12 34` · `1:2`(=1분 2초) · `754`(초만) · 공백 무시.
 * 해석 불가면 null(조용히 무시 — 오타로 엉뚱한 데로 튀지 않게).
 */
export function parseClockInput(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (s === "") return null;
  const m = s.match(/^(\d+)\s*[:'’\s]\s*(\d{1,2})"?$/);
  if (m) {
    const min = Number(m[1]);
    const sec = Number(m[2]);
    if (sec > 59) return null;
    return min * 60 + sec;
  }
  if (/^\d+$/.test(s)) return Number(s); // 초(=틱)만 적은 경우
  return null;
}

/** 스냅샷 인덱스 → 스크럽 % (코어 scrubTo 는 % 를 받는다). */
export function pctFromIndex(index: number, snapCount: number): number {
  if (snapCount <= 1) return 0;
  const i = Math.max(0, Math.min(index, snapCount - 1));
  return (i / (snapCount - 1)) * 100;
}

/** 스크럽 % → 스냅샷 인덱스(정수 스냅 — 슬라이더가 스냅샷 사이에 어정쩡하게 서지 않게). */
export function indexFromPct(pct: number, snapCount: number): number {
  if (snapCount <= 1) return 0;
  const raw = (pct / 100) * (snapCount - 1);
  return Math.max(0, Math.min(Math.round(raw), snapCount - 1));
}

/** 키보드 단축키 해석 결과. */
export type QaKeyAction =
  | { kind: "second"; delta: number }
  | { kind: "frame"; delta: number }
  | { kind: "toggle" };

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  /** 입력창에 타이핑 중이면 단축키를 먹지 않는다. */
  typing?: boolean;
}

/**
 * QA 단축키: ←/→ = ∓1초, Shift+←/→ = ∓5초, `,`/`.` = ∓1프레임(스냅샷), Space = 재생/정지.
 * 입력창 포커스 중(typing)에는 아무것도 하지 않는다.
 */
export function qaKeyAction({ key, shiftKey, typing }: KeyLike): QaKeyAction | null {
  if (typing) return null;
  switch (key) {
    case "ArrowLeft":
      return { kind: "second", delta: shiftKey ? -5 : -1 };
    case "ArrowRight":
      return { kind: "second", delta: shiftKey ? 5 : 1 };
    case ",":
      return { kind: "frame", delta: -1 };
    case ".":
      return { kind: "frame", delta: 1 };
    case " ":
      return { kind: "toggle" };
    default:
      return null;
  }
}
