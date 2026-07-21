/**
 * 캐릭터 에셋 manifest 소비 계층 — **순수 로직만**(fetch/DOM/React 의존 0, 단위검증 대상).
 * SoT = 발행물 `design/characters/dist/**`. web 은 `scripts/build-chars.mjs` 가 `/chars/` 로
 * 스테이징한 사본을 런타임 fetch 한다(번들 import 아님 — 172명 아틀라스를 JS 번들에 넣지 않는다).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 두 축은 **합치지 않는다**(발행 계약 — #121 코멘트). 각자 manifest 를 갖는다.
 *   1) 캐릭터 축   `/chars/characters/manifest.json` — 확정 원화 14종(원본 12 + hue변형 2).
 *      characters[charId] = { col, row, position, card } (+ 변형은 variant/forPlayer)
 *      → **풀아트 카드**(card) + 아바타/스프라이트 아틀라스(4×4).
 *   2) 플레이스홀더 축 `/chars/manifest.json` — 선수 172명 전원.
 *      players[playerId] = { col, row, position, grade, initials } (아틀라스 14×13)
 *      → 캐릭터 매핑이 없는 선수의 **폴백**. 풀아트 카드는 없다(등급 프레임만 별도 제공).
 *
 * 폴백 체인(깨짐 0): 캐릭터 타일 → 플레이스홀더 타일 → (호출부의) CSS 플레이스홀더.
 *
 * ⚠️ 여기엔 **선수↔캐릭터 매핑이 없다.** 매핑 규칙은 hero 확정 대기 중(#145) — 확정되면
 *    별도 모듈(`char-mapping`)이 playerId → charId 를 결정하고, 이 모듈은 그 결과의
 *    타일 좌표/URL 만 계산한다. 축 분리를 유지해 매핑이 바뀌어도 여기는 안 바뀌게 한다.
 * ════════════════════════════════════════════════════════════════════════════
 */

/** 스테이징 루트(vite public → 오리진 절대경로로 서빙). */
export const CHARS_BASE = "/chars";

// ── manifest 형상 (발행 계약의 소비 측 투영 — 쓰는 필드만 좁게 선언) ────────────

/**
 * 아틀라스 1종 = 정사각 타일 격자. `file` 은 manifest 기준 상대경로.
 *
 * ⚠️ 발행물의 `atlases` 맵에는 **격자가 아닌 항목도 섞여 있다** — 플레이스홀더 축의
 * `frame-<GRADE>` 는 `{file,w,h,stars}` 라 tile/cols/rows 가 없다. 그래서 이 계층은 조회할 때마다
 * 격자 형상을 검사하고(`isGridAtlas`), 프레임은 전용 접근자(`frameUrl`)로만 노출한다.
 */
export interface AtlasSpec {
  file: string;
  tile: number;
  cols: number;
  rows: number;
}

/** 확정 캐릭터 1종. `card` = 풀아트 카드 상대경로(프레임 합성 완료본). */
export interface CharacterEntry {
  col: number;
  row: number;
  position: string;
  card: string;
  variant?: { of: string; hueDeg: number };
  forPlayer?: string;
}

export interface CharactersManifest {
  kind?: string;
  count?: number;
  atlases: Record<string, AtlasSpec | undefined>;
  characters: Record<string, CharacterEntry | undefined>;
}

/** 플레이스홀더 축의 선수 1명. */
export interface PlaceholderEntry {
  col: number;
  row: number;
  position?: string;
  grade?: string;
  initials?: string;
}

export interface PlaceholderManifest {
  source?: string;
  playerCount?: number;
  atlases: Record<string, AtlasSpec | undefined>;
  players: Record<string, PlaceholderEntry | undefined>;
}

// ── 타일 좌표 계산 ──────────────────────────────────────────────────────────

/** 아틀라스에서 잘라 쓸 타일 1장. CSS background-position 은 음수 오프셋을 쓴다. */
export interface TileRef {
  /** 아틀라스 이미지 URL(오리진 절대경로). */
  url: string;
  /** 타일 픽셀 크기(정사각). */
  tile: number;
  /** 아틀라스 안 타일 좌상단 픽셀 오프셋. */
  x: number;
  y: number;
  /** 아틀라스 전체 픽셀 크기 — CSS background-size 에 그대로 쓴다. */
  sheetWidth: number;
  sheetHeight: number;
}

/**
 * manifest 상대경로(`characters/avatars-64.png`) → 서빙 URL.
 * 경로 탈출(`..`)은 거부한다 — 입력은 신뢰 발행물이지만 손상 manifest 방어가 이 계층의 취지다.
 */
export function assetUrl(relPath: string, base: string = CHARS_BASE): string | null {
  if (typeof relPath !== "string" || relPath === "") return null;
  const clean = relPath.replace(/^\.?\//, "");
  if (clean.split("/").some((seg) => seg === "..")) return null;
  return `${base}/${clean}`;
}

/**
 * manifest 에서 **자기 소유 키만** 꺼낸다. `JSON.parse` 결과는 Object.prototype 을 갖기 때문에
 * `atlases["constructor"]`·`["__proto__"]` 같은 이름이 상속 멤버로 truthy 하게 잡힌다
 * (그대로 두면 형상 가드를 통과해 undefined 필드로 터진다).
 */
function own<T>(record: Record<string, T | undefined> | null | undefined, key: string): T | undefined {
  if (!record || typeof key !== "string") return undefined;
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * 격자 아틀라스로 쓸 수 있는 형상인가.
 *
 * 왜 필요한가: 플레이스홀더 manifest 의 `atlases` 에는 격자가 아닌 항목(`frame-<GRADE>` =
 * `{w,h,stars}`)이 **같이 들어있다**. tile/cols/rows 가 없으면 `0 >= undefined` 가 false 라
 * 범위 가드를 그대로 통과해 NaN 좌표가 새어나간다 → CSS 가 `background-size:auto` 로 떨어져
 * 프레임 원본이 타일 박스에 통째로 노출된다. 그래서 **형상부터 검사**한다.
 * (등급 프레임은 격자가 아니므로 전용 접근자 `frameUrl` 로 쓴다.)
 */
function isGridAtlas(a: AtlasSpec | undefined): a is AtlasSpec {
  return (
    !!a &&
    typeof a.file === "string" &&
    Number.isFinite(a.tile) &&
    a.tile > 0 &&
    Number.isInteger(a.cols) &&
    a.cols > 0 &&
    Number.isInteger(a.rows) &&
    a.rows > 0
  );
}

/**
 * 아틀라스 + 격자 좌표 → 타일 참조. 좌표가 격자 밖이면 null(깨진 렌더 대신 폴백).
 * 아틀라스 이름이 없거나 격자 아틀라스가 아니어도 null — **어떤 입력에도 throw 하지 않는다.**
 */
export function tileFrom(
  atlases: Record<string, AtlasSpec | undefined>,
  atlasName: string,
  cell: { col: number; row: number },
  base: string = CHARS_BASE,
): TileRef | null {
  const a = own(atlases, atlasName);
  if (!isGridAtlas(a)) return null;
  if (!cell || !Number.isInteger(cell.col) || !Number.isInteger(cell.row)) return null;
  if (cell.col < 0 || cell.row < 0 || cell.col >= a.cols || cell.row >= a.rows) return null;
  const url = assetUrl(a.file, base);
  if (!url) return null;
  return {
    url,
    tile: a.tile,
    x: cell.col * a.tile,
    y: cell.row * a.tile,
    sheetWidth: a.cols * a.tile,
    sheetHeight: a.rows * a.tile,
  };
}

/** 확정 캐릭터의 아틀라스 타일. charId 미등록/좌표 이상이면 null. */
export function characterTile(
  manifest: CharactersManifest | null | undefined,
  charId: string | null | undefined,
  atlasName: string,
  base: string = CHARS_BASE,
): TileRef | null {
  if (!manifest || !charId) return null;
  const c = own(manifest.characters, charId);
  if (!c) return null;
  return tileFrom(manifest.atlases, atlasName, c, base);
}

/** 확정 캐릭터의 풀아트 카드 URL. 미등록이면 null. */
export function characterCardUrl(
  manifest: CharactersManifest | null | undefined,
  charId: string | null | undefined,
  base: string = CHARS_BASE,
): string | null {
  if (!manifest || !charId) return null;
  const c = own(manifest.characters, charId);
  return c?.card ? assetUrl(c.card, base) : null;
}

/**
 * 등급 프레임 이미지 URL. **격자 아틀라스가 아니다**(`{file,w,h,stars}`) — tileFrom 으로 부르면
 * null 이 나오므로 이 전용 접근자를 쓴다. 미등록/형상 이상이면 null.
 */
export function frameUrl(
  manifest: PlaceholderManifest | null | undefined,
  grade: string | null | undefined,
  base: string = CHARS_BASE,
): string | null {
  if (!manifest || !grade) return null;
  const f = own(manifest.atlases, `frame-${grade}`) as { file?: string } | undefined;
  return typeof f?.file === "string" ? assetUrl(f.file, base) : null;
}

/** 플레이스홀더 축의 선수 타일. playerId 미등록/좌표 이상이면 null. */
export function placeholderTile(
  manifest: PlaceholderManifest | null | undefined,
  playerId: string | null | undefined,
  atlasName: string,
  base: string = CHARS_BASE,
): TileRef | null {
  if (!manifest || !playerId) return null;
  const p = own(manifest.players, playerId);
  if (!p) return null;
  return tileFrom(manifest.atlases, atlasName, p, base);
}

/**
 * 폴백 체인 1스텝: 캐릭터 타일이 있으면 그것, 없으면 플레이스홀더 타일, 그것도 없으면 null.
 * (null 이면 호출부가 CSS 플레이스홀더로 떨어진다 — 깨진 <img> 는 어떤 경우에도 없다.)
 */
export function resolveTile(args: {
  characters: CharactersManifest | null | undefined;
  placeholders: PlaceholderManifest | null | undefined;
  charId: string | null | undefined;
  playerId: string | null | undefined;
  atlas: string;
  base?: string;
}): { tile: TileRef; kind: "character" | "placeholder" } | null {
  const base = args.base ?? CHARS_BASE;
  const c = characterTile(args.characters, args.charId, args.atlas, base);
  if (c) return { tile: c, kind: "character" };
  const p = placeholderTile(args.placeholders, args.playerId, args.atlas, base);
  if (p) return { tile: p, kind: "placeholder" };
  return null;
}

/**
 * 타일을 `size` 픽셀 정사각으로 보여주는 CSS 속성. 스프라이트 확대 시 뭉개짐 방지로
 * `imageRendering: pixelated` 고정(도트 원본 — 보간하면 흐려진다).
 */
export function tileStyle(tile: TileRef, size: number): Record<string, string> {
  const k = size / tile.tile;
  return {
    width: `${size}px`,
    height: `${size}px`,
    backgroundImage: `url(${tile.url})`,
    backgroundSize: `${tile.sheetWidth * k}px ${tile.sheetHeight * k}px`,
    backgroundPosition: `-${tile.x * k}px -${tile.y * k}px`,
    backgroundRepeat: "no-repeat",
    imageRendering: "pixelated",
  };
}
