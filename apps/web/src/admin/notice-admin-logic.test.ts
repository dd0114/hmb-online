/**
 * 공지 운영 패널 순수 로직 계약 (#248 §5 web 11).
 *
 * 특히 **화면이 상태를 재계산하지 않는다**를 박제한다 — 서버가 준 status 를 번역만 한다.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import {
  assetToggleWarning,
  formatAssetSize,
  noticeOpErrorMessage,
  normalizeNoticeAssetRows,
  EMPTY_NOTICE_FORM,
  formFromRow,
  formatNoticeWindow,
  fromLocalInput,
  noticeActionLabel,
  noticeStatusLabel,
  noticeStatusTone,
  normalizeNoticeRows,
  toLocalInput,
  validateNoticeForm,
  type NoticeFormValues,
} from "./notice-admin-logic";

const ROW = {
  id: "N1",
  title: "점검",
  body: "본문",
  startsAt: "2026-07-29T00:00:00Z",
  endsAt: "2026-07-31T23:59:00Z",
  active: true,
  priority: 10,
  revision: 2,
  status: "LIVE",
};

describe("normalizeNoticeRows — 응답을 믿지 않는다", () => {
  it("{notices:[…]} 와 맨 배열을 모두 받는다", () => {
    expect(normalizeNoticeRows({ notices: [ROW] }).map((r) => r.id)).toEqual(["N1"]);
    expect(normalizeNoticeRows([ROW]).map((r) => r.id)).toEqual(["N1"]);
  });

  it("형태가 아니면 빈 배열 — 패널이 admin 페이지를 죽이지 않는다", () => {
    for (const bad of [undefined, null, {}, { notices: "x" }, 7, "s"]) {
      expect(normalizeNoticeRows(bad as unknown)).toEqual([]);
    }
  });

  it("행 단위 결손도 흡수하고, 모르는 상태는 추측하지 않는다", () => {
    const rows = normalizeNoticeRows({ notices: [null, { title: "no id" }, { id: "X" }] });
    expect(rows).toHaveLength(1);
    // 서버가 상태를 안 주면 빈 값 — 화면이 지어내지 않는다.
    expect(rows[0]).toMatchObject({ id: "X", status: "", revision: 1, active: true });
  });
});

describe("상태 표시 — 서버 판정의 번역", () => {
  it("다섯 상태를 각각 번역한다", () => {
    expect(noticeStatusLabel("LIVE")).toBe("노출중");
    expect(noticeStatusLabel("SCHEDULED")).toBe("예약");
    expect(noticeStatusLabel("OFF")).toBe("중지");
    expect(noticeStatusLabel("EXPIRED")).toBe("만료");
    expect(noticeStatusLabel("DELETED")).toBe("삭제됨");
  });

  it("모르는 상태는 그대로 노출한다(조용히 정상처럼 보이지 않게)", () => {
    expect(noticeStatusLabel("ARCHIVED")).toBe("ARCHIVED");
    expect(noticeStatusLabel("")).toBe("알 수 없음");
    expect(noticeStatusTone("ARCHIVED")).toBe("off");
  });

  it("기간 표기 — 비면 즉시/무기한", () => {
    expect(formatNoticeWindow(null, null)).toBe("즉시 → 무기한");
    expect(formatNoticeWindow("2026-07-29T00:00:00Z", null)).toMatch(/^0[78]-\d\d → 무기한$/);
  });

  it("감사 액션 4종을 번역한다", () => {
    expect(noticeActionLabel("notice_create")).toBe("공지 생성");
    expect(noticeActionLabel("notice_update")).toBe("공지 수정");
    expect(noticeActionLabel("notice_active")).toBe("노출 전환");
    expect(noticeActionLabel("notice_delete")).toBe("공지 삭제");
    expect(noticeActionLabel("other")).toBe("other");
  });
});

describe("datetime-local ↔ ISO", () => {
  it("왕복해도 분 단위가 유지된다", () => {
    const local = "2026-07-29T09:30";
    const iso = fromLocalInput(local);
    expect(iso).not.toBeNull();
    expect(toLocalInput(iso)).toBe(local);
  });

  /**
   * major-2 — 왕복(`toLocalInput(fromLocalInput(x)) === x`)만 보면 **로컬 문자열을 그대로
   * 통과시켜도 참**이라 계약이 공허했다(변이체 N3 생존). 서버는 오프셋 없는 값을 400 으로
   * 거절하므로, 산출물이 **절대시각**임을 직접 단언한다.
   */
  it("산출물은 오프셋(Z 또는 ±HH:MM)을 반드시 포함한다 — 로컬 문자열을 그대로 보내지 않는다", () => {
    const local = "2026-07-30T09:00";
    const iso = fromLocalInput(local);
    expect(iso).not.toBeNull();
    expect(iso).toMatch(/(Z|[+-]\d{2}:?\d{2})$/);
    expect(iso).not.toBe(local);
    // 로컬 시각으로 해석된 절대시각이어야 한다(하루가 밀리거나 UTC 로 오독되지 않는다).
    expect(Date.parse(iso!)).toBe(new Date(local).getTime());
  });

  it("빈 값·쓰레기는 null/빈 문자열", () => {
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("   ")).toBeNull();
    expect(toLocalInput(null)).toBe("");
    expect(toLocalInput("nope")).toBe("");
  });
});

describe("validateNoticeForm", () => {
  const base: NoticeFormValues = {
    ...EMPTY_NOTICE_FORM,
    title: "점검 안내",
    body: "본문",
    reason: "게시",
  };

  it("정상 입력은 생성/수정 payload 를 둘 다 만든다", () => {
    const v = validateNoticeForm({ ...base, priority: "10" });
    expect(v.valid).toBe(true);
    expect(v.createPayload).toMatchObject({ title: "점검 안내", priority: 10, active: true, reason: "게시" });
    expect(v.createPayload!.startsAt).toBeNull();
    expect(v.createPayload!.endsAt).toBeNull();
  });

  /**
   * blocker-1 — 서버는 수정 바디의 `active` 를 **무시하지 않고 400 으로 거절**한다.
   * 하나의 payload 를 두 경로가 공유하면 운영자가 오탈자를 영영 못 고친다.
   */
  it("수정 payload 에는 `active` 키가 아예 없다 (blocker-1)", () => {
    const v = validateNoticeForm({ ...base, active: true });
    expect(Object.keys(v.updatePayload!)).not.toContain("active");
    expect(v.updatePayload).toMatchObject({ title: "점검 안내", body: "본문", reason: "게시" });
    // active=false 로 바꿔도 수정 바디는 여전히 그 필드를 모른다(값이 아니라 **부재**가 계약).
    const off = validateNoticeForm({ ...base, active: false });
    expect(Object.keys(off.updatePayload!)).not.toContain("active");
    // 생성 쪽은 반대 — 초기 노출 여부를 실어야 한다.
    expect(off.createPayload).toMatchObject({ active: false });
  });

  /**
   * 서버 `PUT` 은 **전체 치환**이다(계약으로 박혔다) — 안 보낸 기간·우선순위는 **지워진다**.
   * 폼이 항상 문서 전체를 보내야 안전하다. 누가 "바뀐 필드만 보내기"로 최적화하면 여기서 잡힌다.
   */
  it("수정 바디는 전체 치환이다 — 비운 필드도 명시적으로(누락이 아니라 null) 실린다", () => {
    const v = validateNoticeForm({ ...base, startsAt: "", endsAt: "", priority: "" });
    expect(Object.keys(v.updatePayload!).sort()).toEqual([
      "body",
      "endsAt",
      "priority",
      "reason",
      "startsAt",
      "title",
    ]);
    // "안 보냄"이 아니라 "null 을 보냄" — 서버가 지운다는 뜻을 명시한다.
    expect(v.updatePayload!.startsAt).toBeNull();
    expect(v.updatePayload!.endsAt).toBeNull();
    expect(v.updatePayload!.priority).toBe(0);
  });

  it("검증 실패면 두 payload 모두 null (반쯤 만들어진 바디가 새 나가지 않는다)", () => {
    const v = validateNoticeForm({ ...base, reason: "" });
    expect(v.createPayload).toBeNull();
    expect(v.updatePayload).toBeNull();
  });

  it("예약 시각은 payload 단계에서 이미 오프셋을 갖는다", () => {
    const v = validateNoticeForm({ ...base, startsAt: "2026-08-01T00:00", endsAt: "2026-08-07T23:59" });
    expect(v.createPayload!.startsAt).toMatch(/(Z|[+-]\d{2}:?\d{2})$/);
    expect(v.updatePayload!.endsAt).toMatch(/(Z|[+-]\d{2}:?\d{2})$/);
  });

  it("사유가 없으면 막는다 — 서버 왕복 0", () => {
    expect(validateNoticeForm({ ...base, reason: "  " }).error).toContain("사유");
  });

  it("길이 상한(제목 100 / 본문 2000)", () => {
    expect(validateNoticeForm({ ...base, title: "가".repeat(101) }).error).toContain("100자");
    expect(validateNoticeForm({ ...base, body: "가".repeat(2001) }).error).toContain("2000자");
    expect(validateNoticeForm({ ...base, title: "가".repeat(100) }).valid).toBe(true);
  });

  it("빈 제목/본문을 막는다", () => {
    expect(validateNoticeForm({ ...base, title: " " }).error).toContain("제목");
    expect(validateNoticeForm({ ...base, body: " " }).error).toContain("본문");
  });

  it("기간 역전을 막는다(같은 시각도 거부)", () => {
    const rev = validateNoticeForm({
      ...base,
      startsAt: "2026-07-31T00:00",
      endsAt: "2026-07-29T00:00",
    });
    expect(rev.error).toContain("종료 시각");
    const same = validateNoticeForm({
      ...base,
      startsAt: "2026-07-29T00:00",
      endsAt: "2026-07-29T00:00",
    });
    expect(same.valid).toBe(false);
    // 한쪽만 있는 것은 유효하다(즉시 시작 / 무기한).
    expect(validateNoticeForm({ ...base, startsAt: "2026-07-29T00:00" }).valid).toBe(true);
    expect(validateNoticeForm({ ...base, endsAt: "2026-07-29T00:00" }).valid).toBe(true);
  });

  /**
   * m3 — 서버(`AdminNoticeService`)의 상한을 그대로 미러한다. 숫자가 어긋나면 미러가 아니라
   * 거짓말이 되고, 운영자는 왕복 한 번 뒤에야 400 을 본다.
   */
  it("우선순위 범위(-1000~1000)를 서버와 같게 막는다", () => {
    expect(validateNoticeForm({ ...base, priority: "1001" }).error).toContain("1000");
    expect(validateNoticeForm({ ...base, priority: "-1001" }).error).toContain("1000");
    expect(validateNoticeForm({ ...base, priority: "100000" }).valid).toBe(false);
    // 경계값은 통과한다(과잉 차단 회귀 가드).
    expect(validateNoticeForm({ ...base, priority: "1000" }).valid).toBe(true);
    expect(validateNoticeForm({ ...base, priority: "-1000" }).valid).toBe(true);
  });

  it("사유 길이(≤500)를 서버와 같게 막는다", () => {
    expect(validateNoticeForm({ ...base, reason: "가".repeat(501) }).error).toContain("500");
    expect(validateNoticeForm({ ...base, reason: "가".repeat(500) }).valid).toBe(true);
  });

  it("우선순위는 정수만", () => {
    expect(validateNoticeForm({ ...base, priority: "1.5" }).error).toContain("정수");
    expect(validateNoticeForm({ ...base, priority: "abc" }).error).toContain("정수");
    expect(validateNoticeForm({ ...base, priority: "" }).valid).toBe(true); // 빈 값 = 0
    expect(validateNoticeForm({ ...base, priority: "-3" }).createPayload!.priority).toBe(-3);
  });
});

describe("noticeOpErrorMessage — 404·409 도 사용자에게 보인다", () => {
  const err = (status: number, message: string, code = "VALIDATION_ERROR") =>
    new ApiError(status, { code, message });

  it("서버 메시지가 1순위 — 복구 경로가 담겨 있으므로 지어내지 않는다", () => {
    expect(
      noticeOpErrorMessage(err(409, "다른 운영자가 먼저 수정했습니다 — 목록을 새로고침한 뒤 다시 시도하세요", "CONFLICT"), "fb"),
    ).toContain("새로고침");
    expect(noticeOpErrorMessage(err(404, "공지를 찾을 수 없습니다", "NOT_FOUND"), "fb")).toBe(
      "공지를 찾을 수 없습니다",
    );
    expect(noticeOpErrorMessage(err(400, "본문이 너무 깁니다"), "fb")).toBe("본문이 너무 깁니다");
  });

  it("서버가 문구를 안 주면 상태코드별 복구 안내로 채운다 (fallback 으로 뭉개지 않는다)", () => {
    expect(noticeOpErrorMessage(err(409, "", "CONFLICT"), "수정에 실패했습니다")).toContain("새로고침");
    expect(noticeOpErrorMessage(err(404, "  ", "NOT_FOUND"), "삭제에 실패했습니다")).toContain("이미 삭제");
    // 그 밖의 상태는 호출부 문구를 쓴다.
    expect(noticeOpErrorMessage(err(500, "", "INTERNAL_ERROR"), "게시에 실패했습니다")).toBe(
      "게시에 실패했습니다",
    );
  });

  it("ApiError 가 아니면(네트워크 단절 등) fallback", () => {
    expect(noticeOpErrorMessage(new Error("Failed to fetch"), "수정에 실패했습니다")).toBe(
      "수정에 실패했습니다",
    );
    expect(noticeOpErrorMessage(undefined, "fb")).toBe("fb");
  });
});

describe("formFromRow", () => {
  it("행을 폼으로 옮기되 **사유는 비운다**(직전 사유 재사용 금지)", () => {
    const form = formFromRow({ ...ROW, createdAt: null, updatedAt: null, deletedAt: null });
    expect(form.title).toBe("점검");
    expect(form.priority).toBe("10");
    expect(form.active).toBe(true);
    expect(form.reason).toBe("");
    expect(form.startsAt).not.toBe("");
  });
});

// ── 공지 이미지 (#309 W1) ────────────────────────────────────────────────

describe("normalizeNoticeAssetRows", () => {
  const OK = {
    id: "01ABC",
    url: "/api/notices/assets/01ABC",
    originalName: "hero.png",
    contentType: "image/png",
    byteSize: 1234,
    active: true,
    usedBy: 2,
  };

  it("정상 응답을 그대로 통과시킨다", () => {
    expect(normalizeNoticeAssetRows({ assets: [OK] })).toHaveLength(1);
    expect(normalizeNoticeAssetRows([OK])).toHaveLength(1);
  });

  it("⚠️ 구 서버·부분 실패 응답에도 던지지 않는다 — 여기서 던지면 admin 페이지가 흰 화면이다", () => {
    expect(normalizeNoticeAssetRows({})).toEqual([]);
    expect(normalizeNoticeAssetRows(null)).toEqual([]);
    expect(normalizeNoticeAssetRows({ assets: "nope" })).toEqual([]);
    expect(normalizeNoticeAssetRows({ assets: [null, 3, "x"] })).toEqual([]);
  });

  it("⚠️ url 이 없으면 id 로 조립하지 않고 버린다 — 경로 규칙을 클라가 복제하면 조용히 어긋난다", () => {
    expect(normalizeNoticeAssetRows({ assets: [{ ...OK, url: undefined }] })).toEqual([]);
  });

  it("빠진 필드는 안전한 기본값으로 채운다(활성은 명시적 false 일 때만 꺼진다)", () => {
    const rows = normalizeNoticeAssetRows({ assets: [{ id: "X", url: "/api/notices/assets/X" }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.active).toBe(true);
    expect(rows[0]!.usedBy).toBe(0);
    expect(rows[0]!.originalName).toBeNull();
    const off = normalizeNoticeAssetRows({ assets: [{ ...OK, active: false }] });
    expect(off[0]!.active).toBe(false);
  });
});

describe("formatAssetSize", () => {
  it("운영자가 눈으로 판단할 수 있는 단위로 바꾼다", () => {
    expect(formatAssetSize(512)).toBe("512 B");
    expect(formatAssetSize(81806)).toBe("80 KB");
    expect(formatAssetSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("이상한 값에도 화면을 깨지 않는다", () => {
    expect(formatAssetSize(Number.NaN)).toBe("-");
    expect(formatAssetSize(-1)).toBe("-");
  });
});

describe("assetToggleWarning", () => {
  const base = {
    id: "A",
    url: "/api/notices/assets/A",
    originalName: null,
    contentType: "image/png",
    byteSize: 10,
    active: true,
    usedBy: 0,
  };

  it("사용 중이면 **몇 건이 영향받는지** 먼저 말한다 — 모르는 채로 남의 공지 그림을 지우지 않게", () => {
    expect(assetToggleWarning({ ...base, usedBy: 2 })).toContain("2건");
  });

  it("끄는 안내에는 **되돌릴 수 있다**가 들어간다(삭제가 아니라 스위치라는 게 요점이다)", () => {
    expect(assetToggleWarning(base)).toContain("다시 켜면");
    expect(assetToggleWarning({ ...base, usedBy: 3 })).toContain("다시 켜면");
  });

  it("켜는 쪽은 겁주지 않는다 — 그건 되돌리기다", () => {
    const on = assetToggleWarning({ ...base, active: false, usedBy: 5 });
    expect(on).not.toContain("빕니다");
  });
});
