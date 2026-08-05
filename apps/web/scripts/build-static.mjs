// build-static.mjs — 스태틱(백엔드 0) 배포 산출물 빌드 (#444).
//
// GitHub Pages 는 `https://<user>.github.io/<repo>/` **서브패스**로 서빙하므로 base 를 넘겨야
// 에셋·라우터가 맞는다. 값은 `HMB_BASE_PATH` 로 주고, 안 주면 루트(`/`) — 로컬 `vite preview`
// 로 그대로 확인할 수 있다.
//
// env 를 셸에서 앞에 붙이지 않고 스크립트로 감싸는 이유: npm 스크립트의 `VAR=1 cmd` 는
// Windows 에서 깨지고, 이 커맨드는 **처음 클론한 사람이 치는 것**이라 그러면 안 된다.
import { spawnSync } from "node:child_process";
import { copyFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...process.env,
  VITE_STATIC_MODE: "1",
  VITE_BASE_PATH: process.env.HMB_BASE_PATH ?? "/",
};

for (const [cmd, args] of [
  ["node", ["scripts/ensure-chars.mjs"]],
  ["npx", ["tsc", "-p", "tsconfig.json", "--noEmit"]],
  ["npx", ["vite", "build"]],
]) {
  const r = spawnSync(cmd, args, { cwd: webDir, stdio: "inherit", env, shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const dist = join(webDir, "dist");
// SPA 딥링크(`/match/{id}` 새로고침·북마크). GitHub Pages 는 없는 경로에 `404.html` 을 주므로
// index 를 복사해 두면 라우터가 이어받는다 — 이게 없으면 새로고침 한 번에 깨진 화면이 뜬다.
copyFileSync(join(dist, "index.html"), join(dist, "404.html"));
// Jekyll 파이프라인이 `_` 로 시작하는 파일을 버리는 것을 끈다(에셋 이름 규칙이 바뀌어도 안전).
writeFileSync(join(dist, ".nojekyll"), "");
console.log(`[build-static] base=${env.VITE_BASE_PATH} · 404.html·.nojekyll 생성 완료`);
