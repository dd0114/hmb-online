// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  ONRAIL_SKIP_LOG_MAX,
  appendSkip,
  clearOnRail,
  onRailSettled,
  readOnRail,
  writeOnRail,
} from "./onrail-storage";

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
    expect(readOnRail("uB")).toMatchObject({ status: "idle", stepId: null, matchId: null });
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
    expect(readOnRail("uA")).toEqual({
      status: "running",
      stepId: null,
      matchId: null,
      // #493 W9 로 축이 둘 늘었다. 모르는 값은 **빈 것**이지 undefined 가 아니다 —
      // 소비처가 `?? []` 를 각자 적기 시작하면 그중 하나는 반드시 빠뜨린다.
      skips: [],
      deckDraftReset: false,
    });
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

  // ── 스킵 기록 (#493 W9) ────────────────────────────────────────────────
  //
  // 기록은 **부차적**이다. 그래서 규율이 진행도와 다르다: 진행도는 손상되면 idle 로 흡수하지만
  // (위), 기록은 손상된 **그 한 건만** 버린다 — 로그 하나 때문에 진행도를 잃으면 본말전도다.

  it("건너뛴 사유가 새로고침을 넘어 남는다 — 나중에 셀 수 있어야 기록이다", () => {
    const skip = { stepId: "trade-rush", reason: "target-disabled", to: "trade-accept", at: "2026-08-13T00:00:00Z" } as const;
    writeOnRail("uA", { status: "running", stepId: "trade-accept", matchId: null, skips: [skip] });
    expect(readOnRail("uA").skips).toEqual([skip]);
  });

  it("⚠️ 모양이 아닌 기록만 버린다 — 진행도는 살아남는다", () => {
    window.localStorage.setItem(
      "hmb.onrail.uA",
      JSON.stringify({
        status: "running",
        stepId: "deck-player",
        skips: [
          { stepId: "deck-auto", reason: "target-disabled", to: "deck-player", at: "t" },
          { stepId: "deck-auto", reason: "화성에서-왔다", to: null, at: "t" }, // 모르는 사유
          { reason: "target-missing" }, // 스텝이 없다
          "문자열",
        ],
      }),
    );
    const got = readOnRail("uA");
    expect(got.stepId).toBe("deck-player"); // 진행도 무사
    expect(got.skips).toHaveLength(1);
    expect(got.skips![0]!.reason).toBe("target-disabled");
  });

  it("기록이 배열이 아니어도 진행도는 무사하다", () => {
    window.localStorage.setItem(
      "hmb.onrail.uA",
      JSON.stringify({ status: "running", stepId: "deck-player", skips: "망가짐" }),
    );
    expect(readOnRail("uA")).toMatchObject({ status: "running", stepId: "deck-player", skips: [] });
  });

  it("무한히 자라지 않는다 — 상한을 넘으면 **오래된 쪽**을 버린다(최근 run 이 분석 대상)", () => {
    let skips = [] as ReturnType<typeof appendSkip>;
    for (let i = 0; i < ONRAIL_SKIP_LOG_MAX + 5; i++) {
      skips = appendSkip(skips, { stepId: `s${i}`, reason: "target-missing", to: null, at: "t" });
    }
    expect(skips).toHaveLength(ONRAIL_SKIP_LOG_MAX);
    expect(skips[skips.length - 1]!.stepId).toBe(`s${ONRAIL_SKIP_LOG_MAX + 4}`);
  });

  // ── 덱 드래프트 비우기 지시 (#493 W9) ──────────────────────────────────

  it("일회성 지시는 저장을 넘어간다 — 소비할 화면이 아직 마운트되지 않았기 때문이다", () => {
    writeOnRail("uA", { status: "running", stepId: "deck-auto", matchId: null, deckDraftReset: true });
    expect(readOnRail("uA").deckDraftReset).toBe(true);
  });

  it("⚠️ 지시는 **정확히 true 일 때만** 참이다 — 모르는 값이 빈 보드를 만들면 안 된다", () => {
    window.localStorage.setItem(
      "hmb.onrail.uA",
      JSON.stringify({ status: "running", stepId: "deck-auto", deckDraftReset: "네" }),
    );
    expect(readOnRail("uA").deckDraftReset).toBe(false);
  });
});
