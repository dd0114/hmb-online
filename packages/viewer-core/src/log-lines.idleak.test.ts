import { describe, it, expect } from "vitest";
import { logLines } from "./log-lines";

/**
 * #334 — 화면 텍스트에 **선수 id 원문**이 나오면 안 된다.
 *
 * <p>라이브 실측: 한 하프 로그 164줄 중 번호가 붙는 152줄이 **152/152 전부** `#P108` 같은 내부 id 였다.
 * 소비처는 QA 도구가 아니라 **게임화면 로그 탭**(`apps/web/src/match/stage/LogPanel.tsx`)이다.
 *
 * <p>왜 여태 안 잡혔나: 기존 계약의 이벤트 id 가 전부 `H9/A3` 라 `playerId.replace(/[HA]/,"")` 가
 * **우연히 등번호를 만든다**. 실경기 id 로 재는 계약이 하나도 없었다(#324 에서 같은 함정을 세 번 만났다).
 *
 * <p>코어는 피치 위 **토큰**엔 이미 같은 방어선을 갖고 있었다(#218: `num.length <= 2 ? num : ""`).
 * 자막·로그 라인만 빠져 있었던 것이라, 여기서 규칙을 맞춘다.
 */
describe("#334 로그 라인 — 실경기 id 가 번호로 새지 않는다", () => {
  const ev = (playerId: string, team: "home" | "away" = "home") => [
    { tick: 1, minute: 0, type: "shot", team, playerId, detail: "saved" },
  ];

  it("실경기 id 는 number 를 만들지 않는다(부모가 등번호를 붙일 몫)", () => {
    const [line] = logLines(ev("P108"));
    expect(line!.number, "id 원문이 번호로 나가면 화면에 #P108 이 찍힌다").toBeUndefined();
  });

  it("대신 playerId·team 을 실어 부모가 진짜 등번호를 붙일 수 있게 한다", () => {
    const [line] = logLines(ev("P108", "away"));
    expect(line!.playerId).toBe("P108");
    expect(line!.team).toBe("away");
  });

  it("엔진 픽스처 id 는 종전대로 번호가 나온다(무회귀)", () => {
    expect(logLines(ev("H9"))[0]!.number).toBe("9");
    expect(logLines(ev("A3", "away"))[0]!.number).toBe("3");
  });

  it("어떤 id 든 number 는 등번호로 읽히는 길이여야 한다", () => {
    for (const id of ["P108", "P077", "LONGID", "H10", "A7"]) {
      const n = logLines(ev(id))[0]!.number;
      if (n !== undefined) expect(String(n).length, `${id} → ${n}`).toBeLessThanOrEqual(2);
    }
  });
});

describe("#334 카드 자막 — 실경기 id 가 자막에 새지 않는다", () => {
  it("실경기 id 면 번호 없이 찍는다(id 원문 금지)", async () => {
    const { buildAnnotations } = await import("./playback.mjs");
    const snap = { tick: 1, ball: { x: 20, y: 34 }, ballOwner: null, players: [] };
    const a = buildAnnotations(
      [{ type: "card", tick: 1, minute: 0, team: "away", playerId: "P077", detail: "yellow" }],
      [snap],
    );
    const toast = a.find((x: { kind: string }) => x.kind === "toast");
    expect(toast.text).toBe("🟨 YELLOW");
    expect(toast.text).not.toContain("P077");
  });

  it("엔진 픽스처 id 는 번호가 그대로 붙는다(무회귀)", async () => {
    const { buildAnnotations } = await import("./playback.mjs");
    const snap = { tick: 1, ball: { x: 20, y: 34 }, ballOwner: null, players: [] };
    const a = buildAnnotations(
      [{ type: "card", tick: 1, minute: 0, team: "home", playerId: "H2", detail: "red" }],
      [snap],
    );
    expect(a.find((x: { kind: string }) => x.kind === "toast").text).toBe("🟥 RED #2");
  });
});
