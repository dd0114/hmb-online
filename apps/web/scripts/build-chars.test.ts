/**
 * 캐릭터 에셋 스테이징(build-chars.mjs) 계약 — 순수 판정부 + 실제 스테이징 결과 대조.
 *
 * 스테이징 자체는 부수효과라 여기서 다시 돌리지 않는다(병렬 테스트가 서로 지운다).
 * 대신 ① 재스테이징 판정 로직을 IO 없이 전수로 태우고, ② 이미 스테이징된 트리가 원본과
 * 개수/내용이 맞는지 확인한다. 스테이징이 아직 없으면 ②는 스킵한다(predev 훅이 만든다).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — .mjs 스크립트(타입 선언 없음). 순수 export 만 쓴다.
import { countFiles, readSourceStamp, stageDecision } from "./build-chars.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const outDir = join(repoRoot, "apps", "web", "public", "chars");
const tmpDir = join(here, ".tmp-count-test");

const source = readSourceStamp();
/** 최신 상태를 나타내는 기준 인자 — 각 케이스는 여기서 한 항목만 어긋뜨린다. */
const fresh = {
  hasBaseManifest: true,
  hasCharsManifest: true,
  hasUnitsManifest: true,
  hasMapping: true,
  staged: source,
  source,
  stagedFiles: source.sourceFiles + 1, // +1 = stamp.json
};

afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("stageDecision — 재스테이징 판정", () => {
  it("전부 최신이면 null(스킵)", () => {
    expect(stageDecision(fresh)).toBeNull();
  });

  it("축이 하나라도 없으면 그 이유를 돌려준다", () => {
    expect(stageDecision({ ...fresh, hasBaseManifest: false })).toBe("스테이징 없음");
    expect(stageDecision({ ...fresh, hasCharsManifest: false })).toBe("캐릭터 축 없음");
    expect(stageDecision({ ...fresh, hasUnitsManifest: false })).toBe("유닛 축 없음");
    expect(stageDecision({ ...fresh, hasMapping: false })).toBe("매핑 없음");
  });

  it("스탬프가 없거나 깨졌으면 재스테이징", () => {
    expect(stageDecision({ ...fresh, staged: null })).toBe("스탬프 없음");
  });

  it("발행물이 바뀌면 재스테이징", () => {
    const changed = { ...source, chars: { ...source.chars, count: 99 } };
    expect(stageDecision({ ...fresh, staged: changed })).toBe("발행물 변경");
  });

  it("PNG 만 다시 뽑혀 manifest version 이 그대로여도 바이트 변화를 잡는다", () => {
    // 발행물 version 은 정적(1)이라 이 항목이 없으면 stale 스테이징을 못 잡는다.
    const sameVersionDifferentBytes = { ...source, sourceBytes: source.sourceBytes + 1 };
    expect(stageDecision({ ...fresh, staged: sameVersionDifferentBytes })).toBe("발행물 변경");
  });

  it("파일이 지워지면(부분 손상) 개수 불일치로 잡는다", () => {
    const reason = stageDecision({ ...fresh, stagedFiles: fresh.stagedFiles - 1 });
    expect(reason).toMatch(/파일 수 불일치/);
  });

  it("파일이 더 있어도(잔여물) 재스테이징으로 정리한다", () => {
    expect(stageDecision({ ...fresh, stagedFiles: fresh.stagedFiles + 3 })).toMatch(/파일 수 불일치/);
  });
});

describe("countFiles", () => {
  it("중첩 디렉토리의 파일만 재귀로 센다", () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(join(tmpDir, "sub", "deep"), { recursive: true });
    writeFileSync(join(tmpDir, "a.txt"), "a");
    writeFileSync(join(tmpDir, "sub", "b.txt"), "b");
    writeFileSync(join(tmpDir, "sub", "deep", "c.txt"), "c");
    expect(countFiles(tmpDir)).toBe(3);
  });

  it("없는 경로는 0", () => {
    expect(countFiles(join(tmpDir, "nope"))).toBe(0);
  });
});

describe("소스 스탬프", () => {
  it("네 축을 전부 담는다(유닛 축 = #207 W3-B 발행)", () => {
    expect(source.base.playerCount).toBe(172);
    expect(source.chars.count).toBe(14);
    expect(source.units?.count).toBe(6);
    // 매핑은 v2 — 카탈로그 180 중 177명(미입고 LEGEND 3명은 의도적 미매핑).
    expect(source.mapping?.playerCount).toBe(177);
    expect(source.sourceFiles).toBeGreaterThan(30);
  });

  it("유닛 발행물이 바뀌면 재스테이징으로 잡힌다", () => {
    const changed = { ...source, units: { ...source.units, count: 99 } };
    expect(stageDecision({ ...fresh, staged: changed })).toBe("발행물 변경");
  });
});

describe("스테이징된 트리 (있을 때만)", () => {
  const staged = existsSync(join(outDir, "stamp.json"));

  it.skipIf(!staged)("스테이징 파일 수가 원본 + stamp 와 맞는다", () => {
    expect(countFiles(outDir)).toBe(source.sourceFiles + 1);
  });

  it.skipIf(!staged)("소비자가 fetch 하는 네 파일이 전부 있다", () => {
    for (const rel of ["manifest.json", "characters/manifest.json", "units/manifest.json", "player-chars.json"]) {
      expect(existsSync(join(outDir, rel)), rel).toBe(true);
    }
  });

  it.skipIf(!staged)("유닛 아트 실물이 스테이징된다(완성카드 2 + 프레임리스 4 + 얼굴 6 + 아틀라스 3)", () => {
    const unitsDir = join(outDir, "units");
    const manifest = JSON.parse(readFileSync(join(unitsDir, "manifest.json"), "utf8"));
    for (const [unitId, entry] of Object.entries<{ card: { file: string }; face: string }>(manifest.units)) {
      expect(existsSync(join(outDir, entry.card.file)), `${unitId} card`).toBe(true);
      expect(existsSync(join(outDir, entry.face)), `${unitId} face`).toBe(true);
    }
    for (const atlas of Object.values<{ file: string }>(manifest.atlases)) {
      expect(existsSync(join(outDir, atlas.file)), atlas.file).toBe(true);
    }
  });

  it.skipIf(!staged)("매핑은 버전 없는 안정 이름으로 놓이고 내용이 발행물과 같다", () => {
    const src = readFileSync(join(repoRoot, "data", "players", "player-chars.v2.json"), "utf8");
    expect(readFileSync(join(outDir, "player-chars.json"), "utf8")).toBe(src);
  });
});
