/**
 * QA 뷰어 스킨 페이로드 계약 (#184 / #218).
 *
 * 왜 픽스처인가: 실제 스테이징(`apps/web/public/chars`) + 데모 로그 조합은 선수가 P001~P022 로
 * 매핑돼 **characters 축만** 밟는다. 그래서 v2 축 해석·units 실아트·멀티 아틀라스·공용 디폴트 제외
 * 같은 분기가 실물로는 한 번도 실행되지 않는다(#184 가 조용히 살아있던 이유이기도 하다 —
 * 매핑이 v2 객체로 바뀌었는데 아무도 안 밟아 페이로드가 null 인 걸 몰랐다).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildQaSkin } from "./qa-skin.mjs";

/** 소비 측 투영 — `.mjs` 라 반환형이 없다. 계약이 보는 필드만 좁게 선언한다. */
interface QaSkin {
  atlases: Array<{ url: string; tile: number }>;
  byPlayer: Record<string, { col: number; row: number; atlas?: number; num?: string; bg?: string } | undefined>;
  nums: Record<string, string | undefined>;
  atlasUrl: string;
  tile: number;
}
const build = (log: unknown, dir: string) => buildQaSkin(log, dir) as QaSkin | null;

let dir: string;

/** 최소 스테이징 트리 — manifest 3종 + 아틀라스 2장(내용은 무관, base64 로 감싸 실릴 뿐이다). */
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-skin-"));
  mkdirSync(join(dir, "characters"));
  mkdirSync(join(dir, "units"));
  writeFileSync(join(dir, "characters", "avatars-64.png"), "fake-png-a");
  writeFileSync(join(dir, "units", "avatars-64.png"), "fake-png-b");
  writeFileSync(
    join(dir, "characters", "manifest.json"),
    JSON.stringify({ characters: { aura: { col: 3, row: 0 }, lupus: { col: 1, row: 2 } } }),
  );
  writeFileSync(
    join(dir, "units", "manifest.json"),
    JSON.stringify({
      units: {
        bonaldo: { col: 0, row: 0, iconBackground: "opaque-dark", forPlayer: "P003" },
        "default-unit": { col: 2, row: 1, forGrades: ["GOLD", "SILVER", "BRONZE"] },
      },
    }),
  );
  writeFileSync(
    join(dir, "player-chars.json"),
    JSON.stringify({
      version: "v2",
      players: {
        P001: { axis: "characters", id: "aura" },
        P002: { axis: "characters", id: "lupus" },
        P003: { axis: "units", id: "bonaldo" },
        P004: { axis: "units", id: "default-unit" },
      },
    }),
  );
});

/** 데모 로그 형상 — first-seen 순서로 P001.. 에 매핑된다(홈 3 · 어웨이 1). */
const log = {
  tickSnapshots: [
    {
      players: [
        { playerId: "H0", team: "home" },
        { playerId: "H1", team: "home" },
        { playerId: "H2", team: "home" },
        { playerId: "A0", team: "away" },
      ],
    },
  ],
};

describe("buildQaSkin", () => {
  it("v2 축 매핑을 해석해 두 축을 각자 아틀라스로 싣는다(#218)", () => {
    const skin = build(log, dir)!;
    expect(skin, "페이로드가 null 이면 셸이 스킨 버튼을 숨긴다 = #184").not.toBeNull();
    expect(skin.atlases).toHaveLength(2);
    // 0번 = characters(구 코어가 보는 `atlasUrl`), 1번 = units.
    expect(skin.atlasUrl).toBe(skin.atlases[0]!.url);
    expect(skin.atlases[0]!.url.startsWith("data:image/png;base64,")).toBe(true);

    expect(skin.byPlayer.H0).toEqual({ col: 3, row: 0, num: "1" }); // characters → atlas 생략(=0)
    expect(skin.byPlayer.H2).toEqual({ col: 0, row: 0, atlas: 1, num: "3", bg: "opaque-dark" });
  });

  it("등급 공용 디폴트는 안 싣는다 — 뷰어가 팀색 원으로(U-D8)", () => {
    const skin = build(log, dir)!;
    expect(skin.byPlayer.A0, "default-unit 매핑 선수").toBeUndefined();
    // 셀이 없어도 **등번호는 실린다** — 없으면 코어가 id 원문("A0")으로 떨어진다(#218 AC2).
    expect(skin.nums.A0).toBe("1");
  });

  it("구 v1 문자열 매핑도 그대로 태운다(롤백 안전)", () => {
    const v1 = mkdtempSync(join(tmpdir(), "qa-skin-v1-"));
    mkdirSync(join(v1, "characters"));
    writeFileSync(join(v1, "characters", "avatars-64.png"), "fake-png-a");
    writeFileSync(join(v1, "characters", "manifest.json"), JSON.stringify({ characters: { aura: { col: 1, row: 1 } } }));
    writeFileSync(join(v1, "player-chars.json"), JSON.stringify({ players: { P001: "aura" } }));
    const skin = build(log, v1)!;
    expect(skin.byPlayer.H0).toEqual({ col: 1, row: 1, num: "1" });
    expect(skin.atlases).toHaveLength(1);
  });

  it("에셋이 없으면 null — 엔진 뷰어는 char 에셋 없이도 빌드된다(graceful)", () => {
    expect(build(log, join(tmpdir(), "qa-skin-none"))).toBeNull();
  });
});
