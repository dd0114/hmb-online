// QA 뷰어 캐릭터 스킨(#145) 임베드 — dev-viewer(엔진 QA)에서도 **게임화면과 같은 얼굴 스킨**을
// 토글로 볼 수 있게 한다(#169 S3, hero: 실게임 그대로 보기). 코어는 skin 을 이미 지원(setSkin);
// 여기선 자립형 뷰어에 스킨 페이로드를 임베드해 셸 토글이 켜면 setSkin 을 부른다.
//
// 데모 로그는 엔진 픽스처 id(H0/A0..)라 실선수 스킨 매핑(P001..)과 안 맞으므로, first-seen 순으로
// 실선수 id 에 매핑해 캐릭터 셀을 뽑는다(web design-mock·p3-char-skin e2e 와 같은 규약).
// 게임이 서빙하는 바로 그 에셋(apps/web/public/chars)을 읽어 **QA=게임 픽셀 일치**. 에셋이 없으면
// null → 셸이 토글을 숨긴다(엔진 뷰어는 char 에셋 없이도 빌드된다 — graceful).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // packages/engine/dev-viewer
const charsDir = join(here, "..", "..", "..", "apps", "web", "public", "chars");

/** matchLog 의 데모 선수 id → 캐릭터 셀 스킨 페이로드({atlasUrl(dataURI), tile, byPlayer}) 또는 null. */
export function buildQaSkin(matchLog) {
  const atlasP = join(charsDir, "characters", "avatars-64.png");
  const manifestP = join(charsDir, "characters", "manifest.json");
  const mappingP = join(charsDir, "player-chars.json");
  if (!existsSync(atlasP) || !existsSync(manifestP) || !existsSync(mappingP)) return null;

  const characters = JSON.parse(readFileSync(manifestP, "utf8")).characters ?? {};
  const players = JSON.parse(readFileSync(mappingP, "utf8")).players ?? {};
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

  const byPlayer = {};
  for (const [demoId, realId] of realOf) {
    const c = characters[players[realId]];
    if (!c || typeof c.col !== "number" || typeof c.row !== "number") continue;
    byPlayer[demoId] = jersey[demoId]
      ? { col: c.col, row: c.row, num: jersey[demoId] }
      : { col: c.col, row: c.row };
  }
  if (Object.keys(byPlayer).length === 0) return null;

  const b64 = readFileSync(atlasP).toString("base64");
  return { atlasUrl: `data:image/png;base64,${b64}`, tile: 64, byPlayer };
}
