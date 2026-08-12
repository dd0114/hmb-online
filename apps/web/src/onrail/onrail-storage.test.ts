// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { clearOnRail, onRailSettled, readOnRail, writeOnRail } from "./onrail-storage";

/**
 * #493 W7-v3 — 온레일 진행 상태 저장 계약.
 *
 * 지키는 것 셋: **계정 격리** · **손상 입력에 안 죽는다** · **다시 안 묻는다**.
 * 앞의 둘은 `guide-storage` 가 이미 값비싸게 배운 규율이고(한 기기에서 계정을 바꾸면 남의
 * '봤음'이 따라오던 결함), 여기서 되풀이하지 않으려고 같은 모양으로 짰다.
 */
describe("온레일 진행 상태", () => {
  beforeEach(() => window.localStorage.clear());

  it("계정마다 격리된다 — 한 기기에서 계정을 바꿔도 남의 진행도가 안 따라온다", () => {
    writeOnRail("uA", { status: "running", stepId: "deck-save", matchId: null });
    expect(readOnRail("uA").stepId).toBe("deck-save");
    expect(readOnRail("uB")).toEqual({ status: "idle", stepId: null, matchId: null });
  });

  it("userId 를 모르면 **아무것도 쓰지 않는다** — 익명 키는 그 자체가 공유 상태다", () => {
    writeOnRail(null, { status: "running", stepId: "deck-save", matchId: null });
    expect(window.localStorage.length).toBe(0);
    expect(readOnRail(null).status).toBe("idle");
  });

  it("⚠️ 손상된 값은 idle 로 흡수한다 — 값 하나가 앱을 못 쓰게 만들면 안 된다", () => {
    window.localStorage.setItem("hmb.onrail.uA", "{{{망가진 JSON");
    expect(readOnRail("uA").status).toBe("idle");
    window.localStorage.setItem("hmb.onrail.uA", JSON.stringify({ status: "화성" }));
    expect(readOnRail("uA").status).toBe("idle");
    window.localStorage.setItem("hmb.onrail.uA", JSON.stringify(["배열"]));
    expect(readOnRail("uA").status).toBe("idle");
  });

  it("stepId·matchId 는 문자열일 때만 살린다 — 모양이 아니면 null(다음 로직이 첫 스텝으로 되돌린다)", () => {
    window.localStorage.setItem(
      "hmb.onrail.uA",
      JSON.stringify({ status: "running", stepId: 7, matchId: { id: "m1" } }),
    );
    expect(readOnRail("uA")).toEqual({ status: "running", stepId: null, matchId: null });
  });

  it("완주·사양은 '끝났다'로 같이 읽힌다 — 다시 제안하지 않는 근거(조정 ⑥)", () => {
    writeOnRail("uA", { status: "done", stepId: null, matchId: null });
    expect(onRailSettled("uA")).toBe(true);
    writeOnRail("uA", { status: "skipped", stepId: null, matchId: null });
    expect(onRailSettled("uA")).toBe(true);
    writeOnRail("uA", { status: "running", stepId: "deck-auto", matchId: null });
    expect(onRailSettled("uA")).toBe(false);
  });

  it("지우기는 그 계정 몫만 지운다", () => {
    writeOnRail("uA", { status: "running", stepId: "deck-auto", matchId: null });
    writeOnRail("uB", { status: "done", stepId: null, matchId: null });
    clearOnRail("uA");
    expect(readOnRail("uA").status).toBe("idle");
    expect(readOnRail("uB").status).toBe("done");
  });

  it("매치 id 를 넘겨 저장한다 — 새로고침 뒤에도 '내 매치'를 알아야 재생 정지가 남의 경기를 안 얼린다", () => {
    writeOnRail("uA", { status: "running", stepId: "match-pitch", matchId: "m1" });
    expect(readOnRail("uA").matchId).toBe("m1");
  });
});
