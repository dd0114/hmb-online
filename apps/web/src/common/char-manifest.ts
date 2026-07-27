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
 *   3) 유닛 축   `/chars/units/manifest.json` — hero 입고 실아트 6종 (#207 W3-B).
 *      units[unitId] = { col, row, name, position, card:{file,kind,w,h,pixelArt?},
 *                        face, iconBackground, forPlayer?/forGrades? } (아틀라스 3×2)
 *      → **`card.kind` 가 소비 분기다**: `complete` = 프레임·이름판·별이 이미 구워진 완성 카드
 *        (frame-<GRADE>.png 합성 경로를 **타면 안 된다** — 등급 프레임이 겹친다),
 *        `frameless-art` = 투명 배경 캐릭터 아트(기존 합성 경로 그대로).
 *
 * 폴백 체인(깨짐 0): 유닛/캐릭터 타일 → 플레이스홀더 타일 → (호출부의) CSS 플레이스홀더.
 *
 * ⚠️ 여기엔 **선수↔아트 매핑이 없다.** 매핑은 data 발행물(`player-chars.v2.json`)이 소유하고
 *    `char-assets-store.charRefFor` 가 playerId → {axis,id} 를 결정한다. 이 모듈은 그 결과의
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

// ── 유닛 축 (#207 W3-B 발행 계약) ───────────────────────────────────────────

/**
 * 유닛 카드 1장. **`kind` 가 소비 분기**이고 유닛 이름 하드코딩은 금지다 —
 * 어떤 유닛이 완성 카드인지는 발행측이 정하고, 발행이 바뀌면 여기 코드는 안 바뀐다.
 */
export interface UnitCard {
  file: string;
  kind: "complete" | "frameless-art";
  w: number;
  h: number;
  /** 도트 원본이면 true — 확대 시 `image-rendering: pixelated` 로 그려야 뭉개지지 않는다. */
  pixelArt?: boolean;
}

/** 얼굴 아이콘의 배경 전제. `opaque-dark` = 불투명 다크 배경 위에 그려진 아트. */
export type IconBackground = "opaque-dark" | "transparent";

export interface UnitEntry {
  col: number;
  row: number;
  name?: string;
  position?: string | null;
  card?: UnitCard;
  face?: string;
  iconBackground?: string;
  forPlayer?: string;
  forGrades?: string[];
}

export interface UnitsManifest {
  kind?: string;
  count?: number;
  source?: string;
  atlases: Record<string, AtlasSpec | undefined>;
  units: Record<string, UnitEntry | undefined>;
}

/** 매핑값 — 축 태그가 붙은 아트 참조(data 발행물 `player-chars.v2.json` 계약). */
export interface CharRef {
  axis: "characters" | "units";
  id: string;
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

/** 유닛 축의 아틀라스 타일. unitId 미등록/좌표 이상이면 null. */
export function unitTile(
  manifest: UnitsManifest | null | undefined,
  unitId: string | null | undefined,
  atlasName: string,
  base: string = CHARS_BASE,
): TileRef | null {
  if (!manifest || !unitId) return null;
  const u = own(manifest.units, unitId);
  if (!u) return null;
  return tileFrom(manifest.atlases, atlasName, u, base);
}

/** 소비 측 투영 — 렌더에 필요한 것만(URL 은 이미 해석됨). */
export interface ResolvedUnitCard {
  url: string;
  kind: "complete" | "frameless-art";
  pixelArt: boolean;
  w: number;
  h: number;
}

/**
 * 유닛 카드 1장 해석. **모르는 `kind` 는 null 로 떨군다** — 새 종류가 생겼는데 기존 두 경로 중
 * 하나로 넘겨짚으면 프레임이 겹치거나(완성 카드를 합성) 프레임이 사라진다(아트를 통짜로).
 * 틀린 그림 대신 폴백이 이 계층의 원칙이다.
 */
export function unitCard(
  manifest: UnitsManifest | null | undefined,
  unitId: string | null | undefined,
  base: string = CHARS_BASE,
): ResolvedUnitCard | null {
  if (!manifest || !unitId) return null;
  const u = own(manifest.units, unitId);
  const card = u?.card;
  if (!card || typeof card !== "object") return null;
  if (card.kind !== "complete" && card.kind !== "frameless-art") return null;
  const url = assetUrl(card.file, base);
  if (!url) return null;
  const w = Number.isFinite(card.w) && card.w > 0 ? card.w : 0;
  const h = Number.isFinite(card.h) && card.h > 0 ? card.h : 0;
  if (!w || !h) return null;
  return { url, kind: card.kind, pixelArt: card.pixelArt === true, w, h };
}

/**
 * 얼굴 아이콘의 배경 전제. 기본은 `transparent`(기존 두 축의 계약).
 *
 * 왜 필요한가: 레전더리 얼굴은 **불투명 다크 배경 위에** 글로우·수염선이 그려져 있다.
 * 투명이라고 가정하고 원형 마스크를 씌우면 글로우 링과 턱선이 잘려 나간다 — 그래서 배경
 * 전제를 발행측이 엔트리마다 선언하고, 소비 측은 그 값에 따라 마스크 모양을 바꾼다.
 */
export function unitIconBackground(
  manifest: UnitsManifest | null | undefined,
  unitId: string | null | undefined,
): IconBackground {
  if (!manifest || !unitId) return "transparent";
  const u = own(manifest.units, unitId);
  return u?.iconBackground === "opaque-dark" ? "opaque-dark" : "transparent";
}

/**
 * 폴백 체인 1스텝: 매핑된 축(units/characters)의 타일 → 플레이스홀더 타일 → null.
 * (null 이면 호출부가 CSS 플레이스홀더로 떨어진다 — 깨진 <img> 는 어떤 경우에도 없다.)
 *
 * `ref` 는 **축 태그가 붙은 참조**다(#207). 문자열(구 v1 매핑)이 흘러들어오면 `characters` 축
 * 으로 해석한다 — 구 발행물로 되돌려도 화면이 죽지 않게.
 */
export function resolveTile(args: {
  characters: CharactersManifest | null | undefined;
  placeholders: PlaceholderManifest | null | undefined;
  units?: UnitsManifest | null | undefined;
  ref: CharRef | string | null | undefined;
  playerId: string | null | undefined;
  atlas: string;
  base?: string;
}): { tile: TileRef; kind: "character" | "unit" | "placeholder" } | null {
  const base = args.base ?? CHARS_BASE;
  const ref: CharRef | null =
    typeof args.ref === "string"
      ? { axis: "characters", id: args.ref }
      : args.ref && typeof args.ref === "object" && typeof args.ref.id === "string"
        ? args.ref
        : null;

  if (ref?.axis === "units") {
    const u = unitTile(args.units, ref.id, args.atlas, base);
    if (u) return { tile: u, kind: "unit" };
  } else if (ref) {
    const c = characterTile(args.characters, ref.id, args.atlas, base);
    if (c) return { tile: c, kind: "character" };
  }
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
