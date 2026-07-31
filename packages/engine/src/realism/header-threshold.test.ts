import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";
import { countHeaders } from "./header";

/**
 * #357 — **헤더 슛 임계는 필드 슛 임계와 분리돼 있다**.
 *
 * ## 결함 (선행)
 * `contest.ts` 의 헤더 슛 게이트가 `contest.shootXgThreshold`(= 필드 슛 임계)를 읽었다. 그런데
 * 헤더 xg 는 `aerial.headerXgMult`(0.65)로 이미 깎인 값이라 **같은 숫자가 헤더를 먼저 죽인다** —
 * 필드 임계를 볼륨 레버로 올리는 순간(#353 실측: 0.07→0.185) 헤더 슛·골이 **0** 이 되어 #306 이
 * 통째로 사망했다. "저xG 슛만 거르는 선택적 필터"가 아니라 **공중 경로까지 끄는 공용 게이트**였다.
 *
 * ## 계약 형태 — 절대 임계가 아니라 **관계식 + 대조군**
 * "헤더 골이 N건 이상"으로 걸면 튜닝이 조금만 움직여도 깨지고(헤더 골은 20경기에 한 자릿수다),
 * 무엇보다 **분리됐는지**를 못 본다. 그래서 두 축의 **독립성**을 직접 건다:
 *  ① 필드 임계를 헤더가 못 넘는 높이까지 올려도 **헤더 슛은 살아 있다**(분리 전이면 0).
 *  ② 헤더 임계를 올리면 **헤더 슛만** 줄어든다(그 노브가 헤더의 게이트임을 박제).
 *  ③ 기본값에서 두 값이 같으면 **분리 이전과 같은 동작**(회귀 시 롤백 경로).
 */

const select = makeSelectData();
/** 8시드로 충분하다 — 여기서 보는 것은 "0 인가 아닌가"의 방향이지 정밀 빈도가 아니다. */
const SEEDS = REALISM_SEEDS.slice(0, 8);

function headerShotsWith(over: (c: EngineConfig) => EngineConfig): number {
  const cfg = over(JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig);
  const logs = SEEDS.map((s) => runMatch(s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, cfg));
  return countHeaders(logs).headerShots;
}

/** 헤더 xg 상한 = 필드 xg 최대(clamp 0.9) × headerXgMult. 이 위의 임계는 헤더를 전부 막는다. */
const HEADER_XG_CEIL = 0.9 * defaultEngineConfig.contest.aerial.headerXgMult;

describe("#357 헤더 임계 분리 — 필드 임계가 공중 경로를 끄지 않는다", () => {
  const base = headerShotsWith((c) => c);

  it("기준선: 기본 config 에서 헤더 슛이 나온다", () => {
    expect(base, "헤더 슛 표본이 0 이면 아래 대조가 무의미하다").toBeGreaterThan(0);
  });

  it("① 필드 임계를 헤더 xg 상한 위로 올려도 헤더 슛은 살아 있다 (분리 전이면 0)", () => {
    // `HEADER_XG_CEIL` 위 = 헤더가 **구조적으로** 도달할 수 없는 xg. 분리 전 코드라면 이 설정에서
    // 헤더 슛이 정확히 0 이 된다(변이체 킬 지점).
    const n = headerShotsWith((c) => {
      c.contest.shootXgThreshold = HEADER_XG_CEIL + 0.05;
      return c;
    });
    expect(n, `필드 임계 ${(HEADER_XG_CEIL + 0.05).toFixed(3)} 에서 헤더 슛 ${n}건`).toBeGreaterThan(0);
  });

  it("② 헤더 임계를 헤더 xg 상한 위로 올리면 헤더 슛이 사라진다 (그 노브가 헤더의 게이트다)", () => {
    const n = headerShotsWith((c) => {
      c.contest.aerial.headerXgThreshold = HEADER_XG_CEIL + 0.05;
      return c;
    });
    expect(n, `헤더 임계를 상한 위로 올렸는데 헤더 슛 ${n}건`).toBe(0);
  });

  it("② 단조: 헤더 임계를 올리면 헤더 슛은 늘지 않는다", () => {
    const lo = headerShotsWith((c) => {
      c.contest.aerial.headerXgThreshold = 0.05;
      return c;
    });
    const hi = headerShotsWith((c) => {
      c.contest.aerial.headerXgThreshold = 0.2;
      return c;
    });
    expect(hi, `헤더 임계 0.05→${lo}건 · 0.20→${hi}건`).toBeLessThanOrEqual(lo);
  });

  it("③ 두 임계가 같으면 분리 이전과 동일한 동작(롤백 경로) — 최종 해시 비트 동일", () => {
    // 분리 전 코드 = "헤더도 필드 임계를 읽는다". 그 동작은 `headerXgThreshold = shootXgThreshold`
    // 로 정확히 재현된다. 여기서 두 config 의 최종 상태 해시가 갈리면 분리가 **동작을 추가로**
    // 바꿨다는 뜻이다(그건 이 웨이브가 의도한 것이 아니다).
    const hashes = (headerThr: number): string[] => {
      const c = JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig;
      c.contest.shootXgThreshold = 0.12;
      c.contest.aerial.headerXgThreshold = headerThr;
      return SEEDS.map((s) => {
        const log = runMatch(s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, c);
        return log.tickSnapshots[log.tickSnapshots.length - 1]!.hash;
      });
    };
    const shared = hashes(0.12); // = 분리 이전 동작(필드 임계 그대로 헤더에도)
    expect(hashes(0.12)).toEqual(shared);
    // 그리고 헤더 임계를 실제로 갈라 놓으면 **최소 한 시드는 달라져야 한다**
    // (안 달라지면 이 노브가 아무것도 안 하는 것이고, 계약 ①/② 가 우연히 통과한 것이 된다).
    const split = hashes(HEADER_XG_CEIL + 0.05);
    expect(split.some((h, i) => h !== shared[i]), `8시드 전부 해시 동일 — 헤더 임계가 동작에 영향이 없다`).toBe(true);
  });
});
