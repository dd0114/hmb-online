// @vitest-environment jsdom
/**
 * #479 — 스플래시 소재 정합 계약.
 *
 * 쇼 정의(`ad-show.ts`)와 반입물(`public/splash/**`)은 **다른 사람이 다른 시점에** 만진다:
 * 컷 구간을 고치는 사람과 `scripts/import-splash-assets.mjs` 를 돌리는 사람이 같지 않다.
 * 그래서 둘이 갈라지는 것을 사람 기억이 아니라 여기서 잡는다.
 *
 * ⚠️ **양방향으로 잡는다.** 부족(쇼가 없는 파일을 참조 → 그 컷이 조용히 검은 화면)과
 * 잉여(안 쓰는 파일이 배포에 실려 용량만 먹는다) 둘 다. 한쪽만 걸면 나머지 방향으로 드리프트한다.
 * ⚠️ 기대 목록을 이 파일에 손으로 적지 않는다 — `adShowAssetPaths()` 가 **쇼에서 파생**시킨다.
 *    적어 두면 이 계약이 쇼가 아니라 "내가 적은 목록"을 검사한다.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adShowAssetPaths } from "./ad-show";
import { AD_TOTAL_SEC } from "./ad-show";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPLASH_DIR = join(WEB_ROOT, "public", "splash");

/** `/splash/seq/steal/f-014.webp` → `seq/steal/f-014.webp` */
function toRel(url: string): string {
  const at = url.indexOf("/splash/");
  expect(at, `쇼의 소재 경로가 /splash/ 아래가 아니다: ${url}`).toBeGreaterThanOrEqual(0);
  return url.slice(at + "/splash/".length);
}

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [p.slice(base.length + 1)];
  });
}

describe("#479 스플래시 소재", () => {
  const referenced = adShowAssetPaths().map(toRel);
  const onDisk = walk(SPLASH_DIR);

  it("쇼가 참조하는 프레임이 전부 반입돼 있다", () => {
    const missing = referenced.filter((f) => !onDisk.includes(f));
    expect(
      missing,
      `누락 ${missing.length}건 — node apps/web/scripts/import-splash-assets.mjs 로 반입해라`,
    ).toEqual([]);
  });

  it("반입물에 쇼가 안 쓰는 파일이 없다 (배포 용량 방어)", () => {
    const extra = onDisk.filter((f) => !referenced.includes(f));
    expect(extra, `잉여 ${extra.length}건 — 쇼가 참조하지 않는다`).toEqual([]);
  });

  it("전부 webp 다 — PNG 가 섞여 들어오면 용량이 5배가 된다", () => {
    expect(onDisk.filter((f) => !f.endsWith(".webp"))).toEqual([]);
  });

  /**
   * ⚠️ 이 광고가 참조하는 소재는 `~/hmb-submit/seq/**`(20시퀀스 1540장 250MB) 중 **일부**다.
   * "전부 복사"로 되돌리는 회귀를 크기로 문다 — 137장 4.19MB 가 실측이고 상한은 그 위 여유.
   */
  it("반입 규모가 예산 안이다", () => {
    const bytes = onDisk.reduce((s, f) => s + statSync(join(SPLASH_DIR, f)).size, 0);
    expect(onDisk.length).toBe(137);
    expect(bytes).toBeLessThan(6 * 1024 * 1024);
  });

  /**
   * ⚠️ **플레이어의 합성 레이어가 이 디렉토리명에 의존한다.** `ad-show.ts` 의 `paintSayCard` 는
   * pane 이미지의 `src` 문자열에 `say-captain` 이 들어 있는지로 게이트한다(원본 주석: 시각으로
   * 게이트하면 컷 경계 한 프레임에 판때기가 피치 위 엉뚱한 자리로 찍힌다). 반입 경로를
   * 예쁘게 고치는 리팩터가 그 게이트를 조용히 영구 false 로 만든다 = 지시② 문구가 안 나온다.
   */
  it("지시② 정지컷 경로에 'say-captain' 이 남아 있다", () => {
    expect(referenced.filter((f) => f.includes("say-captain"))).toEqual(["seq/say-captain/f-016.webp"]);
  });

  it("총 재생 길이가 동결본과 같다 (15.0s)", () => {
    expect(AD_TOTAL_SEC).toBe(15);
  });
});
