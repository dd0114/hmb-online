// ensure-viewer.mjs — predev/prebuild 훅. viewer-embed.html(gitignore 생성물)이
// 없거나 엔진 config 버전이 바뀌었을 때만 build:viewer 를 돌린다(값싼 체크).
//
// 왜: 새 클론이 `npm run dev` 하면 viewer-embed.html 이 없어(gitignore) 시각 재생이 깨진다.
// 매번 풀빌드는 느리니, 파일 존재 + 임베드된 엔진 버전 마커만 비교해 최신이면 스킵한다.
// 명시적 풀 재빌드는 `npm run build:viewer`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readEmbeddedVersion, readEngineVersion } from "./build-viewer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const artifact = join(repoRoot, "apps", "web", "public", "viewer-embed.html");

function needsBuild() {
  if (!existsSync(artifact)) return "아티팩트 없음";
  const embedded = readEmbeddedVersion(readFileSync(artifact, "utf8"));
  const current = readEngineVersion();
  if (embedded !== current) return `엔진 버전 변경(${embedded ?? "없음"} → ${current})`;
  return null;
}

const reason = needsBuild();
if (reason) {
  console.log(`[ensure-viewer] 재빌드 필요: ${reason}`);
  execFileSync("node", [join(here, "build-viewer.mjs")], { cwd: repoRoot, stdio: "inherit" });
} else {
  console.log(`[ensure-viewer] 최신(${readEngineVersion()}) — 스킵`);
}
