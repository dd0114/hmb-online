/**
 * 공지 이미지 경로 해석 계약 (#309 W1).
 *
 * 이 계약이 지키는 것은 두 가지이고, **둘이 서로 반대 방향**이다:
 *  1) 업로드 이미지(`/api/…`)는 **백엔드 오리진**으로 나가야 한다 — web 은 CF Pages 정적이라
 *     그 오리진에 `/api` 를 받아 줄 서버가 없다.
 *  2) 기존 정적 에셋(`/notice/…`)은 **웹 오리진에 그대로 있어야** 한다 — 전부 옮기면 그 그림이
 *     백엔드에서 404 가 된다(#309 가 요구한 "공존"이 여기서 깨진다).
 * 한쪽만 검사하면 반대쪽이 조용히 깨지므로 둘 다 태운다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetRuntimeConfig } from "../api/client";
import { noticeAssetMarkup, resolveNoticeUrl } from "./notice-asset-url";

afterEach(() => {
  vi.unstubAllEnvs();
  __resetRuntimeConfig();
});

describe("resolveNoticeUrl", () => {
  it("API base 가 없으면 항등이다 — dev·테스트·데모(8080) 동작이 한 바이트도 안 바뀐다", () => {
    vi.stubEnv("VITE_API_BASE", "");
    expect(resolveNoticeUrl("/api/notices/assets/AAA")).toBe("/api/notices/assets/AAA");
    expect(resolveNoticeUrl("/notice/hero-kyeongnicius.webp")).toBe("/notice/hero-kyeongnicius.webp");
  });

  it("업로드 이미지는 백엔드 오리진으로 나간다", () => {
    vi.stubEnv("VITE_API_BASE", "https://api.example.com");
    expect(resolveNoticeUrl("/api/notices/assets/AAA")).toBe(
      "https://api.example.com/api/notices/assets/AAA",
    );
  });

  it("⚠️ 기존 정적 에셋은 **웹 오리진 그대로** 둔다(공존)", () => {
    vi.stubEnv("VITE_API_BASE", "https://api.example.com");
    // 되돌리기 금지 지점: 여기서 전부 옮기면 hero-kyeongnicius.webp 가 백엔드에서 404 다.
    expect(resolveNoticeUrl("/notice/hero-kyeongnicius.webp")).toBe("/notice/hero-kyeongnicius.webp");
    expect(resolveNoticeUrl("/assets/chars/p173.png")).toBe("/assets/chars/p173.png");
  });

  it("이미 절대 URL 이면 손대지 않는다(외부 호스트 참조는 계속 허용)", () => {
    vi.stubEnv("VITE_API_BASE", "https://api.example.com");
    expect(resolveNoticeUrl("https://cdn.example.org/a.png")).toBe("https://cdn.example.org/a.png");
    expect(resolveNoticeUrl("http://cdn.example.org/a.png")).toBe("http://cdn.example.org/a.png");
  });
});

describe("noticeAssetMarkup", () => {
  it("본문에 붙는 형태가 곧 파서가 읽는 형태다", () => {
    expect(noticeAssetMarkup("01ABC", "경니시우스")).toBe("![경니시우스](/api/notices/assets/01ABC)");
  });

  it("설명이 없어도 유효한 이미지 마크업이다", () => {
    expect(noticeAssetMarkup("01ABC")).toBe("![](/api/notices/assets/01ABC)");
  });
});
