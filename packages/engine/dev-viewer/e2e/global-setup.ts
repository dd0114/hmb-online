// Playwright globalSetup: 테스트 실행 전 풀해상도 테스트 뷰어(showcase+real)를 조립한다.
// 입력 로그(match-log.json, fixture-real.json)는 gitignore 되는 생성물이므로 없거나 **낡았으면** 재생성.
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildAllTestViewers } from "./build-test-viewer.mjs";
import { defaultEngineConfig } from "../../src/config";

const here = dirname(fileURLToPath(import.meta.url));
const viewerDir = dirname(here);
// e2e → dev-viewer → engine → packages → repoRoot (4단계). 3단계면 `packages/` 를 가리켜
// vitest 가 거기서 실행되고 "No test files found" 로 fixture 생성이 실패한다(새 워크트리에서만
// 드러나는 잠복 버그 — 생성물이 이미 있으면 이 경로를 안 탄다).
const repoRoot = join(here, "..", "..", "..", "..");

/**
 * 로그 재생성이 필요한 이유(없음/낡음/손상). 필요 없으면 null. (#188)
 *
 * **존재 여부만 보면 안 된다** — 엔진이 바뀌어도 옛 로그가 남아 있으면 **옛 타임라인으로 계약을
 * 검증**한다. 거짓 실패도 문제지만 더 위험한 건 **거짓 green**(옛 로그엔 사례가 있어 통과하지만
 * 현재 엔진에선 깨져 있는 경우)이다. 실제로 "main 에서도 실패한다"는 보고가 낡은 로그 때문이었던
 * 사례가 있다.
 *
 * 비교는 `configVersion` **접두**로 한다 — 쇼케이스 로그는 `engine@X.Y.Z-showcase` 처럼 접미사가
 * 붙기 때문에 완전 일치로 보면 항상 불일치가 된다.
 */
function staleReason(path: string, label: string): string | null {
  if (!existsSync(path)) return `${label} 없음`;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return `${label} 읽기 실패(손상)`;
  }
  let version: unknown;
  try {
    version = (JSON.parse(raw) as { configVersion?: unknown }).configVersion;
  } catch {
    return `${label} JSON 파싱 실패(손상)`;
  }
  const expected = defaultEngineConfig.version;
  if (typeof version !== "string") return `${label} configVersion 없음`;
  if (!version.startsWith(expected)) return `${label} 낡음(로그 ${version} ≠ 엔진 ${expected})`;
  return null;
}

export default function globalSetup() {
  const showcaseLog = join(viewerDir, "match-log.json");
  const realLog = join(here, "fixture-real.json");

  const showcaseStale = staleReason(showcaseLog, "match-log.json");
  if (showcaseStale) {
    // eslint-disable-next-line no-console
    console.log(`[e2e globalSetup] ${showcaseStale} → generate-demo 재생성`);
    // ⚠️ `HMB_TIER=1` 을 **명시**한다. `generate-demo.test.ts` 는 T0 제외 목록에 있어서(#376),
    // 앰비언트 `HMB_TIER=0` 이면 여기서 "No test files found" → execSync throw → globalSetup 이 죽는다.
    // 픽스처 재생성은 티어와 무관한 **선행 준비**지 티어로 줄일 대상이 아니다.
    execSync("npx vitest run packages/engine/dev-viewer/generate-demo.test.ts", {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, HMB_TIER: "1" },
    });
  }
  const realStale = staleReason(realLog, "fixture-real.json");
  if (realStale) {
    // eslint-disable-next-line no-console
    console.log(`[e2e globalSetup] ${realStale} → gen-fixtures 재생성`);
    execSync("npx vitest run packages/engine/dev-viewer/e2e/gen-fixtures.test.ts", {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, HMB_TIER: "1" },
    });
  }

  // 재생성 **후에도** 낡았으면 여기서 죽는다. 목적은 거짓 실패 제거가 아니라 **거짓 green 차단**
  // 이므로(옛 로그로 계약이 통과해버리는 것), 조용히 진행하지 않고 명시적으로 실패시킨다.
  for (const [path, label] of [[showcaseLog, "match-log.json"], [realLog, "fixture-real.json"]] as const) {
    const still = staleReason(path, label);
    if (still) {
      throw new Error(
        `[e2e globalSetup] 재생성했는데도 ${still} — 낡은 로그로 계약을 검증하면 거짓 green 이 난다. ` +
          `생성기(generate-demo / gen-fixtures)가 실제로 돌았는지 확인해라.`,
      );
    }
  }

  // 캐릭터 스킨 토글(#169 S3)은 web 이 스테이징한 에셋(apps/web/public/chars)을 임베드한다.
  // 그 디렉토리는 **gitignore 생성물**이라 clean 체크아웃에는 없다 → 페이로드 null → 토글이
  // 영구 hidden 이 되고 skin.spec 이 "main 에서도 실패"한다(#184 의 절반).
  //
  // **존재 여부로 판단하지 않는다** — 위 로그 가드(#188)와 같은 이유다. 에셋이 재발행됐는데 낡은
  // 스테이징이 남아 있으면 옛 아트로 계약이 통과한다(거짓 green). 판정도 스테이징도 발행측 훅
  // (`ensure-chars.mjs` = 스탬프 비교 후 필요할 때만 복사)에 맡긴다 — 신선도 규칙 재구현 금지.
  // eslint-disable-next-line no-console
  console.log("[e2e globalSetup] chars 스테이징 확인(apps/web ensure-chars)");
  execSync("node apps/web/scripts/ensure-chars.mjs", { cwd: repoRoot, stdio: "inherit" });

  const r = buildAllTestViewers();
  // eslint-disable-next-line no-console
  console.log(
    `[e2e globalSetup] built showcase(${r.showcase.snapshots} snaps) + real(${r.real.snapshots} snaps) @ ${defaultEngineConfig.version}`,
  );
}
