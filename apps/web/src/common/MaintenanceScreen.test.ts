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

  /**
   * QR 은 **PC 로 보는 유저의 유일한 연락 수단**이다(폰이 아니면 링크를 눌러도 카톡이 안 열린다).
   * 그리고 이 화면이 뜨는 상황이 곧 백엔드가 죽은 상황이라, 그 이미지가 백엔드 경로에 있으면
   * 하필 필요한 순간에 깨진다 — 그래서 웹 오리진 정적 에셋임을 여기서 못 박는다.
   */
  it("QR 이미지를 상수 그대로 렌더한다 — 백엔드를 타지 않는 경로여야 한다", () => {
    render(h(MaintenanceScreen, { onRetry: () => {}, retrying: false }));

    const qr = screen.getByTestId("maintenance-contact-qr") as HTMLImageElement;
    expect(qr.getAttribute("src")).toBe(SUPPORT_CONTACT.kakaoOpenChatQrSrc);
    expect(SUPPORT_CONTACT.kakaoOpenChatQrSrc.startsWith("/api/")).toBe(false);
    // 이미지를 못 그리는 환경(로딩 실패·스크린리더)에서도 무엇인지 알아야 한다.
    expect(qr.getAttribute("alt")).toBeTruthy();
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

  /**
   * 교체 지점이 **둘**(코드 + QR 이미지)이라는 것이 이 기능의 실제 위험이다. 코드만 바꾸고 QR 을
   * 두면 링크는 새 방인데 QR 을 찍은 사람은 죽은 방으로 간다. 두 값이 **같은 방**인지는 기계가
   * 못 본다(QR 디코더를 의존성으로 들이지 않았다) — 대신 그 앞 단계, **파일이 실제로 있는가**
   * 를 여기서 막는다. 이름을 바꾸거나 지우면 화면에 깨진 이미지가 나가는데, 그건 배포 뒤에야
   * 보인다(alt 텍스트만 남아 "연락처가 없는 점검 화면"이 된다).
   */
  it("QR 이미지 파일이 public 에 실제로 있다 — 경로 상수와 파일이 갈라지지 않는다", () => {
    const publicRoot = resolve(webSrcRoot(), "..", "public");
    const asset = join(publicRoot, SUPPORT_CONTACT.kakaoOpenChatQrSrc.replace(/^\//, ""));

    expect(existsSync(asset), `QR 에셋 없음: ${asset}`).toBe(true);
    // 빈 파일·플레이스홀더가 아니라는 최소 확인(QR 은 수십 KB 다).
    expect(statSync(asset).size).toBeGreaterThan(2000);
  });

  it("상수만 바꾸면 링크가 따라온다 — URL 은 코드에서 조립되지 않는다", () => {
    // href 가 상수 그대로여야 한다(접두사·쿼리 덧붙임 금지). 위 렌더 테스트와 같은 주장이지만
    // 여기서는 "코드가 문자열을 만들지 않는다"는 형태로 본다.
    expect(SUPPORT_CONTACT.kakaoOpenChatUrl.endsWith(SUPPORT_CONTACT.kakaoOpenChatCode)).toBe(true);
  });
});
