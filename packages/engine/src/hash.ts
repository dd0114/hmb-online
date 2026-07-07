import type { SimState } from "./simstate";

/**
 * hash — 틱 상태 해시(FNV-1a, 32bit 정수).
 * 공/선수 좌표(fixed) + 소유 + 스코어를 정수 스트림으로 직렬화해 해시한다.
 * 재현/desync 검증에 쓰인다(동일 입력 → 동일 해시).
 */

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function mix(h: number, v: number): number {
  // 32bit 정수 v 를 4바이트로 흡수.
  let x = h;
  x ^= v & 0xff;
  x = Math.imul(x, FNV_PRIME);
  x ^= (v >>> 8) & 0xff;
  x = Math.imul(x, FNV_PRIME);
  x ^= (v >>> 16) & 0xff;
  x = Math.imul(x, FNV_PRIME);
  x ^= (v >>> 24) & 0xff;
  x = Math.imul(x, FNV_PRIME);
  return x >>> 0;
}

/**
 * 결정론 틱 해시. 선수는 id 정렬 순으로 좌표를 흡수(순서 독립성 보장).
 * 반환은 8자리 16진 문자열.
 */
export function hashState(state: SimState): string {
  let h = FNV_OFFSET >>> 0;
  h = mix(h, state.tick | 0);
  h = mix(h, state.score.home | 0);
  h = mix(h, state.score.away | 0);
  h = mix(h, state.ball.posFx.x | 0);
  h = mix(h, state.ball.posFx.y | 0);
  h = mix(h, state.possession === "home" ? 1 : 2);

  // id 정렬 사본으로 순서 독립.
  const sorted = [...state.players].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of sorted) {
    h = mix(h, p.posFx.x | 0);
    h = mix(h, p.posFx.y | 0);
    h = mix(h, Math.round(p.fatigue * 1e6) | 0);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
