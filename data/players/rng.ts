/**
 * rng — 시드 결정론 난수기(mulberry32).
 *
 * `packages/engine/src/rng.ts` 의 복사 구현이다. LLD-data §2: "엔진 rng 유틸 재사용 가능하나
 * 엔진 코드 수정 금지, 복사 구현 허용" — data 도메인은 packages/engine/** 을 import/수정하지 않고
 * 이 파일을 독립 소유한다.
 *
 * 규칙: 표준 전역 난수 API(Math.random 등) 절대 금지. 시드 RNG 인스턴스를 인자로 관통시켜
 * 전역 상태 없이 쓴다.
 *
 * seed 는 임의 문자열 → 32bit 해시로 초기화한다.
 */

/** 문자열 → 32bit 부호없는 해시(xfnv1a). 결정론적. */
export function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface Rng {
  /** [0,1) 균등 난수. */
  next(): number;
  /** [0,n) 정수. */
  nextInt(n: number): number;
  /** 현재 내부 상태(uint32) 반환 — 재개용. */
  serialize(): number;
  /** 상태 복원. */
  restore(state: number): void;
}

/** mulberry32 기반 RNG 인스턴스 생성. */
export function createRng(seedStr: string): Rng {
  let state = hashSeed(seedStr) >>> 0;

  function next(): number {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    nextInt(n: number): number {
      if (n <= 0) return 0;
      return Math.floor(next() * n);
    },
    serialize(): number {
      return state >>> 0;
    },
    restore(s: number): void {
      state = s >>> 0;
    },
  };
}
