import { describe, expect, it } from "vitest";
import {
  attachmentChips,
  canClaim,
  hasAttachments,
  normalizeMails,
  stateLabel,
} from "./mail-logic";
import type { Mail } from "../api/mails";

function mail(over: Partial<Mail> = {}): Mail {
  return {
    id: "m1",
    title: "제목",
    body: "본문",
    attachments: { points: 0, gems: 0, players: [] },
    sentAt: "2026-07-30T00:00:00Z",
    expiresAt: null,
    readAt: null,
    claimedAt: null,
    state: "UNREAD",
    ...over,
  };
}

describe("normalizeMails — 응답 형태를 믿지 않는다", () => {
  /**
   * 구 서버·프록시의 200 `{}` 하나가 홈 헤더를 죽이면 안 된다. #245 가 로비에서 정확히 이렇게
   * 당했고("부가 기능이 앱 진입점을 죽이면 안 된다"), 홈은 이제 그 진입점이다.
   */
  it("빈 객체·null·배열 아닌 mails 를 전부 빈 목록으로 접는다", () => {
    for (const raw of [undefined, null, {}, { mails: null }, { mails: "nope" }]) {
      expect(normalizeMails(raw)).toEqual({ mails: [], unread: 0 });
    }
  });

  it("id 가 없는 행은 버린다(그릴 수 없는 행이 목록을 죽이지 않게)", () => {
    const view = normalizeMails({ mails: [{ title: "id 없음" }, { id: "m1" }], unread: 1 });
    expect(view.mails.map((m) => m.id)).toEqual(["m1"]);
  });

  it("첨부가 통째로 없거나 players 가 배열이 아니어도 0/빈 배열로 성립한다", () => {
    const view = normalizeMails({ mails: [{ id: "m1", attachments: { players: "nope" } }] });
    expect(view.mails).toHaveLength(1);
    expect(view.mails[0]!.attachments).toEqual({ points: 0, gems: 0, players: [] });
  });

  /** 뱃지는 **서버 값**이다 — 목록에서 세면 목록 상한(50건) 밖의 우편물이 조용히 빠진다. */
  it("unread 는 서버 값을 그대로 쓰고, 숫자가 아니면 0", () => {
    expect(normalizeMails({ mails: [], unread: 7 }).unread).toBe(7);
    expect(normalizeMails({ mails: [], unread: "7" }).unread).toBe(0);
    expect(normalizeMails({ mails: [], unread: -3 }).unread).toBe(0);
  });
});

describe("상태는 서버가 정한다", () => {
  /**
   * 화면이 `expiresAt < now` 를 계산하면 **기기 시계가 진실**이 된다 — 폰 시계가 하루 빠른
   * 유저에게 멀쩡한 보상이 만료로 보인다. 그래서 만료 판정에 시각이 들어가지 않는다.
   */
  it("아직 안 지난 만료일이 붙어 있어도 state 가 EXPIRED 면 못 받는다", () => {
    const far = mail({ state: "EXPIRED", expiresAt: "2999-01-01T00:00:00Z", attachments: { points: 100, gems: 0, players: [] } });
    expect(canClaim(far)).toBe(false);
  });

  it("이미 지난 만료일이 붙어 있어도 state 가 UNREAD 면 받을 수 있다", () => {
    const past = mail({ state: "UNREAD", expiresAt: "2000-01-01T00:00:00Z", attachments: { points: 100, gems: 0, players: [] } });
    expect(canClaim(past)).toBe(true);
  });

  it("첨부가 없으면 받을 게 없다(텍스트 전용 안내)", () => {
    expect(canClaim(mail({ state: "UNREAD" }))).toBe(false);
    expect(hasAttachments({ points: 0, gems: 0, players: [] })).toBe(false);
    expect(hasAttachments({ points: 0, gems: 0, players: [{ playerId: "P001", count: 1 }] })).toBe(true);
  });

  it("라벨 — 만료는 사라지지 않고 '만료됨' 으로 남는다(hero 확정 ④)", () => {
    const withReward = { points: 100, gems: 0, players: [] };
    expect(stateLabel(mail({ state: "UNREAD", attachments: withReward }))).toBe("받기");
    expect(stateLabel(mail({ state: "CLAIMED", attachments: withReward }))).toBe("수령 완료");
    expect(stateLabel(mail({ state: "EXPIRED", attachments: withReward }))).toContain("만료됨");
    expect(stateLabel(mail({ state: "READ" }))).toBeNull();
  });
});

describe("attachmentChips — 심볼을 조립하지 않는다", () => {
  /**
   * 재화 표기는 서버 config 가 SoT(#232)이고 화면은 `<Amount>` 로만 그린다. 여기서 문자열을
   * 만들면 다음 사람이 `${n} P` 를 적게 되고, 그게 30군데가 됐던 경위다.
   */
  it("값만 실어 보낸다(라벨 문자열 없음)", () => {
    const chips = attachmentChips({
      points: 5000,
      gems: 10,
      players: [{ playerId: "P001", count: 2 }],
    });
    expect(chips).toEqual([
      { key: "points", kind: "points", value: 5000 },
      { key: "gems", kind: "gems", value: 10 },
      { key: "player:P001", kind: "player", playerId: "P001", count: 2 },
    ]);
    expect(JSON.stringify(chips)).not.toMatch(/[PGZ]\b/);
  });

  it("0 인 재화는 칩을 만들지 않는다(빈 칩이 '받을 게 있다'로 읽히지 않게)", () => {
    expect(attachmentChips({ points: 0, gems: 0, players: [] })).toEqual([]);
  });
});
