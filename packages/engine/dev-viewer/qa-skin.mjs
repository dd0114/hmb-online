// QA 뷰어 캐릭터 스킨(#145) 임베드 — dev-viewer(엔진 QA)에서도 **게임화면과 같은 얼굴 스킨**을
// 토글로 볼 수 있게 한다(#169 S3, hero: 실게임 그대로 보기). 코어는 skin 을 이미 지원(setSkin);
// 여기선 자립형 뷰어에 스킨 페이로드를 임베드해 셸 토글이 켜면 setSkin 을 부른다.
//
// 데모 로그는 엔진 픽스처 id(H0/A0..)라 실선수 스킨 매핑(P001..)과 안 맞으므로, first-seen 순으로
// 실선수 id 에 매핑해 캐릭터 셀을 뽑는다(web design-mock·p3-char-skin e2e 와 같은 규약).
// 게임이 서빙하는 바로 그 에셋(apps/web/public/chars)을 읽어 **QA=게임 픽셀 일치**. 에셋이 없으면
// null → 셸이 토글을 숨긴다(엔진 뷰어는 char 에셋 없이도 빌드된다 — graceful).
//
// ⚠️ #184 회귀의 자리: 매핑 발행물이 **v2 로 바뀌면서**(#207) 값이 문자열 `"aura"` 에서
// `{axis,id}` 객체가 됐는데 여기가 문자열 그대로 조회해서 셀이 0개 → 페이로드 null →
// **스킨 버튼이 영구 hidden** 이 됐다(clean main 에서도 skin.spec 실패). 축을 해석하고,
// #218 의 멀티 아틀라스 계약으로 두 축(characters·units)을 모두 싣는다.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // packages/engine/dev-viewer
export const CHARS_DIR = join(here, "..", "..", "..", "apps", "web", "public", "chars");

/** 매핑값 정규화 — v2 `{axis,id}` / v1 문자열 둘 다 받는다(구 발행물로 되돌려도 안 죽게). */
function normalizeRef(raw) {
  if (typeof raw === "string") return raw ? { axis: "characters", id: raw } : null;
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  if (raw.axis !== "characters" && raw.axis !== "units") return null;
  return { axis: raw.axis, id: raw.id };
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function dataUri(path) {
  return `data:image/png;base64,${readFileSync(path).toString("base64")}`;
}

/**
 * matchLog 의 데모 선수 id → 스킨 페이로드 또는 null. `charsDir` 는 테스트 주입점이다 —
 * 실제 스테이징엔 데모 로그가 characters 축으로만 매핑돼 **units/멀티 아틀라스 경로가 안 밟힌다**
 * (커버리지 0). 픽스처로 그 경로를 계약으로 태운다(`qa-skin.test.ts`).
 * 페이로드 = `{atlases:[{url,tile}], byPlayer:{id:{col,row,atlas?,num?,bg?}}, nums, atlasUrl, tile}`
 * (#218 멀티 아틀라스 — `atlasUrl/tile` 은 구 코어 하위호환용 첫 시트).
 */
export function buildQaSkin(matchLog, charsDir = CHARS_DIR) {
  const charAtlasP = join(charsDir, "characters", "avatars-64.png");
  const unitAtlasP = join(charsDir, "units", "avatars-64.png");
  const characters = readJson(join(charsDir, "characters", "manifest.json"))?.characters ?? null;
  const units = readJson(join(charsDir, "units", "manifest.json"))?.units ?? null;
  const players = readJson(join(charsDir, "player-chars.json"))?.players ?? null;
  if (!players || (!existsSync(charAtlasP) && !existsSync(unitAtlasP))) return null;

  const snaps = matchLog?.tickSnapshots ?? [];

  // 데모 id(H0..) → 실선수 id(P001..) first-seen 매핑.
  const realOf = new Map();
  let n = 1;
  for (const s of snaps)
    for (const p of s.players ?? [])
      if (!realOf.has(p.playerId)) realOf.set(p.playerId, `P${String(n++).padStart(3, "0")}`);

  // 등번호: 첫 스냅샷 팀별 등장 순서 1.. (viewer-skins.jerseyNumbers 와 동일 규칙).
  const first = snaps[0]?.players ?? [];
  const seen = {}, jersey = {};
  for (const p of first) {
    const t = p.team ?? "?";
    seen[t] = (seen[t] ?? 0) + 1;
    jersey[p.playerId] = String(seen[t]);
  }

  // 아틀라스는 **쓰인 것만** 싣는다(자립형 HTML 에 base64 로 박히므로 안 쓰는 시트는 낭비).
  const atlases = [];
  const atlasIdx = { characters: -1, units: -1 };
  const useAtlas = (axis) => {
    if (atlasIdx[axis] >= 0) return atlasIdx[axis];
    const p = axis === "units" ? unitAtlasP : charAtlasP;
    if (!existsSync(p)) return -1;
    atlases.push({ url: dataUri(p), tile: 64 });
    atlasIdx[axis] = atlases.length - 1;
    return atlasIdx[axis];
  };

  const byPlayer = {};
  for (const [demoId, realId] of realOf) {
    const ref = normalizeRef(players[realId]);
    if (!ref) continue;
    let cell = null, bg;
    if (ref.axis === "units") {
      const u = units?.[ref.id];
      // U-D8: 등급 공용 디폴트(`forGrades`)는 경기장에서 안 쓴다 — 같은 얼굴 22개는 정보가 0.
      if (!u || (Array.isArray(u.forGrades) && u.forGrades.length > 0)) continue;
      cell = u;
      if (u.iconBackground === "opaque-dark") bg = "opaque-dark";
    } else {
      cell = characters?.[ref.id];
    }
    if (!cell || typeof cell.col !== "number" || typeof cell.row !== "number") continue;
    const atlas = useAtlas(ref.axis);
    if (atlas < 0) continue;
    byPlayer[demoId] = { col: cell.col, row: cell.row };
    if (atlas > 0) byPlayer[demoId].atlas = atlas;
    if (jersey[demoId]) byPlayer[demoId].num = jersey[demoId];
    if (bg) byPlayer[demoId].bg = bg;
  }
  if (atlases.length === 0 || Object.keys(byPlayer).length === 0) return null;

  return { atlases, byPlayer, nums: jersey, atlasUrl: atlases[0].url, tile: atlases[0].tile };
}
