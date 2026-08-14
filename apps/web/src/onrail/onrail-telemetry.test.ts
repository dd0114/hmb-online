// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #504 D2 — 온레일 계측.
 *
 * ## 이 계약이 지키는 것
 * 이 웨이브의 목적은 **"제안을 못 받았다"와 "제안을 받고 거절했다"를 서버에서 가르는 것**이고,
 * 그 목적은 "요청이 나갔다"만으로는 지켜지지 않는다. 그래서 세 축을 따로 건다:
 * ①구별 가능성(다른 사실은 다른 이벤트) ②동선 무해(실패·저장소 손상이 아무것도 막지 않는다)
 * ③중복 억제가 **결손 고착**으로 바뀌지 않는다(실패하면 다음에 다시 시도한다).
 *
 * ⚠️ ③이 없으면 "표시부터 하고 보낸다"가 조용히 **네트워크 한 번 튄 유저를 영영 관측 밖**으로
 * 보낸다 — 그건 이 웨이브가 없애려는 상태 그 자체다. 성공 경로만 재는 계약은 그 변이를 못 죽인다.
 */

const apiFetch = vi.fn();
vi.mock("../api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const {
  ONRAIL_EVENTS,
  ONRAIL_SENT_MAX,
  appendSentMarker,
  clearSentMarkers,
  readSentMarkers,
  reportOnRail,
  sentMarkerOf,
  writeSentMarkers,
} = await import("./onrail-telemetry");

const UID = "01USER504";

function bodyOf(call: unknown[] | undefined): Record<string, string> {
  if (!call) throw new Error("호출이 없다 — 계측이 통째로 나가지 않았다");
  return (call[1] as { body: Record<string, string> }).body;
}

beforeEach(() => {
  window.localStorage.clear();
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ recorded: true });
});

afterEach(() => {
  window.localStorage.clear();
});

describe("#504 — 온레일 사실 보고", () => {
  it("제안 노출·수락·거절이 서로 다른 이벤트로 나간다 (이 웨이브의 존재 이유)", () => {
    reportOnRail(UID, ONRAIL_EVENTS.offerShown);
    reportOnRail(UID, ONRAIL_EVENTS.declined);

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls.map((c) => bodyOf(c).event)).toEqual([
      "onrail_offer_shown",
      "onrail_declined",
    ]);
    // 경로도 같아야 한다 — 서버 화이트리스트가 이 경로에서만 열린다.
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/me/onrail-events");
  });

  it("우회 관측은 어느 경로로 왔는지를 같이 싣는다 (D1 처방을 고를 근거)", () => {
    reportOnRail(UID, ONRAIL_EVENTS.offerMissed, { path: "/game" });
    expect(bodyOf(apiFetch.mock.calls[0])).toEqual({ event: "onrail_offer_missed", path: "/game" });
  });

  it("스텝은 스텝별로 한 번씩 나간다 — 같은 스텝 재렌더는 안 나간다", () => {
    reportOnRail(UID, ONRAIL_EVENTS.step, { stepId: "deck-player" });
    reportOnRail(UID, ONRAIL_EVENTS.step, { stepId: "deck-player" });
    reportOnRail(UID, ONRAIL_EVENTS.step, { stepId: "deck-save" });

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls.map((c) => bodyOf(c).stepId)).toEqual(["deck-player", "deck-save"]);
  });

  it("스텝 억제가 이벤트 전체를 삼키지 않는다 — 스텝 마커는 스텝 id 로 갈린다", () => {
    expect(sentMarkerOf(ONRAIL_EVENTS.step, "a")).not.toBe(sentMarkerOf(ONRAIL_EVENTS.step, "b"));
    expect(sentMarkerOf(ONRAIL_EVENTS.done)).toBe("onrail_done");
  });

  it("한 번뿐인 사실은 새로고침을 넘겨서도 한 번만 나간다 (저장소가 localStorage 인 이유)", () => {
    reportOnRail(UID, ONRAIL_EVENTS.accepted);
    expect(readSentMarkers(UID)).toContain("onrail_accepted");

    // 모듈 상태가 아니라 저장소를 본다 — 새로고침 = 메모리 소실이므로 메모리 캐시로는 못 좁힌다.
    reportOnRail(UID, ONRAIL_EVENTS.accepted);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("계정마다 격리된다 — 한 기기에서 계정을 바꿔도 남의 이력을 물려받지 않는다", () => {
    reportOnRail(UID, ONRAIL_EVENTS.accepted);
    reportOnRail("01OTHERUSER", ONRAIL_EVENTS.accepted);
    expect(apiFetch).toHaveBeenCalledTimes(2);

    clearSentMarkers(UID);
    expect(readSentMarkers(UID)).toEqual([]);
    expect(readSentMarkers("01OTHERUSER")).toContain("onrail_accepted");
  });

  it("userId 를 모르면 아무것도 보내지 않는다 (익명 키를 만들지 않는 규율)", () => {
    reportOnRail(null, ONRAIL_EVENTS.offerShown);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  // ── 동선 무해 ────────────────────────────────────────────────────────

  it("보고는 던지지 않고 반환값도 없다 — 호출부가 분기할 것이 있으면 그게 동선 변경이다", () => {
    apiFetch.mockRejectedValue(new Error("500"));
    expect(() => reportOnRail(UID, ONRAIL_EVENTS.done)).not.toThrow();
    expect(reportOnRail(UID, ONRAIL_EVENTS.step, { stepId: "x" })).toBeUndefined();
  });

  it("저장소가 막혀 있어도(사파리 프라이빗) 보고는 나간다", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    try {
      expect(() => reportOnRail(UID, ONRAIL_EVENTS.offerShown)).not.toThrow();
      expect(apiFetch).toHaveBeenCalledTimes(1);
    } finally {
      setItem.mockRestore();
    }
  });

  it("손상된 이력은 빈 이력으로 읽는다 — 계측 한 줄이 진행도를 잃게 하지 않는다", () => {
    window.localStorage.setItem(`hmb.onrail.sent.${UID}`, "{{ not json");
    expect(readSentMarkers(UID)).toEqual([]);
    reportOnRail(UID, ONRAIL_EVENTS.offerShown);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  // ── 억제가 결손 고착이 되지 않는다 ──────────────────────────────────

  it("전송이 실패하면 표시를 되돌린다 — 네트워크 한 번 튄 유저가 영영 관측 밖이 되면 안 된다", async () => {
    apiFetch.mockRejectedValueOnce(new Error("network"));
    reportOnRail(UID, ONRAIL_EVENTS.offerMissed, { path: "/game" });
    // 보내기 **전에** 표시한다(같은 전이가 두 번 그려져도 두 번 나가지 않게).
    expect(readSentMarkers(UID)).toContain("onrail_offer_missed");

    await Promise.resolve();
    await Promise.resolve();
    expect(readSentMarkers(UID)).not.toContain("onrail_offer_missed");

    reportOnRail(UID, ONRAIL_EVENTS.offerMissed, { path: "/game" });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("이력은 무한히 자라지 않고, 넘치면 오래된 쪽을 버린다", () => {
    let sent: string[] = [];
    for (let i = 0; i < ONRAIL_SENT_MAX + 10; i++) sent = appendSentMarker(sent, `onrail_step:s${i}`);
    expect(sent).toHaveLength(ONRAIL_SENT_MAX);
    expect(sent.at(-1)).toBe(`onrail_step:s${ONRAIL_SENT_MAX + 9}`);
    expect(appendSentMarker(sent, sent[0] as string)).toEqual(sent);
  });

  it("이벤트 이름은 서버 화이트리스트와 같은 문자열이다 (다르면 400)", () => {
    // 서버 `BusinessEvent.CLIENT_REPORTABLE` 과 값이 갈리면 전 계측이 조용히 400 이 된다.
    expect(Object.values(ONRAIL_EVENTS)).toEqual([
      "onrail_offer_shown",
      "onrail_offer_missed",
      "onrail_accepted",
      "onrail_declined",
      "onrail_step",
      "onrail_done",
    ]);
  });

  it("writeSentMarkers 는 userId 가 없으면 아무 키도 만들지 않는다", () => {
    writeSentMarkers(null, ["onrail_done"]);
    expect(window.localStorage.length).toBe(0);
  });
});
