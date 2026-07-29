/**
 * 캐릭터 에셋 번들 로더 — 스테이징된 정적 파일 3개를 한 번만 받아 캐시한다(#145).
 *
 * 받는 것(전부 `scripts/build-chars.mjs` 스테이징 산출물, 토큰 불필요한 정적 파일):
 *   `/chars/characters/manifest.json` — 확정 캐릭터 14종(아틀라스 좌표 + 풀아트 카드 경로)
 *   `/chars/units/manifest.json`      — hero 입고 실아트 6종(#207 W3-B, 완성카드/프레임리스 구분)
 *   `/chars/manifest.json`            — 플레이스홀더 172명(폴백 아틀라스 좌표)
 *   `/chars/player-chars.json`        — 선수 → 아트 매핑(data/ 발행물 `player-chars.v2.json`)
 *
 * 실패해도 앱은 계속 돈다: 번들이 없으면 전 컴포넌트가 CSS 플레이스홀더로 떨어진다(깨짐 0).
 * 그래서 reject 하지 않고 **부분/빈 번들**을 돌려준다 — 에셋 미배포가 화면 전체를 죽이면 안 된다.
 */
import type { CharRef, CharactersManifest, PlaceholderManifest, UnitsManifest } from "./char-manifest";
import { CHARS_BASE, charsBase, setCharsBase } from "./char-manifest";
import { apiUrl } from "../api/client";

/**
 * data/ 발행 매핑 파일의 소비 측 투영(쓰는 필드만).
 *
 * ⚠️ 값의 형이 **버전마다 다르다**: v1 = `charId` 문자열, v2(#207) = `{axis,id}` 객체.
 * 두 형을 다 받아 `charRefFor` 가 정규화한다 — 구 발행물로 롤백해도 화면이 죽지 않게.
 */
export interface PlayerCharsMap {
  version?: string;
  players: Record<string, CharRef | string | undefined>;
}

export interface CharAssets {
  characters: CharactersManifest | null;
  units: UnitsManifest | null;
  placeholders: PlaceholderManifest | null;
  mapping: PlayerCharsMap | null;
}

export const EMPTY_ASSETS: CharAssets = {
  characters: null,
  units: null,
  placeholders: null,
  mapping: null,
};

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

export async function fetchCharAssets(base: string = charsBase()): Promise<CharAssets> {
  const [characters, units, placeholders, mapping] = await Promise.all([
    fetchJson<CharactersManifest>(`${base}/characters/manifest.json`),
    fetchJson<UnitsManifest>(`${base}/units/manifest.json`),
    fetchJson<PlaceholderManifest>(`${base}/manifest.json`),
    fetchJson<PlayerCharsMap>(`${base}/player-chars.json`),
  ]);
  return { characters, units, placeholders, mapping };
}

/* ────────────── 서버 아트 번들 해석 (#309 W2) ──────────────
 * 운영자가 admin 에서 아트 번들을 올려 켜면, 아트가 **웹 재배포 없이** 바뀐다. 그때 base 가
 * 백엔드 오리진으로 옮겨간다. 활성 번들이 없으면 **웹 빌드에 구운 `/chars`** 그대로다.
 *
 * ⚠️ **200 만으로 채택하지 않는다.** 목·프록시·구 서버가 `{}` 를 주면 "아트 0개"가 정상처럼
 *    통과해 전 화면이 조용히 이니셜 폴백이 된다(#309 A6). 그래서 형태를 본다 —
 *    서버가 자기 리비전과 필수 파일 목록을 말해 줄 때만 그 base 를 쓴다.
 * ⚠️ 이 조회 하나가 아트 로딩을 붙잡지 않게 **짧은 타임아웃**을 건다. 실패는 전부 폴백이다.
 */

/** 활성 번들 신호. 서버가 `GET /api/chars/index` 로 답한다(없으면 404 = 폴백 트리거). */
const BUNDLE_INDEX_PATH = "/api/chars/index";
const BUNDLE_BASE_PATH = "/api/chars";
const BUNDLE_PROBE_TIMEOUT_MS = 3000;

interface BundleIndex {
  revision?: unknown;
  requiredEntries?: unknown;
}

/** 서버 응답이 **우리가 아는 번들 모양인가**. 아니면 폴백이 정답이다. */
export function isUsableBundleIndex(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const idx = raw as BundleIndex;
  if (typeof idx.revision !== "string" || !idx.revision) return false;
  return Array.isArray(idx.requiredEntries) && idx.requiredEntries.length > 0;
}

/**
 * 활성 번들이 있으면 그 base 를, 없으면 `null`(→ 구운 폴백)을 돌려준다.
 * **절대 throw 하지 않는다** — 아트 배포 채널의 장애가 화면을 죽이면 안 된다.
 */
export async function resolveCharsBase(): Promise<string | null> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), BUNDLE_PROBE_TIMEOUT_MS) : null;
  try {
    const res = await fetch(apiUrl(BUNDLE_INDEX_PATH), { signal: ctrl?.signal });
    if (!res.ok) return null;
    return isUsableBundleIndex(await res.json()) ? apiUrl(BUNDLE_BASE_PATH) : null;
  } catch {
    return null; // 오프라인·404·JSON 깨짐·타임아웃 — 전부 폴백으로 흡수
  } finally {
    if (timer) clearTimeout(timer);
  }
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

/**
 * 번들 해석 → 로드 → 캐시. `base` 를 **명시하면 해석을 건너뛴다**(테스트·프리뷰 하니스가 특정
 * 트리를 겨냥할 수 있게). 안 넘기면 서버 활성 번들을 한 번 물어보고, 없으면 구운 폴백이다.
 */
export function loadCharAssets(base?: string): Promise<CharAssets> {
  if (!inflight) {
    const resolved: Promise<string> = base !== undefined
      ? Promise.resolve(base)
      : resolveCharsBase().then((serverBase) => {
          // 여기서 정한 base 가 **URL 조립 전체**의 기준이 된다(아바타·카드·프레임·경기장 스킨).
          // 매니페스트만 서버에서 읽고 이미지를 웹 오리진에서 찾으면 전부 404 가 되므로 한 곳에서 정한다.
          setCharsBase(serverBase);
          return charsBase();
        });
    inflight = resolved
      .then((b) => fetchCharAssets(b))
      .then((assets) => {
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

/** 테스트 전용 — 캐시 리셋(프로덕션 경로에서는 호출하지 않는다). base 도 구운 폴백으로 되돌린다. */
export function resetCharAssetsCache(): void {
  inflight = null;
  cached = null;
  listeners.clear();
  setCharsBase(CHARS_BASE);
}

/**
 * playerId → **축 태그가 붙은 아트 참조**. 매핑이 없으면 null(호출부가 플레이스홀더 축으로 폴백).
 *
 * 두 발행 형을 다 받는다:
 *   v2(#207) `{axis:"characters"|"units", id}` → 그대로(모르는 axis 는 null — 틀린 축 조회 금지)
 *   v1       `"aura"` 문자열                    → `{axis:"characters", id}` 로 정규화
 *
 * `hasOwnProperty` 로 자기 소유 키만 본다: `JSON.parse` 결과는 Object.prototype 을 가지므로
 * 그냥 인덱싱하면 `charRefFor(a, "constructor")` 가 **함수**를 돌려줘 선언 타입이 깨진다
 * (char-manifest.ts 의 `own()` 과 같은 이유·같은 가드).
 */
export function charRefFor(assets: CharAssets, playerId: string | null | undefined): CharRef | null {
  const players = assets.mapping?.players;
  if (!playerId || typeof playerId !== "string" || !players) return null;
  if (!Object.prototype.hasOwnProperty.call(players, playerId)) return null;
  return normalizeCharRef(players[playerId]);
}

/** 매핑 원시값 → 정규화된 참조(두 발행 형 수용, 모르는 형은 null). 순수 함수. */
export function normalizeCharRef(raw: unknown): CharRef | null {
  if (typeof raw === "string") return raw ? { axis: "characters", id: raw } : null;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { axis?: unknown; id?: unknown };
  if (typeof r.id !== "string" || !r.id) return null;
  if (r.axis !== "characters" && r.axis !== "units") return null;
  return { axis: r.axis, id: r.id };
}

/**
 * 구 소비처 호환 — `characters` 축일 때만 charId 를 돌려준다.
 * units 축 항목에 대해 null 을 주는 것이 **의도**다: 캐릭터 manifest 에 없는 id 를 넘기면
 * 조회가 undefined 로 떨어질 뿐이지만, 그걸 "매핑 있음"으로 착각하는 코드가 생기면 안 된다.
 */
export function charIdFor(assets: CharAssets, playerId: string | null | undefined): string | null {
  const ref = charRefFor(assets, playerId);
  return ref?.axis === "characters" ? ref.id : null;
}
