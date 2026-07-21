// ensure-chars.mjs — predev/prebuild 훅. public/chars(gitignore 생성물)가 없거나
// 발행물 manifest 가 바뀌었을 때만 스테이징한다(ensure-viewer.mjs 와 같은 규약).
import { needsStage, stage } from "./build-chars.mjs";

const reason = needsStage();
if (reason) {
  console.log(`[ensure-chars] 재스테이징: ${reason}`);
  const stamp = stage();
  console.log(`[ensure-chars] 완료 — 플레이스홀더 ${stamp.base.playerCount}명 · 캐릭터 ${stamp.chars.count}종`);
} else {
  console.log("[ensure-chars] 최신 — 스킵");
}
