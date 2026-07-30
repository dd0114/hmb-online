/**
 * 경기장 캐릭터 스킨 페이로드 (#145 · #218) — 순수 로직만(React/DOM 의존 0, 단위검증 대상).
 *
 * web 이 매핑을 계산해 코어에 넘긴다(#169 S3: `viewer.setSkin(payload)` — 구 iframe postMessage
 * 대체). **코어는 캐릭터를 모른다** — 받은 `{playerId: {atlas,col,row}}` 로 아틀라스 타일만 그린다
 * (도메인 지식 유출 0, QA 경계 유지).
 *
 * 왜 로그에서 안 뽑고 매핑 전체를 보내나: MatchLog 스냅샷을 순회해 등장 선수를 모으는 것보다
 * 매핑 전체를 통째로 보내는 게 싸고(수 KB) 교체·하프 전환에도 안전하다.
 *
 * 아틀라스 선택: 실캡처 A/B(#145)에서 전신 sprites 는 토큰 지름 16~22px 에서 판독 불가였고
 * **얼굴 avatars-64**(축소 렌더)가 확대·축소 양쪽에서 읽혔다. 그 결론을 여기 상수로 박제한다.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * #218 — **경기장이 두 축(characters·units)을 모두 태운다.** 무엇이 바뀌었나:
 *
 *  (구) 페이로드가 `{atlasUrl, tile, byPlayer}` = **단일 아틀라스**라, 자기 아틀라스를 갖는
 *       units 축을 담을 수 없어 통째 제외했다. 결과: **활성 LEGEND 실아트가 경기장에만 안 떴다**
 *       (덱·도감엔 떴다 — 그 화면들은 축별로 조회하므로). hero 제보 = "레전드 아이콘 안 보임".
 *  (신) 코어가 `atlases:[{url,tile}]` + 셀의 `atlas` 인덱스를 받는다(#218, viewer-core). 축이
 *       늘어도 여기서 시트를 하나 더 밀면 된다.
 *
 * **#285 — 무엇을 안 태우나의 판정 근거가 바뀌었다.**
 *  (구 U-D8) "이 유닛이 **등급 공용 디폴트**냐"(`unitIsSharedDefault`, 발행물 `forGrades` 선언).
 *            지금 데이터에선 공용 디폴트 = 골드 이하 133명이라 답이 맞았지만 **우연**이다 —
 *            발행측이 골드 한 명에게 고유 아트를 주면 그 순간 경기장에 골드 얼굴이 뜬다.
 *  (신 #285) **등급이 판정한다**(`showsCharacterArt`, 다이아 이상만). 부모가 `grades` 를 넘긴다.
 *            공용 디폴트 제외는 **백스톱으로 남긴다** — 등급표가 없는 경로(QA 콘솔·카탈로그
 *            미조회)에서도 정책이 뚫리지 않게. 두 층 각각 계약이 있다.
 * 셀이 없는 선수는 코어가 **팀색 원 + 등번호**로 그린다 = "빼는 것"이 곧 정책의 표현이다.
 *
 * 등번호(`nums`)는 **아트 유무와 무관하게 전원** 싣는다. 셀이 없으면 코어가 `playerId` 에서
 * 번호를 파생하는데, 실경기 id("P173")가 그대로 토큰을 덮어 아이콘이 사라진 것처럼 보였다
 * (#218 실화면 캡처로 확인). 아트가 없어도 토큰은 반드시 읽혀야 한다.
 * ════════════════════════════════════════════════════════════════════════════
 */
import {
  characterTile,
  unitIsSharedDefault,
  unitTile,
  unitIconBackground,
  type TileRef,
} from "../common/char-manifest";
import { skinKeyOf } from "@hmb/viewer-core";
import { normalizeCharRef, type CharAssets } from "../common/char-assets-store";
import type { Grade } from "../common/grades";
import { showsCharacterArt } from "../common/icon-policy";

/** 경기장 토큰용 아틀라스 — A/B 실측 결론(얼굴, 64px 소스). */
export const ARENA_ATLAS = "avatars-64";

/** 경기장 토큰을 그리는 축. 이 밖의 축·공용 디폴트는 팀색 원으로 떨어진다(U-D8). */
export const ARENA_AXES = ["characters", "units"] as const;

export interface SkinCell {
  col: number;
  row: number;
  /** 이 셀이 속한 아틀라스(`atlases` 인덱스). 없으면 0. */
  atlas?: number;
  /** 등번호(1~11). 없으면 코어가 `nums` → playerId 순으로 떨어진다. */
  num?: string;
  /** 얼굴의 배경 전제 — 불투명이면 코어가 원형으로 잘라 넣는다(사각 덩어리 방지). */
  bg?: "opaque-dark";
}

export interface ViewerSkins {
  /** 아트 시트들. 축마다 자기 시트를 갖는다(#218). */
  atlases: Array<{ url: string; tile: number }>;
  byPlayer: Record<string, SkinCell>;
  /** 셀이 없는 선수까지 포함한 등번호 표(폴백 보장). */
  nums: Record<string, string>;
  /** 구 단일 아틀라스 계약(코어 하위호환 — 첫 시트). */
  atlasUrl: string;
  tile: number;
}

/** 등번호를 뽑아낼 최소한의 MatchLog 형상. */
interface MatchLogLike {
  tickSnapshots?: Array<{ players?: Array<{ playerId?: string; team?: string }> }>;
}

/**
 * 등번호 표 — **팀별 등장 순서**로 1~11 을 매긴다(첫 스냅샷 = 포메이션 슬롯 순서 = 라인업 순서).
 *
 * 왜 필요한가: 뷰어 원본은 `playerId.replace(/[HA]/,"")` 로 번호를 만든다. 엔진 픽스처
 * (`H1`…)에선 "1" 이 나오지만 **실경기 로그는 실제 선수 id(`P022`)** 라 토큰에 "P022" 가
 * 그대로 찍힌다(원본 뷰어도 마찬가지 — 실화면 캡처로 확인). 부모가 아는 정보로 여기서 고친다.
 *
 * 첫 스냅샷만 보지 않고 **전 스냅샷을 훑는다**: 교체 선수는 첫 스냅샷에 없어서, 첫 스냅샷만 보면
 * 그 선수만 다시 id 원문으로 떨어진다(폴백에 조용히 뚫리는 구멍 — 독립검증 지적).
 *
 * ⚠️ **키는 `(team, playerId)` 다**(#324). 유저 덱과 봇 로스터가 같은 선수 카탈로그를 공유해
 * **같은 playerId 가 양 팀에 동시 출전**한다(라이브 101하프의 38% 가 중복 1명 이상). 예전엔 번호를
 * 팀별로 세면서 저장만 `out[playerId]` 로 하고 두 번째 팀 인스턴스를 건너뛰어서 —
 * 중복 선수가 **먼저 나온 팀(home) 번호**를 달고, away 카운터가 그만큼 안 늘어 **away 전체 번호가
 * 밀렸다**. 라이브 실측 away = `1,2,3,4,3,2,8,7,5,9,11`(팀 안 #2·#3 중복, 6명이 홈 번호).
 */
export function jerseyNumbers(log: unknown): Record<string, string> {
  const snaps = (log as MatchLogLike)?.tickSnapshots;
  if (!snaps?.length) return {};
  const seen: Record<string, number> = {};
  const out: Record<string, string> = {};
  for (const snap of snaps) {
    for (const p of snap?.players ?? []) {
      if (!p?.playerId) continue;
      const team = p.team ?? "?";
      const key = skinKeyOf(team, p.playerId);
      if (out[key]) continue;
      seen[team] = (seen[team] ?? 0) + 1;
      out[key] = String(seen[team]);
    }
  }
  return out;
}

function cellOf(tile: TileRef): { col: number; row: number } {
  return { col: Math.round(tile.x / tile.tile), row: Math.round(tile.y / tile.tile) };
}

/**
 * 에셋 번들 → 뷰어 스킨 페이로드. 쓸 수 있는 셀도 등번호도 하나 없으면 **null** —
 * 부모는 skins 를 빼고 보내고, 코어는 현행 단색 원으로 그린다(무회귀).
 *
 * 아트가 하나도 없어도 **등번호만 실린 페이로드는 돌려준다**(AC2 폴백 보장) — 에셋 미배포에서도
 * 토큰에 선수 id 원문이 찍히면 안 된다.
 */
export function buildViewerSkins(
  assets: CharAssets,
  log?: unknown,
  grades?: Record<string, Grade | undefined> | null,
): ViewerSkins | null {
  const mapping = assets.mapping?.players;
  const jerseys = log ? jerseyNumbers(log) : {};

  const atlases: Array<{ url: string; tile: number }> = [];
  const indexOfAtlas = (tile: TileRef): number => {
    const i = atlases.findIndex((a) => a.url === tile.url && a.tile === tile.tile);
    if (i >= 0) return i;
    atlases.push({ url: tile.url, tile: tile.tile });
    return atlases.length - 1;
  };

  const byPlayer: Record<string, SkinCell> = {};
  // 축 순서대로 순회한다 — 아틀라스 인덱스(특히 구 코어가 보는 `atlasUrl` = 0번)가 **매핑 파일의
  // 키 순서에 좌우되면 안 된다**. 발행 순서가 바뀌었다고 구 코어가 엉뚱한 시트로 그리는 일 방지.
  const entries = Object.entries(mapping ?? {}).map(
    ([playerId, raw]) => [playerId, normalizeCharRef(raw)] as const,
  );
  const ordered = ARENA_AXES.flatMap((axis) => entries.filter(([, ref]) => ref?.axis === axis));
  for (const [playerId, ref] of ordered) {
    if (!ref) continue;
    /*
     * #285 노출 정책 — **등급이 판정한다**. 다이아 미만이면 축·아트 종류와 무관하게 안 태운다.
     *
     * 등급을 모르는 선수(부모가 카탈로그를 못 받은 경우)는 여기서 걸러지지 않고 아래 U-D8
     * 백스톱으로 넘어간다. 등급 미상을 곧장 제외하면 카탈로그 조회가 늦는 첫 프레임에서
     * **다이아 이상까지 전부 맨 토큰**이 됐다가 뒤늦게 얼굴이 붙는다 — 그건 정책이 아니라 깜빡임이다.
     */
    if (grades && grades[playerId] && !showsCharacterArt(grades[playerId])) continue;
    let tile: TileRef | null = null;
    let bg: "opaque-dark" | undefined;
    if (ref.axis === "units") {
      // U-D8 백스톱: 등급 공용 디폴트는 태우지 않는다(같은 얼굴 22개 = 정보 0) → 팀색 원.
      // 등급표가 없는 경로(QA 콘솔 등)에서 정책을 지키는 마지막 선.
      if (unitIsSharedDefault(assets.units, ref.id)) continue;
      tile = unitTile(assets.units, ref.id, ARENA_ATLAS);
      if (unitIconBackground(assets.units, ref.id) === "opaque-dark") bg = "opaque-dark";
    } else if (ref.axis === "characters") {
      tile = characterTile(assets.characters, ref.id, ARENA_ATLAS);
    }
    if (!tile) continue;
    const cell: SkinCell = { ...cellOf(tile) };
    const atlas = indexOfAtlas(tile);
    if (atlas > 0) cell.atlas = atlas;
    if (bg) cell.bg = bg;
    // 등번호는 여기서 굽지 않는다 — 팀마다 다르기 때문(#324). 아래 팀 확장이 붙인다.
    byPlayer[playerId] = cell;
  }

  /*
   * #324 팀 확장 — 같은 선수가 양 팀에 뛰면 **얼굴은 같아도 등번호는 팀마다 다르다**.
   * 그래서 `(team, playerId)` 키 엔트리를 따로 실어 코어가 팀 우선 조회로 자기 팀 번호를 집게 한다.
   * 플레인 키(아트만, 번호 없음)도 남긴다 — 팀을 모르는 소비자의 폴백이고, 번호는 코어가
   * `nums`(팀 키)에서 다시 찾는다.
   */
  for (const [key, num] of Object.entries(jerseys)) {
    const sep = key.indexOf(":");
    if (sep < 0) continue;
    const base = byPlayer[key.slice(sep + 1)];
    if (base) byPlayer[key] = { ...base, num };
  }

  const hasCells = Object.keys(byPlayer).length > 0 && atlases.length > 0;
  const hasNums = Object.keys(jerseys).length > 0;
  if (!hasCells && !hasNums) return null;
  return {
    atlases,
    byPlayer,
    nums: jerseys,
    // 구 계약(단일 아틀라스) 필드 — 코어 구버전이 섞여도 첫 시트는 그려진다.
    atlasUrl: atlases[0]?.url ?? "",
    tile: atlases[0]?.tile ?? 0,
  };
}
