import { describe, expect, it } from "vitest";
import {
  DEFAULT_RADAR_POSITION,
  REDUCED_NOTE,
  attributeViewOf,
  resolveRadarPosition,
} from "./attribute-view";
import { RADAR_GROUPS_BY_POSITION, STAT_LABELS } from "./growth-config";

/**
 * 능력치 뷰모델 계약 (#403 W3).
 *
 * ⚠️ **이 영역엔 유닛 계약이 없었다** — `CardGrowthDetail` 은 e2e(`growth-mock` G4)로만 지켜졌다.
 * 추출하면서 유닛을 세운다: 두 모드의 갈림과 "없는 것을 없다고 말하는가"는 브라우저 없이
 * 죽일 수 있는 성질이고, e2e 는 그 경계를 표본 하나로만 지나간다.
 *
 * ⚠️ 계약은 **값 리터럴이 아니라 관계식**으로 건다(밴드·계수는 무배포 조정 대상이다, §2.8).
 */

const ATTRS = {
  shooting: 55, pace: 60, positioning: 45, technical: 44, passing: 42,
  stamina: 43, physical: 40, mental: 41, tackling: 30,
};
const CAPS = {
  shooting: 80, pace: 82, positioning: 71, technical: 70, passing: 69,
  stamina: 66, physical: 65, mental: 68, tackling: 55,
};

const FULL = {
  attributes: ATTRS,
  base: ATTRS,
  caps: CAPS,
  statAdd: { shooting: 2.5 },
  startLo: 50,
  growCeil: 72,
  starCeilBonus: 1,
  star: 2,
};

describe("모드 갈림 — full 은 내 카드, reduced 는 남의 카드", () => {
  it("base + caps 가 오면 full — 3층·천장·레이더 캡이 전부 선다", () => {
    const v = attributeViewOf("FW", FULL)!;
    expect(v.mode).toBe("full");
    expect(v.ceilingLabel).not.toBeNull();
    for (const row of v.rows) {
      expect(row.base, `${row.key} base`).not.toBeNull();
      expect(row.cap, `${row.key} cap`).not.toBeNull();
      expect(row.grown, `${row.key} grown`).not.toBeNull();
      expect(row.add, `${row.key} add`).not.toBeNull();
    }
    // 레이더 캡 폴리곤은 **전 축이 cap 을 가질 때만** 그려진다(StatRadar 규약).
    expect(v.radarAxes.every((a) => typeof a.cap === "number")).toBe(true);
    expect(v.chips.every((c) => c.cap != null)).toBe(true);
    expect(v.note).toBeNull();
  });

  /**
   * 🚨 **없는 층을 0 으로 그리지 않는다.** "성장분 0"은 모르는 것을 아는 척하는 거짓이다 —
   * 여기서 `0` 을 허용하는 순간 상대 카드가 "한 번도 안 큰 카드"로 화면에서 단언된다.
   */
  it("attributes 만 오면 reduced — 없는 층이 전부 null 이다(0 이 아니다)", () => {
    const v = attributeViewOf("FW", { attributes: ATTRS })!;
    expect(v.mode).toBe("reduced");
    for (const row of v.rows) {
      expect(row.base, `${row.key} base`).toBeNull();
      expect(row.cap, `${row.key} cap`).toBeNull();
      expect(row.grown, `${row.key} grown`).toBeNull();
      expect(row.add, `${row.key} add`).toBeNull();
      // 값 자체는 그대로 보인다 — 가리는 것은 **진행도**지 능력치가 아니다(결정 ③).
      expect(row.value).toBe(ATTRS[row.key as keyof typeof ATTRS]);
    }
    expect(v.radarAxes.some((a) => a.cap !== undefined)).toBe(false);
    expect(v.chips.every((c) => c.cap === null)).toBe(true);
    expect(v.ceilingLabel).toBeNull();
  });

  it("reduced 는 무엇이 빠졌는지 **말한다** — 조용히 비우지 않는다", () => {
    const v = attributeViewOf("FW", { attributes: ATTRS })!;
    expect(v.note).toBe(REDUCED_NOTE);
    // 문구는 바뀔 수 있지만 "카탈로그 기본치"라는 사실은 남아야 한다 — 그게 이 줄의 존재 이유다.
    expect(v.note).toContain("기본치");
  });

  it("caps 만 있고 base 가 없으면(부분 응답) reduced 로 떨어진다 — 반쪽 3층을 그리지 않는다", () => {
    const v = attributeViewOf("FW", { attributes: ATTRS, caps: CAPS })!;
    expect(v.mode).toBe("reduced");
    expect(v.rows.every((r) => r.cap === null)).toBe(true);
  });
});

describe("축 — 두 모드가 다른 원점을 쓴다", () => {
  it("full 의 원점은 서버 startLo, 상단은 caps 최대", () => {
    const v = attributeViewOf("FW", FULL)!;
    expect(v.axis.lo).toBe(FULL.startLo);
    expect(v.axis.hi).toBe(Math.max(...Object.values(CAPS)));
    expect(v.axis.exact).toBe(true);
  });

  it("reduced 는 재료가 없으니 0–100 으로 눕는다 — 근사 앵커를 지어내지 않는다", () => {
    const v = attributeViewOf("FW", { attributes: ATTRS })!;
    expect(v.axis).toMatchObject({ lo: 0, hi: 100 });
    expect(v.axis.exact).toBe(false);
  });
});

describe("성장분 — 천장이 자른다", () => {
  it("grown = min(cap, base + add) — base ≤ grown ≤ cap 이 항상 성립한다", () => {
    const v = attributeViewOf("FW", {
      ...FULL,
      // 천장을 훌쩍 넘는 성장분: 잘려야 한다(서버가 caps 로 자르는 것과 같은 규칙).
      statAdd: { shooting: 999, passing: 1 },
    })!;
    for (const row of v.rows) {
      expect(row.grown!).toBeGreaterThanOrEqual(row.base!);
      expect(row.grown!).toBeLessThanOrEqual(row.cap!);
    }
    const shooting = v.rows.find((r) => r.key === "shooting")!;
    expect(shooting.grown).toBe(shooting.cap);
  });

  /**
   * ⚠️ full 에서 `statAdd` 부재는 **0** 이다(서버가 아직 안 고른 카드에 그 키를 안 실을 수 있고,
   * 강화탭 계약이 `data-add="0.00"` 을 박고 있다). reduced 의 `null`(모른다)과 **다른 상태**다 —
   * 두 상태를 같은 값으로 눕히면 상대 카드가 "0 만큼 컸다"로 읽힌다.
   */
  it("full + statAdd 부재 = 0 / reduced = null — 두 상태가 구분된다", () => {
    const noAdd = attributeViewOf("FW", { ...FULL, statAdd: undefined })!;
    expect(noAdd.rows.every((r) => r.add === 0)).toBe(true);
    const reduced = attributeViewOf("FW", { attributes: ATTRS })!;
    expect(reduced.rows.every((r) => r.add === null)).toBe(true);
  });
});

describe("천장 라벨 — 덧셈이 성립할 때만 분해한다", () => {
  it("growCeil + 보너스 = 천장이면 분해해서 말한다", () => {
    const caps = Object.fromEntries(Object.keys(CAPS).map((k) => [k, 73]));
    const v = attributeViewOf("FW", { ...FULL, caps, growCeil: 72, starCeilBonus: 1, star: 2 })!;
    expect(v.ceilingLabel).toContain("73");
    expect(v.ceilingLabel).toContain("72");
    expect(v.ceilingLabel).toContain("★2");
  });

  /** 하드캡에 걸려 합이 잘렸으면 `72 + 3 = 74` 는 **틀린 식**이다 → 합계만 말한다. */
  it("덧셈이 성립하지 않으면 합계만 — 틀린 식을 그리지 않는다", () => {
    const v = attributeViewOf("FW", FULL)!; // caps 최대 82 ≠ 72 + 1
    expect(v.ceilingLabel).toBe("천장 82");
    expect(v.ceilingLabel).not.toContain("+");
  });

  it("서버가 분해를 안 주면(구 서버) 합계만 — 클라가 밴드를 미러해 재구성하지 않는다", () => {
    const v = attributeViewOf("FW", { ...FULL, growCeil: undefined, starCeilBonus: undefined })!;
    expect(v.ceilingLabel).toBe("천장 82");
  });
});

describe("응답 형태를 믿지 않는다", () => {
  it.each([
    ["없음", undefined],
    ["null", null],
    ["빈 객체", { attributes: {} }],
    ["수치가 아님", { attributes: { shooting: "55", pace: null } }],
  ])("attributes 가 %s 이면 뷰가 없다(null) — 빈 막대 아홉 줄을 그리지 않는다", (_label, src) => {
    expect(attributeViewOf("FW", src as never)).toBeNull();
  });

  it("카드가 손상돼도 나머지 필드로 억지 full 을 만들지 않는다", () => {
    // 능력치가 없으면 base/caps 가 아무리 멀쩡해도 그릴 것이 없다.
    expect(attributeViewOf("FW", { base: ATTRS, caps: CAPS, startLo: 50 })).toBeNull();
  });
});

describe("포지션 — 6축 구성이 갈린다", () => {
  it("GK 는 다른 6축을 쓴다(hero 2026-07-26)", () => {
    const gk = attributeViewOf("GK", FULL)!;
    const fw = attributeViewOf("FW", FULL)!;
    expect(gk.radarAxes.map((a) => a.key)).not.toEqual(fw.radarAxes.map((a) => a.key));
    expect(gk.radarAxes[0]!.label).toBe(RADAR_GROUPS_BY_POSITION.GK[0]!.label);
  });

  it("포지션 미상이면 기본 축으로 떨어진다 — 틀린 포지션을 지어내지 않는다", () => {
    expect(resolveRadarPosition(null)).toBe(DEFAULT_RADAR_POSITION);
    expect(resolveRadarPosition("ST")).toBe(DEFAULT_RADAR_POSITION);
    expect(resolveRadarPosition("GK")).toBe("GK");
    const v = attributeViewOf(null, { attributes: ATTRS })!;
    expect(v.radarAxes.map((a) => a.key)).toEqual(
      RADAR_GROUPS_BY_POSITION[DEFAULT_RADAR_POSITION].map((g) => g.key),
    );
  });

  it("막대는 포지션과 무관하게 9종 전부·같은 순서다(강화탭과 모달이 같은 표를 본다)", () => {
    const fw = attributeViewOf("FW", FULL)!;
    const gk = attributeViewOf("GK", { attributes: ATTRS })!;
    const keys = STAT_LABELS.map(([k]) => k);
    expect(fw.rows.map((r) => r.key)).toEqual(keys);
    expect(gk.rows.map((r) => r.key)).toEqual(keys);
  });
});
