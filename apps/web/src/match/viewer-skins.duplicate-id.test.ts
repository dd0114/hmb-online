/**
 * #324 — 같은 선수가 양 팀에 동시 출전할 때 등번호가 상대팀 것으로 나가는 결함.
 *
 * 유저 덱과 봇 로스터가 **같은 선수 카탈로그를 공유**하므로 같은 `playerId` 가 양 팀에 뛴다
 * (라이브 101하프 중 **38% 가 중복 1명 이상**, 11% 가 5명 이상). 그런데 `jerseyNumbers()` 는
 * 번호를 팀별로 세면서(`seen[team]++`) 저장은 `out[playerId]` 로 하고 두 번째 팀 인스턴스를
 * `if (out[p.playerId]) continue` 로 건너뛰었다 →
 *  - 중복 선수는 **먼저 나온 팀(home) 번호**를 달고,
 *  - away 카운터가 그만큼 안 늘어 **away 전체 번호가 밀린다**.
 *
 * 라이브 실측(qwerqew vs 블루 월, 중복 6명): away = `1,2,3,4,3,2,8,7,5,9,11`
 * — 팀 안에 #2·#3 이 중복이고 11명 중 6명이 홈 선수 번호를 달았다. 그 실제 로스터로 계약을 건다.
 */
import { describe, expect, it } from "vitest";
import { jerseyNumbers, buildViewerSkins } from "./viewer-skins";
import { skinKeyOf } from "@hmb/viewer-core";

/** 라이브 매치 01KYSQP559QVYSXV4SAKS0RFTD 전반의 실제 라인업(중복 6명: P078·P079·P092·P093·P106·P107). */
const HOME = ["P074", "P079", "P078", "P081", "P080", "P175", "P093", "P092", "P106", "P108", "P107"];
const AWAY = ["P116", "P118", "P119", "P077", "P078", "P079", "P092", "P093", "P094", "P106", "P107"];

const liveLog = {
  tickSnapshots: [
    {
      players: [
        ...HOME.map((playerId) => ({ playerId, team: "home" })),
        ...AWAY.map((playerId) => ({ playerId, team: "away" })),
      ],
    },
  ],
};

const numsOf = (table: Record<string, string>, team: string, ids: string[]): string[] =>
  ids.map((id) => table[skinKeyOf(team, id)] ?? table[id] ?? "?");

describe("#324 중복 playerId — 등번호가 팀별로 독립이어야 한다", () => {
  it("양 팀 모두 1~11 을 한 번씩 단다(팀 안 중복 없음)", () => {
    const t = jerseyNumbers(liveLog);
    for (const [team, ids] of [
      ["home", HOME],
      ["away", AWAY],
    ] as const) {
      const nums = numsOf(t, team, ids);
      expect(new Set(nums).size, `${team} 등번호 = [${nums.join(",")}]`).toBe(11);
      expect(nums.slice().sort((a, b) => Number(a) - Number(b))).toEqual(
        ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
      );
    }
  });

  it("중복 선수는 팀마다 자기 팀 번호를 단다 — 상대팀 번호를 물려받지 않는다", () => {
    const t = jerseyNumbers(liveLog);
    // P078: home 슬롯 2(→#3) · away 슬롯 4(→#5). 고치기 전에는 둘 다 "3" 이었다.
    expect(t[skinKeyOf("home", "P078")]).toBe("3");
    expect(t[skinKeyOf("away", "P078")]).toBe("5");
    // P107: home 슬롯 10(→#11) · away 슬롯 10(→#11). 우연히 같은 것은 정상이다.
    expect(t[skinKeyOf("home", "P107")]).toBe("11");
    expect(t[skinKeyOf("away", "P107")]).toBe("11");
    // P092: home 슬롯 7(→#8) · away 슬롯 6(→#7).
    expect(t[skinKeyOf("away", "P092")]).toBe("7");
  });

  it("등번호는 그 팀 안 등장 순서(=라인업 순서)를 따른다", () => {
    const t = jerseyNumbers(liveLog);
    expect(numsOf(t, "away", AWAY)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
  });

  it("중복이 없는 경기는 종전과 같다(무회귀)", () => {
    const plain = {
      tickSnapshots: [
        { players: [{ playerId: "P001", team: "home" }, { playerId: "P002", team: "away" }] },
      ],
    };
    const t = jerseyNumbers(plain);
    expect(t[skinKeyOf("home", "P001")]).toBe("1");
    expect(t[skinKeyOf("away", "P002")]).toBe("1");
  });

  it("교체 선수(첫 스냅샷에 없음)도 자기 팀 번호를 받는다", () => {
    const withSub = {
      tickSnapshots: [
        { players: [{ playerId: "P001", team: "home" }, { playerId: "P002", team: "away" }] },
        { players: [{ playerId: "P009", team: "home" }, { playerId: "P002", team: "away" }] },
      ],
    };
    const t = jerseyNumbers(withSub);
    expect(t[skinKeyOf("home", "P009")]).toBe("2");
  });

  it("buildViewerSkins 의 nums 도 팀 구분 키로 나간다(코어가 그걸 읽는다)", () => {
    const skins = buildViewerSkins({ characters: null, units: null, placeholders: null, mapping: null }, liveLog, null);
    expect(skins, "등번호만 있어도 페이로드는 나온다").toBeTruthy();
    expect(skins!.nums[skinKeyOf("home", "P078")]).toBe("3");
    expect(skins!.nums[skinKeyOf("away", "P078")]).toBe("5");
  });
});
