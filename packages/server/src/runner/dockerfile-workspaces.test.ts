import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * #385 회귀 가드 — **`@hmb/server` 가 의존하는 워크스페이스는 전부 이미지에 들어간다.**
 *
 * <p>사건: 엔진 열차 1 이 발차 직후 롤백됐다. `packages/server/Dockerfile` 이 워크스페이스를
 * <b>손으로 나열</b>하는데 `@hmb/viewer-core` 의 COPY 두 줄이 빠져 있었다. 로컬·CI 는 npm
 * 워크스페이스라 심링크로 해결되므로 <b>전 게이트가 통과했고</b>, 컨테이너에서만
 * `ERR_MODULE_NOT_FOUND` 로 러너가 크래시했다. 즉 **테스트가 볼 수 없는 종류의 결함**이었다 —
 * 유일한 관측 지점이 이미지 빌드 목록과 의존 목록의 대조다.
 *
 * <p>판정을 <b>이름 규칙</b>(`@hmb/x` → `packages/x`)으로 하지 않는다: 디렉토리명과 패키지명이
 * 갈라지는 순간 가드가 조용히 틀린 곳을 본다. 각 워크스페이스의 `package.json#name` 을 실제로 읽어
 * 매핑하고, 의존은 <b>전이적으로</b> 따라간다(`server → engine → shared` 처럼 간접 의존도 이미지에
 * 있어야 한다).
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const dockerfilePath = join(repoRoot, "packages", "server", "Dockerfile");

/** packages/* 를 훑어 {패키지명 → 리포 상대경로} 를 만든다(이름 규칙에 기대지 않는다). */
function workspaceDirs(): Map<string, string> {
  const out = new Map<string, string>();
  const base = join(repoRoot, "packages");
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(base, entry.name, "package.json");
    if (!existsSync(manifest)) continue;
    const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name;
    if (name) out.set(name, `packages/${entry.name}`);
  }
  return out;
}

/** `@hmb/server` 에서 출발해 워크스페이스 의존을 전이적으로 모은다. */
function requiredWorkspaces(): string[] {
  const dirs = workspaceDirs();
  const seen = new Set<string>();
  const walk = (pkgName: string): void => {
    const dir = dirs.get(pkgName);
    if (!dir || seen.has(pkgName)) return;
    seen.add(pkgName);
    const manifest = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (dirs.has(dep)) walk(dep);
    }
  };
  walk("@hmb/server");
  seen.delete("@hmb/server"); // server 자신은 아래에서 따로 단언한다
  return [...seen].map((n) => dirs.get(n) as string).sort();
}

describe("#385 Dockerfile ↔ 워크스페이스 의존 일치 (러너 이미지)", () => {
  const dockerfile = readFileSync(dockerfilePath, "utf8");

  it("의존 목록이 비어 있지 않다 — 비면 이 가드가 공허해진다", () => {
    expect(requiredWorkspaces().length).toBeGreaterThan(0);
  });

  it("모든 (전이) 워크스페이스 의존의 **매니페스트**가 COPY 된다 (npm ci 레이어)", () => {
    for (const dir of requiredWorkspaces()) {
      expect(dockerfile, `${dir}/package.json 의 COPY 가 없다 — npm ci 가 이 워크스페이스를 모른다`)
        .toContain(`COPY ${dir}/package.json ${dir}/package.json`);
    }
  });

  it("모든 (전이) 워크스페이스 의존의 **소스**가 COPY 된다 (#385 가 빠뜨린 줄)", () => {
    for (const dir of requiredWorkspaces()) {
      expect(
        dockerfile,
        `${dir} 소스의 COPY 가 없다 — 컨테이너에서만 ERR_MODULE_NOT_FOUND 로 죽는다(로컬은 ` +
          `워크스페이스 심링크라 전 게이트가 통과한다). 이게 #385 의 정확한 형태다`,
      ).toContain(`COPY ${dir} ${dir}`);
    }
  });

  it("server 자신도 두 줄 다 있다", () => {
    expect(dockerfile).toContain("COPY packages/server/package.json packages/server/package.json");
    expect(dockerfile).toContain("COPY packages/server packages/server");
  });
});
