/**
 * 경기장 캐릭터 스킨 페이로드 (#145) — 순수 로직만(React/DOM 의존 0, 단위검증 대상).
 *
 * web 이 매핑을 계산해 코어에 넘긴다(#169 S3: `viewer.setSkin(payload)` — 구 iframe postMessage
 * 대체). **코어는 캐릭터를 모른다** — 받은 `{playerId: {col,row}}` 로 아틀라스 타일만 그린다
 * (도메인 지식 유출 0, QA 경계 유지).
 *
 * 왜 로그에서 안 뽑고 매핑 전체를 보내나: MatchLog 스냅샷을 순회해 등장 선수를 모으는 것보다
 * 172개 엔트리를 통째로 보내는 게 싸고(수 KB) 교체·하프 전환에도 안전하다.
 *
 * 아틀라스 선택: 실캡처 A/B(#145)에서 전신 sprites 는 토큰 지름 16~22px 에서 판독 불가였고
 * **얼굴 avatars-64**(축소 렌더)가 확대·축소 양쪽에서 읽혔다. 그 결론을 여기 상수로 박제한다.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * #207 U-D8 — **경기장은 `characters` 축만 태운다**. 이유가 두 개고 성격이 다르다.
 *
 *  1) **의도**: GOLD/SILVER/BRONZE 는 경기장에서 개별 아이콘을 쓰지 않는다(전원 같은 디폴트
 *     유닛이라 22개 토큰이 전부 같은 얼굴이 되어 판독에 아무 정보도 더하지 않는다).
 *     스킨 셀이 없는 선수는 뷰어가 **팀색 원(홈 파랑 / 어웨이 빨강)** 으로 그린다 —
 *     즉 "빼는 것"이 곧 U-D8 이 요구하는 표현이다(뷰어 무변경).
 *
 *  2) **제약(갭)**: 페이로드가 `{atlasUrl, tile, byPlayer}` 로 **단일 아틀라스**다. units 축은
 *     자기 아틀라스(`/chars/units/avatars-64.png`)를 갖기 때문에 characters 축과 한 페이로드에
 *     담을 수 없다. 그래서 **활성 LEGEND 5종의 실아트가 경기장에는 아직 못 뜬다**(현행과 동일 —
 *     v1 매핑에도 그들은 없었다). 해소하려면 viewer-core 가 아틀라스별 셀을 받아야 하는데
 *     `packages/**` 는 QA 도메인이라 여기서 고치지 않는다 → **이슈 레이즈 대상**.
 *     이 갭은 `viewer-skins.test.ts` 가 계약으로 박제한다(침묵시키지 않는다).
 * ════════════════════════════════════════════════════════════════════════════
 */
import { characterTile, type TileRef } from "../common/char-manifest";
import { normalizeCharRef, type CharAssets } from "../common/char-assets-store";

/** 경기장 토큰용 아틀라스 — A/B 실측 결론(얼굴, 64px 소스). */
export const ARENA_ATLAS = "avatars-64";

/** 경기장 토큰을 그리는 축. 그 밖의 축은 팀색 원으로 떨어진다(U-D8). */
export const ARENA_AXIS = "characters" as const;

export interface SkinCell {
  col: number;
  row: number;
  /** 등번호(1~11). 없으면 뷰어가 기존 방식(playerId 에서 파생)으로 표시한다. */
  num?: string;
}

export interface ViewerSkins {
  atlasUrl: string;
  tile: number;
  byPlayer: Record<string, SkinCell>;
}

/** 등번호를 뽑아낼 최소한의 MatchLog 형상. */
interface MatchLogLike {
  tickSnapshots?: Array<{ players?: Array<{ playerId?: string; team?: string }> }>;
}

/**
 * 등번호 표 — 첫 스냅샷의 **팀별 등장 순서**로 1~11 을 매긴다(포메이션 슬롯 순서 = 라인업 순서).
 *
 * 왜 필요한가: 뷰어 원본은 `playerId.replace(/[HA]/,"")` 로 번호를 만든다. 엔진 픽스처
 * (`H1`…)에선 "1" 이 나오지만 **실경기 로그는 실제 선수 id(`P022`)** 라 토큰에 "P022" 가
 * 그대로 찍힌다(원본 뷰어도 마찬가지 — 실화면 캡처로 확인). 부모가 아는 정보로 여기서 고친다.
 */
export function jerseyNumbers(log: unknown): Record<string, string> {
  const first = (log as MatchLogLike)?.tickSnapshots?.[0]?.players;
  if (!first) return {};
  const seen: Record<string, number> = {};
  const out: Record<string, string> = {};
  for (const p of first) {
    if (!p?.playerId) continue;
    const team = p.team ?? "?";
    seen[team] = (seen[team] ?? 0) + 1;
    out[p.playerId] = String(seen[team]);
  }
  return out;
}

function cellOf(tile: TileRef): { col: number; row: number } {
  return { col: Math.round(tile.x / tile.tile), row: Math.round(tile.y / tile.tile) };
}

/**
 * 에셋 번들 → 뷰어 스킨 페이로드. 매핑/매니페스트가 아직 없거나 쓸 수 있는 선수가 하나도
 * 없으면 **null** — 부모는 skins 를 빼고 보내고, 뷰어는 현행 단색 원으로 그린다(무회귀).
 *
 * 모든 선수가 같은 아틀라스를 쓴다는 전제로 첫 타일의 URL/타일크기를 대표로 삼는다
 * (발행물이 캐릭터 축 단일 아틀라스라 성립 — 어긋나는 항목은 버린다).
 */
export function buildViewerSkins(assets: CharAssets, log?: unknown): ViewerSkins | null {
  const mapping = assets.mapping?.players;
  if (!mapping || !assets.characters) return null;

  const jerseys = log ? jerseyNumbers(log) : {};
  let atlasUrl: string | null = null;
  let tileSize = 0;
  const byPlayer: Record<string, SkinCell> = {};

  for (const [playerId, raw] of Object.entries(mapping)) {
    const ref = normalizeCharRef(raw);
    // 축이 다르면(= units) 셀을 만들지 않는다 → 뷰어가 팀색 원으로 그린다(U-D8, 위 주석).
    if (ref?.axis !== ARENA_AXIS) continue;
    const tile = characterTile(assets.characters, ref.id, ARENA_ATLAS);
    if (!tile) continue;
    if (atlasUrl === null) {
      atlasUrl = tile.url;
      tileSize = tile.tile;
    } else if (tile.url !== atlasUrl || tile.tile !== tileSize) {
      continue; // 다른 아틀라스를 쓰는 항목은 이 페이로드로 표현할 수 없다 — 조용히 제외.
    }
    const num = jerseys[playerId];
    byPlayer[playerId] = num ? { ...cellOf(tile), num } : cellOf(tile);
  }

  if (!atlasUrl || Object.keys(byPlayer).length === 0) return null;
  return { atlasUrl, tile: tileSize, byPlayer };
}
