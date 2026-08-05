// @vitest-environment jsdom
/**
 * 스태틱 모드 스위치 계약 (#444).
 *
 * 두 가지를 지킨다:
 *  1. **기본은 꺼져 있다** — 라이브 배포·dev·기존 테스트가 목 백엔드로 새 나가면 안 된다.
 *  2. **목 백엔드로 가는 문은 컴파일 타임 상수로 잠긴다** — `STATIC_BUILD_ENABLED` 가드를 빼면
 *     플래그 없는 프로덕션 빌드에도 엔진·목데이터 청크가 실려 나간다(실측 157 kB). 런타임 함수
 *     (`isStaticMode()`)로 바꾸면 rollup 이 죽은 가지를 못 지운다 — 그래서 **소스를 스캔한다**.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetStaticMode, isStaticMode } from "./mode";

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("스태틱 모드 스위치", () => {
  beforeEach(() => {
    __resetStaticMode();
    window.localStorage.clear();
  });
  afterEach(() => {
    __resetStaticMode();
  });

  it("빌드 플래그도 URL 스위치도 없으면 꺼져 있다", () => {
    expect(isStaticMode()).toBe(false);
  });

  it("`?static=1` 로 켜지고 그 선택이 저장된다 — dev 에서 목 백엔드를 열어 보는 문", () => {
    window.history.replaceState({}, "", "/?static=1");
    expect(isStaticMode()).toBe(true);
    // 저장됐으니 쿼리 없이 다시 물어도 켜져 있다.
    window.history.replaceState({}, "", "/");
    __resetStaticMode();
    expect(isStaticMode()).toBe(true);
  });

  it("`?static=0` 으로 다시 끈다", () => {
    window.history.replaceState({}, "", "/?static=1");
    expect(isStaticMode()).toBe(true);
    __resetStaticMode();
    window.history.replaceState({}, "", "/?static=0");
    expect(isStaticMode()).toBe(false);
  });

  it("목 백엔드 import 는 `STATIC_BUILD_ENABLED` 가 감싼다 — 라이브 번들이 커지지 않게", () => {
    const client = src("../api/client.ts");
    expect(client).toContain("STATIC_BUILD_ENABLED && isStaticMode()");
    // 배너도 같은 이유로 같은 상수가 감싼다(그쪽이 AI 상태 → 엔진까지 끌고 온다).
    expect(src("../App.tsx")).toContain("STATIC_BUILD_ENABLED");
  });

  it("`STATIC_BUILD_ENABLED` 는 vite define 리터럴에서 온다 — `import.meta.env` 를 읽으면 접힘이 깨진다", () => {
    const mode = src("./mode.ts");
    const decl = mode.slice(mode.indexOf("export const STATIC_BUILD_ENABLED"));
    // 주석 줄은 뺀다 — 이 파일의 경고 문구 자체가 금지 패턴을 **인용**하고 있다.
    const body = decl
      .slice(0, decl.indexOf(";"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(body).toContain("__HMB_STATIC_BUILD__");
    // `import.meta.env` 를 읽는 형태로 되돌리면 둘 중 하나가 깨진다:
    //   · `import.meta.env.DEV`  → e2e 의 Node import 가 TypeError
    //   · `import.meta.env?.DEV` → 접힘이 깨져 라이브 번들에 157 kB 가 실린다
    expect(body).not.toContain("import.meta.env");
    expect(body).not.toContain("buildFlag()");
    // define 을 심는 쪽도 같이 본다 — 한쪽만 남으면 상수가 조용히 undefined 가 된다.
    expect(src("../../vite.config.ts")).toContain("__HMB_STATIC_BUILD__");
  });
});
