/**
 * 캐릭터 에셋 번들 로더 — 스테이징된 정적 파일 3개를 한 번만 받아 캐시한다(#145).
 *
 * 받는 것(전부 `scripts/build-chars.mjs` 스테이징 산출물, 토큰 불필요한 정적 파일):
 *   `/chars/characters/manifest.json` — 확정 캐릭터 14종(아틀라스 좌표 + 풀아트 카드 경로)
 *   `/chars/manifest.json`            — 플레이스홀더 172명(폴백 아틀라스 좌표)
 *   `/chars/player-chars.json`        — 선수 → 캐릭터 매핑(data/ 발행물 `player-chars.v1.json`)
 *
 * 실패해도 앱은 계속 돈다: 번들이 없으면 전 컴포넌트가 CSS 플레이스홀더로 떨어진다(깨짐 0).
 * 그래서 reject 하지 않고 **부분/빈 번들**을 돌려준다 — 에셋 미배포가 화면 전체를 죽이면 안 된다.
 */
import type { CharactersManifest, PlaceholderManifest } from "./char-manifest";
import { CHARS_BASE } from "./char-manifest";

/** data/ 발행 매핑 파일의 소비 측 투영(쓰는 필드만). */
export interface PlayerCharsMap {
  version?: string;
  players: Record<string, string | undefined>;
}

export interface CharAssets {
  characters: CharactersManifest | null;
  placeholders: PlaceholderManifest | null;
  mapping: PlayerCharsMap | null;
}

export const EMPTY_ASSETS: CharAssets = { characters: null, placeholders: null, mapping: null };

/** 개별 실패를 null 로 흡수 — 하나가 없어도 나머지는 쓴다(부분 열화 > 전체 실패). */
async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchCharAssets(base: string = CHARS_BASE): Promise<CharAssets> {
  const [characters, placeholders, mapping] = await Promise.all([
    fetchJson<CharactersManifest>(`${base}/characters/manifest.json`),
    fetchJson<PlaceholderManifest>(`${base}/manifest.json`),
    fetchJson<PlayerCharsMap>(`${base}/player-chars.json`),
  ]);
  return { characters, placeholders, mapping };
}

// ── 모듈 싱글턴 캐시 + 구독 ──────────────────────────────────────────────────
//
// 왜 TanStack Query 를 안 쓰는가: 아바타는 도감·덱·상점·트레이드 등 **어디서나** 쓰이는데,
// useQuery 를 쓰면 그 컴포넌트를 렌더하는 모든 곳(기존 단위테스트 포함)이 QueryClientProvider
// 를 요구하게 된다. 토큰도 무효화도 필요 없는 정적 파일이라 모듈 싱글턴 + useSyncExternalStore
// 로 충분하고, 소비처에 아무 요구사항도 얹지 않는다.
let inflight: Promise<CharAssets> | null = null;
let cached: CharAssets | null = null;
const listeners = new Set<() => void>();

export function loadCharAssets(base: string = CHARS_BASE): Promise<CharAssets> {
  if (!inflight) {
    inflight = fetchCharAssets(base).then((assets) => {
      cached = assets;
      for (const l of [...listeners]) l();
      return assets;
    });
  }
  return inflight;
}

/** 현재 스냅샷 — 아직 안 왔으면 안정된 빈 번들(참조 동일 → 리렌더 루프 없음). */
export function charAssetsSnapshot(): CharAssets {
  return cached ?? EMPTY_ASSETS;
}

/** 스냅샷 변경 구독. 첫 구독이 로드를 시작한다(렌더 중 부수효과 없음). */
export function subscribeCharAssets(onChange: () => void): () => void {
  listeners.add(onChange);
  if (!cached) void loadCharAssets();
  return () => {
    listeners.delete(onChange);
  };
}

/** 테스트 전용 — 캐시 리셋(프로덕션 경로에서는 호출하지 않는다). */
export function resetCharAssetsCache(): void {
  inflight = null;
  cached = null;
  listeners.clear();
}

/**
 * playerId → charId. 매핑이 없으면 null(호출부가 플레이스홀더 축으로 폴백).
 *
 * `hasOwnProperty` 로 자기 소유 키만 본다: `JSON.parse` 결과는 Object.prototype 을 가지므로
 * 그냥 인덱싱하면 `charIdFor(a, "constructor")` 가 **함수**를 돌려줘 선언 타입(`string|null`)이
 * 깨진다(char-manifest.ts 의 `own()` 과 같은 이유·같은 가드).
 */
export function charIdFor(assets: CharAssets, playerId: string | null | undefined): string | null {
  const players = assets.mapping?.players;
  if (!playerId || typeof playerId !== "string" || !players) return null;
  if (!Object.prototype.hasOwnProperty.call(players, playerId)) return null;
  const charId = players[playerId];
  return typeof charId === "string" ? charId : null;
}
