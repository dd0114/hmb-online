import { describe, expect, it } from "vitest";
import {
  claimRateText,
  EMPTY_MAIL_FORM,
  normalizeCampaigns,
  parsePlayers,
  parseUserIds,
  targetSummary,
  toSendBody,
  validateMailForm,
  type MailFormValues,
} from "./mail-admin-logic";

function form(over: Partial<MailFormValues> = {}): MailFormValues {
  return {
    ...EMPTY_MAIL_FORM,
    audience: "USERS",
    userIds: "u_1",
    title: "제목",
    body: "본문",
    reason: "사유",
    ...over,
  };
}

describe("입력 파싱", () => {
  it("유저 id 는 줄바꿈·쉼표·공백 아무거나로 나눈다(복붙 편의)", () => {
    expect(parseUserIds("u_1, u_2\nu_3  u_4")).toEqual(["u_1", "u_2", "u_3", "u_4"]);
    expect(parseUserIds("   ")).toEqual([]);
  });

  it("카드는 'P001:2, P010' — 개수 생략은 1장", () => {
    expect(parsePlayers("P001:2, P010")).toEqual([
      { playerId: "P001", count: 2 },
      { playerId: "P010", count: 1 },
    ]);
  });

  it("깨진 카드 형식은 null 로 돌려 화면이 오류로 만들게 한다(조용히 버리지 않는다)", () => {
    expect(parsePlayers("P001:0")).toBeNull();
    expect(parsePlayers("P001:abc")).toBeNull();
    expect(parsePlayers("P001:-1")).toBeNull();
  });
});

describe("검증 — 되돌릴 수 없는 오조작의 형태만 막는다", () => {
  it("사유·제목·본문은 필수", () => {
    expect(validateMailForm(form({ reason: "" })).errors.reason).toBeDefined();
    expect(validateMailForm(form({ title: " " })).errors.title).toBeDefined();
    expect(validateMailForm(form({ body: "" })).errors.body).toBeDefined();
  });

  it("지정 발송인데 대상이 비면 막는다", () => {
    expect(validateMailForm(form({ userIds: "" })).errors.userIds).toBeDefined();
    expect(validateMailForm(form({ audience: "ALL", userIds: "" })).ok).toBe(true);
  });

  it("금액은 0 이상 정수만 — 음수·소수·문자를 막는다", () => {
    expect(validateMailForm(form({ points: "-1" })).errors.points).toBeDefined();
    expect(validateMailForm(form({ points: "1.5" })).errors.points).toBeDefined();
    expect(validateMailForm(form({ gems: "abc" })).errors.gems).toBeDefined();
    // 빈 값 = 0 (첨부 없음도 유효한 발송이다)
    expect(validateMailForm(form({ points: "", gems: "" })).ok).toBe(true);
  });

  /**
   * ⚠️ 상한(1,000,000 등)은 **서버가 SoT** 다 — 여기서 같은 숫자를 적으면 두 곳이 갈라진다.
   * 그래서 큰 값도 폼은 통과시키고 서버 400 문구를 그대로 보여준다.
   */
  it("상한은 클라가 흉내내지 않는다", () => {
    expect(validateMailForm(form({ points: "999999999" })).ok).toBe(true);
  });
});

describe("toSendBody", () => {
  it("기한을 비우면 expiresInDays 를 아예 싣지 않는다(= 무기한)", () => {
    const body = toSendBody(form({ expiresInDays: "" }));
    expect(body).not.toHaveProperty("expiresInDays");
  });

  it("기한이 있으면 숫자로 싣는다", () => {
    expect(toSendBody(form({ expiresInDays: "14" })).expiresInDays).toBe(14);
  });

  it("ALL 에는 userIds 를 싣지 않는다(서버가 400 으로 거절하는 조합)", () => {
    const body = toSendBody(form({ audience: "ALL", userIds: "u_1" }));
    expect(body).not.toHaveProperty("userIds");
  });

  it("검증 안 된 폼이면 던진다 — 조용히 0 을 보내지 않는다", () => {
    expect(() => toSendBody(form({ points: "abc" }))).toThrow();
  });
});

describe("표시", () => {
  it("대상 요약 — ALL 은 인원을 클라가 알 수 없다", () => {
    expect(targetSummary(form({ audience: "ALL" })).count).toBeNull();
    expect(targetSummary(form({ userIds: "a b c" })).count).toBe(3);
  });

  it("수령률 — 대상 0명에 NaN% 를 만들지 않는다", () => {
    const base = {
      id: "c1", audience: "ALL", title: "", body: "",
      attachments: { points: 0, gems: 0, players: [] },
      expiresAt: null, revokedAt: null, reason: "", actor: "", createdAt: "",
    };
    expect(claimRateText({ ...base, targetCount: 0, claimedCount: 0, readCount: 0 })).toBe("대상 0명");
    expect(claimRateText({ ...base, targetCount: 4, claimedCount: 1, readCount: 2 })).toContain("25%");
  });

  it("응답 형태를 믿지 않는다 — `{}` 도 빈 목록", () => {
    expect(normalizeCampaigns({})).toEqual([]);
    expect(normalizeCampaigns({ campaigns: "nope" })).toEqual([]);
    expect(normalizeCampaigns(null)).toEqual([]);
  });
});
