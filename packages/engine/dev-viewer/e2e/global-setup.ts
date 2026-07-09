// Playwright globalSetup: 테스트 실행 전 풀해상도 테스트 뷰어(showcase+real)를 조립한다.
// 입력 로그(match-log.json, fixture-real.json)는 gitignore 되는 생성물이므로 없으면 vitest 로 생성.
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildAllTestViewers } from "./build-test-viewer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const viewerDir = dirname(here);
const repoRoot = join(here, "..", "..", "..");

export default function globalSetup() {
  const showcaseLog = join(viewerDir, "match-log.json");
  const realLog = join(here, "fixture-real.json");

  if (!existsSync(showcaseLog)) {
    // eslint-disable-next-line no-console
    console.log("[e2e globalSetup] match-log.json 없음 → generate-demo 실행");
    execSync("npx vitest run packages/engine/dev-viewer/generate-demo.test.ts", { cwd: repoRoot, stdio: "inherit" });
  }
  if (!existsSync(realLog)) {
    // eslint-disable-next-line no-console
    console.log("[e2e globalSetup] fixture-real.json 없음 → gen-fixtures 실행");
    execSync("npx vitest run packages/engine/dev-viewer/e2e/gen-fixtures.test.ts", { cwd: repoRoot, stdio: "inherit" });
  }

  const r = buildAllTestViewers();
  // eslint-disable-next-line no-console
  console.log(`[e2e globalSetup] built showcase(${r.showcase.snapshots} snaps) + real(${r.real.snapshots} snaps)`);
}
