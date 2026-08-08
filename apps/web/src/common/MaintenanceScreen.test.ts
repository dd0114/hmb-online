// @vitest-environment jsdom
/**
 * #477 — 점검 안내 화면. **연락처 교체 지점이 한 곳**이라는 것이 이 파일의 핵심 계약이다.
 *
 * hero 가 카카오 오픈채팅을 개설하면 바꿔야 할 곳이 딱 하나여야 한다. 화면·문구·안내문이 각자
 * URL 을 들고 있으면 그때 하나가 남아 유저를 죽은 링크로 보낸다 — 그래서 (a) 화면은 상수를
 * 그대로 렌더하고 (b) `src/**` 어디에도 두 번째 카카오 URL 이 없음을 소스 스캔으로 박제한다.
 *
 * root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MaintenanceScreen } from "./MaintenanceScreen";
import { SUPPORT_CONTACT } from "./support-contact";

afterEach(cleanup);

describe("MaintenanceScreen", () => {
  it("점검 중임을 알리고 연락처를 상수 그대로 노출한다", () => {
    render(h(MaintenanceScreen, { onRetry: () => {}, retrying: false }));

    expect(screen.getByTestId("maintenance-screen")).toBeTruthy();
    const link = screen.getByTestId("maintenance-contact") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(SUPPORT_CONTACT.kakaoOpenChatUrl);
    // 링크를 못 누르는 환경(카톡 미설치·PC)을 위해 방 코드 자체도 글자로 보여야 한다.
    expect(screen.getByTestId("maintenance-contact-code").textContent).toContain(
      SUPPORT_CONTACT.kakaoOpenChatCode,
    );
  });

  it("[다시 시도] 가 복구 재시도를 호출한다", () => {
    const onRetry = vi.fn();
    render(h(MaintenanceScreen, { onRetry, retrying: false }));

    fireEvent.click(screen.getByTestId("maintenance-retry"));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("재시도 중에는 버튼이 잠긴다 — 연타로 프로브를 쌓지 않는다", () => {
    const onRetry = vi.fn();
    render(h(MaintenanceScreen, { onRetry, retrying: true }));

    const btn = screen.getByTestId("maintenance-retry") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

/** src/** 전 파일에서 카카오 오픈채팅 URL 이 몇 군데 박혀 있나 — 정답은 1(상수 파일). */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

/**
 * `apps/web/src` 의 절대경로. `import.meta.url` 은 vite 변환 뒤 프로젝트 루트 기준이라
 * 그대로 쓰면 `/apps/web/src` 로 해석된다 — 루트에서 돌리든 모듈에서 돌리든 같은 답이 나오게
 * cwd 에서 찾는다(둘 다 실제로 쓰이는 실행 방식이다).
 */
function webSrcRoot(): string {
  for (const candidate of [resolve(process.cwd(), "apps/web/src"), resolve(process.cwd(), "src")]) {
    if (existsSync(join(candidate, "common", "support-contact.ts"))) return candidate + "/";
  }
  throw new Error(`apps/web/src 를 찾지 못했다 (cwd=${process.cwd()})`);
}

describe("연락처 교체 지점", () => {
  it("카카오 오픈채팅 URL 은 support-contact.ts 한 곳에만 있다", () => {
    const srcRoot = webSrcRoot();
    const hits = filesUnder(srcRoot)
      .filter((p) => /\.(ts|tsx|css)$/.test(p))
      .filter((p) => !p.endsWith("MaintenanceScreen.test.ts"))
      .filter((p) => /open\.kakao\.com/.test(readFileSync(p, "utf8")));

    expect(hits.map((p) => p.slice(srcRoot.length))).toEqual(["common/support-contact.ts"]);
  });

  it("상수만 바꾸면 링크가 따라온다 — URL 은 코드에서 조립되지 않는다", () => {
    // href 가 상수 그대로여야 한다(접두사·쿼리 덧붙임 금지). 위 렌더 테스트와 같은 주장이지만
    // 여기서는 "코드가 문자열을 만들지 않는다"는 형태로 본다.
    expect(SUPPORT_CONTACT.kakaoOpenChatUrl.endsWith(SUPPORT_CONTACT.kakaoOpenChatCode)).toBe(true);
  });
});
