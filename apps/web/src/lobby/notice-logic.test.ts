/**
 * 공지 팝업 판정 계약 (#248 §5 web 1~8).
 *
 * 핵심 성질 세 가지를 박제한다:
 *  ① 억제 키에 **revision 이 들어간다** — 내용 수정본은 24h 억제를 뚫고 다시 뜬다(변이체 킬 ②)
 *  ② **서버 필터를 클라가 재계산하지 않는다** — 기기 시계로 기간을 다시 보면 계약이 깨진다(변이체 킬 ③)
 *  ③ 응답 이상·저장소 손상에서 **예외 없이 빈 목록/표시**로 떨어진다(로비가 죽지 않는다)
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  NOTICE_CLOSED_KEY,
  NOTICE_DISMISSED_KEY,
  NOTICE_DISMISS_WINDOW_MS,
  markNoticeClosed,
  markNoticeDismissed,
  markNoticeSuppressed,
  noticeCenterView,
  noticeDismissHint,
  noticeDismissLabel,
  noticeMetaText,
  noticeSuppressionKey,
  normalizeNotices,
  readDismissedMap,
  visibleNotices,
  type NoticeStores,
} from "./notice-logic";

/** 메모리 Storage — jsdom 없이 순수 로직만 검사한다. */
function memStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

const NOW = 1_800_000_000_000;

function notice(id: string, revision = 1, extra: Record<string, unknown> = {}) {
  return { id, revision, title: `${id} 제목`, body: `${id} 본문`, priority: 0, ...extra };
}

let stores: NoticeStores;
beforeEach(() => {
  stores = { session: memStorage(), local: memStorage() };
});

describe("normalizeNotices — 응답을 믿지 않는다", () => {
  it("정상 응답은 서버 순서 그대로 통과한다", () => {
    const list = normalizeNotices({ notices: [notice("B"), notice("A"), notice("C")] });
    expect(list.map((n) => n.id)).toEqual(["B", "A", "C"]);
  });

  it("서버 정렬을 클라가 다시 계산하지 않는다 (priority 가 낮아도 순서 유지)", () => {
    const list = normalizeNotices({
      notices: [notice("low", 1, { priority: 0 }), notice("high", 1, { priority: 99 })],
    });
    // 재정렬했다면 high 가 앞으로 왔을 것 — 정렬은 서버(priority DESC …)의 몫이다.
    expect(list.map((n) => n.id)).toEqual(["low", "high"]);
  });

  it("기간을 클라가 재판정하지 않는다 (서버가 준 것은 기기 시계와 무관하게 보인다)", () => {
    const future = new Date(NOW + 10 * 24 * 3600_000).toISOString();
    const past = new Date(NOW - 10 * 24 * 3600_000).toISOString();
    // 기기 시계 기준으로는 "아직 시작 전 / 이미 끝남" 이지만 서버가 활성이라고 했다.
    const list = visibleNotices(
      { notices: [notice("A", 1, { startsAt: future }), notice("B", 1, { endsAt: past })] },
      NOW,
      stores,
    );
    expect(list.map((n) => n.id)).toEqual(["A", "B"]);
  });

  it("형태가 아니면 빈 배열 — 예외를 던지지 않는다", () => {
    for (const bad of [undefined, null, {}, { notices: null }, { notices: "x" }, [], 7, "str"]) {
      expect(normalizeNotices(bad as unknown)).toEqual([]);
    }
  });

  it("항목 단위로도 방어한다 (id 없음·제목과 본문이 모두 빈 것은 버린다)", () => {
    const list = normalizeNotices({
      notices: [
        null,
        "x",
        { revision: 1, title: "t", body: "b" }, // id 없음
        { id: "  ", title: "t", body: "b" },
        { id: "E", title: "", body: "" }, // 빈 모달 방지
        { id: "OK", title: "t", body: "b" }, // revision 없음 → 1 로 폴백
      ],
    });
    expect(list.map((n) => n.id)).toEqual(["OK"]);
    expect(list[0]).toMatchObject({ revision: 1 }); // revision 없는 응답 → 1 폴백
  });
});

describe("noticeMetaText — 표시일 뿐 판정이 아니다", () => {
  it("게시일·종료일을 각각 붙이고, 없으면 뺀다", () => {
    expect(noticeMetaText({ startsAt: "2026-07-29T00:00:00Z", endsAt: "2026-07-31T23:59:00Z" })).toMatch(
      /^2026-07-\d\d 게시 · 0[78]-\d\d 까지$/,
    );
    expect(noticeMetaText({ startsAt: null, endsAt: null })).toBe("");
    expect(noticeMetaText({ startsAt: "2026-07-29T00:00:00Z", endsAt: null })).toContain("게시");
    expect(noticeMetaText({ startsAt: "2026-07-29T00:00:00Z", endsAt: null })).not.toContain("까지");
  });

  it("깨진 시각 문자열은 조용히 뺀다(화면에 흘리지 않는다)", () => {
    expect(noticeMetaText({ startsAt: "언젠가", endsAt: "곧" })).toBe("");
  });
});

describe("억제 창 길이와 버튼 문구 (#450)", () => {
  it("창은 **7일**이다 (hero 지시 — 상시 공지가 매일 다시 뜨던 것)", () => {
    expect(NOTICE_DISMISS_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  /**
   * ⚠️ 이 계약의 존재 이유: 창만 바꾸고 버튼 문구를 안 고치면 **화면이 거짓말을 한다**
   * (7일 억제해 놓고 "24시간 동안 안 보기"라고 적혀 있는 상태). 문구를 상수에서 파생시키고,
   * 파생이 실제로 따라오는지를 여기서 본다.
   */
  it("버튼 문구는 창에서 파생된다 — 상수만 바꿔도 화면이 따라온다", () => {
    expect(noticeDismissLabel()).toBe("일주일 동안 안 보기");
    // 24시간은 "1일" 로 읽힌다 — 구 문구("24시간 동안 안 보기")를 되살리려는 게 아니라,
    // 창을 되돌려도 문구가 **거짓말하지 않는다**는 것만 본다.
    expect(noticeDismissLabel(24 * 60 * 60 * 1000)).toBe("1일 동안 안 보기");
    expect(noticeDismissLabel(3 * 24 * 60 * 60 * 1000)).toBe("3일 동안 안 보기");
    expect(noticeDismissLabel(2 * 60 * 60 * 1000)).toBe("2시간 동안 안 보기");
  });

  /**
   * #473 — 버튼이 하나가 되면서 "누르면 무슨 일이 일어나나"를 말하는 자리가 이 문구뿐이다.
   * 기간을 손으로 적으면(하드코딩 "일주일") 창을 되돌리는 날 화면이 거짓말한다.
   */
  it("닫기 안내도 같은 창에서 파생된다 — 기간이 하드코딩이면 죽는다", () => {
    expect(noticeDismissHint()).toContain("일주일");
    expect(noticeDismissHint(3 * 24 * 60 * 60 * 1000)).toContain("3일");
    expect(noticeDismissHint(3 * 24 * 60 * 60 * 1000)).not.toContain("일주일");
    // 되돌아갈 곳을 같이 말한다 — 억제가 "영영 못 봄"이 아니라는 것이 이 설계의 전제다.
    expect(noticeDismissHint()).toContain("공지");
  });
});

describe("억제 — [닫기](일주일·기기) / 목록 펼침(세션)", () => {
  it("세션 기록(목록 펼침)은 sessionStorage 에만 남고 그 공지만 사라진다", () => {
    const data = { notices: [notice("A"), notice("B")] };
    markNoticeClosed(stores, noticeSuppressionKey({ id: "A", revision: 1 }));

    expect(visibleNotices(data, NOW, stores).map((n) => n.id)).toEqual(["B"]);
    expect(JSON.parse(stores.session!.getItem(NOTICE_CLOSED_KEY)!)).toEqual(["A@1"]);
    expect(stores.local!.getItem(NOTICE_DISMISSED_KEY)).toBeNull();

    // 세션 리셋(새 탭) = 다시 뜬다.
    const fresh: NoticeStores = { session: memStorage(), local: stores.local };
    expect(visibleNotices(data, NOW, fresh).map((n) => n.id)).toEqual(["A", "B"]);
  });

  it("억제는 만료 시각을 기록하고, 지나면 다시 뜬다", () => {
    const data = { notices: [notice("A")] };
    const expiresAt = markNoticeDismissed(stores, "A@1", NOW);
    expect(expiresAt).toBe(NOW + NOTICE_DISMISS_WINDOW_MS);
    expect(JSON.parse(stores.local!.getItem(NOTICE_DISMISSED_KEY)!)).toEqual({ "A@1": expiresAt });

    expect(visibleNotices(data, NOW, stores)).toHaveLength(0);
    expect(visibleNotices(data, expiresAt - 1, stores)).toHaveLength(0);
    expect(visibleNotices(data, expiresAt + 1, stores).map((n) => n.id)).toEqual(["A"]);
  });

  it("만료된 항목은 읽을 때 청소된다 (무한 증가 방지)", () => {
    markNoticeDismissed(stores, "OLD@1", NOW - 2 * NOTICE_DISMISS_WINDOW_MS);
    markNoticeDismissed(stores, "NEW@1", NOW);
    expect(Object.keys(readDismissedMap(stores.local, NOW))).toEqual(["NEW@1"]);
  });

  it("억제는 **그 장 하나에만** 적용된다 (회차 일괄 아님)", () => {
    const data = { notices: [notice("A"), notice("B"), notice("C")] };
    markNoticeDismissed(stores, "A@1", NOW);
    markNoticeClosed(stores, "B@1");
    expect(visibleNotices(data, NOW, stores).map((n) => n.id)).toEqual(["C"]);
  });

  it("새 공지(다른 id)는 억제 중에도 뜬다", () => {
    markNoticeDismissed(stores, "A@1", NOW);
    expect(visibleNotices({ notices: [notice("A"), notice("NEW")] }, NOW, stores).map((n) => n.id)).toEqual([
      "NEW",
    ]);
  });

  /**
   * #473 (hero: *"공지들 다 일주일 안보기로 바꿔"*) — 팝업 [닫기]의 유일한 쓰기 경로.
   *
   * ⚠️ **`markNoticeClosed` 로 되돌리는 변이가 이 계약에서 죽어야 한다.** 구 동작은 세션 범위라
   * 브라우저를 새로 열면 같은 공지가 그대로 다시 떴다 — 그게 hero 가 본 화면이다.
   */
  it("닫기는 일주일 억제를 기기에 기록한다 — 새 탭에서도 안 뜬다", () => {
    const data = { notices: [notice("A"), notice("B")] };
    const expiresAt = markNoticeSuppressed(stores, "A@1", NOW);
    expect(expiresAt).toBe(NOW + NOTICE_DISMISS_WINDOW_MS);

    // 세션을 통째로 갈아도(= 브라우저 새로 열기) 억제가 살아 있다.
    const fresh: NoticeStores = { session: memStorage(), local: stores.local };
    expect(visibleNotices(data, NOW, fresh).map((n) => n.id)).toEqual(["B"]);
    expect(visibleNotices(data, expiresAt + 1, fresh).map((n) => n.id)).toEqual(["A", "B"]);
  });

  /**
   * ⚠️ 백스톱 — `localStorage` 가 없는 브라우저(Safari 프라이빗·iframe 정책)에서 로컬만 쓰면
   * **아무것도 기록되지 않아** 로비를 오갈 때마다 같은 팝업이 다시 뜬다(고치기 전보다 나쁘다).
   * 세션 쓰기를 빼는 변이가 여기서 죽는다.
   */
  it("localStorage 가 없어도 그 탭 세션 동안은 조용하다 (백스톱)", () => {
    const noLocal: NoticeStores = { session: memStorage(), local: null };
    markNoticeSuppressed(noLocal, "A@1", NOW);
    expect(visibleNotices({ notices: [notice("A")] }, NOW, noLocal)).toHaveLength(0);
  });

  it("revision 이 오르면(내용 수정) 억제를 뚫고 다시 뜬다 — 변이체 킬", () => {
    markNoticeDismissed(stores, "A@1", NOW);
    markNoticeClosed(stores, "A@1");
    // 키에서 revision 을 빼면(=id 만 쓰면) 이 단언이 깨진다: 오탈자 수정본을 아무도 못 본다.
    expect(visibleNotices({ notices: [notice("A", 2)] }, NOW, stores).map((n) => n.id)).toEqual(["A"]);
    expect(noticeSuppressionKey({ id: "A", revision: 2 })).toBe("A@2");
  });
});

describe("저장소 오염 — 조용히 무시하고 표시한다", () => {
  it("JSON 이 깨져 있어도 예외 없이 전부 보인다", () => {
    const broken: NoticeStores = {
      session: memStorage({ [NOTICE_CLOSED_KEY]: "{not json" }),
      local: memStorage({ [NOTICE_DISMISSED_KEY]: "]]]" }),
    };
    expect(visibleNotices({ notices: [notice("A")] }, NOW, broken).map((n) => n.id)).toEqual(["A"]);
  });

  it("타입이 뒤바뀐 값(배열↔객체, 숫자 아닌 만료)도 흡수한다", () => {
    const weird: NoticeStores = {
      session: memStorage({ [NOTICE_CLOSED_KEY]: JSON.stringify({ a: 1 }) }),
      local: memStorage({ [NOTICE_DISMISSED_KEY]: JSON.stringify(["A@1"]) }),
    };
    expect(visibleNotices({ notices: [notice("A")] }, NOW, weird).map((n) => n.id)).toEqual(["A"]);

    const nan: NoticeStores = {
      session: memStorage(),
      local: memStorage({ [NOTICE_DISMISSED_KEY]: JSON.stringify({ "A@1": "나중에" }) }),
    };
    expect(visibleNotices({ notices: [notice("A")] }, NOW, nan).map((n) => n.id)).toEqual(["A"]);
  });

  it("저장소를 아예 못 쓰는 환경에서도 동작한다(억제만 안 될 뿐)", () => {
    const none: NoticeStores = { session: null, local: null };
    markNoticeClosed(none, "A@1");
    markNoticeDismissed(none, "A@1", NOW);
    expect(visibleNotices({ notices: [notice("A")] }, NOW, none).map((n) => n.id)).toEqual(["A"]);
  });
});

/**
 * 공지 목록(다시 보기) — **억제는 팝업에만 적용된다**.
 *
 * 이 계약이 지키는 성질: 24시간 안 보기를 누른 뒤 그 사이 노출 기간이 끝나면 팝업으로는
 * **영영 못 보는** 공지가 생긴다. 목록이 그 상태를 구제한다 — 여기서까지 억제하면 기능이
 * 존재할 이유가 없다(변이체: `all` 을 `visibleNotices` 로 바꾸면 여기가 깨진다).
 */
describe("noticeCenterView — 목록은 억제와 무관, 점만 억제를 본다", () => {
  const raw = { notices: [notice("A"), notice("B"), notice("C")] };

  it("아무것도 안 읽었으면 전체 = 안 읽음", () => {
    const v = noticeCenterView(raw, NOW, stores);
    expect(v.all.map((n) => n.id)).toEqual(["A", "B", "C"]);
    expect(v.unread.map((n) => n.id)).toEqual(["A", "B", "C"]);
  });

  it("[24시간 안 보기]·[닫기] 를 누른 공지도 **목록에는 남는다** (점만 줄어든다)", () => {
    markNoticeDismissed(stores, "A@1", NOW);
    markNoticeClosed(stores, "B@1");
    const v = noticeCenterView(raw, NOW, stores);
    expect(v.all.map((n) => n.id), "목록은 전부 보인다").toEqual(["A", "B", "C"]);
    expect(v.unread.map((n) => n.id), "안 읽음만 줄어든다").toEqual(["C"]);
    expect([...v.unreadKeys]).toEqual(["C@1"]);
  });

  it("전부 읽으면 점은 0 이지만 목록은 그대로다", () => {
    for (const id of ["A", "B", "C"]) markNoticeClosed(stores, `${id}@1`);
    const v = noticeCenterView(raw, NOW, stores);
    expect(v.unread).toEqual([]);
    expect(v.all).toHaveLength(3);
  });

  it("안 읽음 집합은 `visibleNotices`(팝업이 쓰는 것)와 **같은 집합**이다", () => {
    markNoticeDismissed(stores, "B@1", NOW);
    const v = noticeCenterView(raw, NOW, stores);
    expect(v.unread.map((n) => n.id)).toEqual(
      visibleNotices(raw, NOW, stores).map((n) => n.id),
    );
  });

  it("응답이 이상하면 빈 뷰 — 진입점이 로비를 죽이지 않는다", () => {
    for (const bad of [undefined, null, {}, { notices: "곧" }, [{ id: "A" }]]) {
      const v = noticeCenterView(bad, NOW, stores);
      expect(v.all).toEqual([]);
      expect(v.unread).toEqual([]);
    }
  });
});
