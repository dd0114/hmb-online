import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { REALISM_SEEDS } from "./harness";
import {
  collectRestart,
  formatRestart,
  nonKickDecisions,
  restartCount,
  RESTART_KINDS,
} from "./restart";

/**
 * #349 — **모든 재시작의 첫 행동은 킥이다** (IFAB Law 8/13/15/16).
 *
 * hero 라이브 제보: *"51' Foul #4 — 프리킥을 안 차고 선수가 드리블해."*
 * 재관전(2026-08-01, 쇼케이스): *"프리킥 룰을 모르는 거 같아. 계속 드리블을 해."*
 *
 * 원인(#349 코멘트 측정): 사슬 코어(0.24.0~)의 후보 생성기가 `state.setPiece` 를 **보지 않는다**.
 * 재시작 틱에도 `carry`/`hold` 후보가 그대로 생성돼 EV 가 이기면 드리블로 재개된다
 * (실측 재시작 첫 행동의 47.6%, #358 파울 복구 후 경기당 19.6회 노출).
 *
 * ## 계약을 절대 임계로 거는 이유
 * 밸런스 지표가 아니라 **규칙**이다. "드리블 비율이 낮아졌다"는 통과 기준이 될 수 없다 —
 * Law 13 은 taker 가 공을 **차야** 하고 다른 선수가 닿기 전엔 다시 못 만진다고 말한다.
 * 그래서 임계는 0 이고, 시드 수만 늘려도 0 이어야 한다.
 *
 * ## 데드락 안전
 * "드리블 금지"만 걸면 `hold` 가 EV 로 이겨 재시작이 영원히 안 나가는 데드락(#231 계열)이 된다.
 * 그래서 hold 도 같이 막고, 킥 후보가 하나도 없을 때를 위한 **폴백 킥**을 둔다.
 * 아래 "재개가 실제로 일어난다" 계약이 그 데드락을 잡는다.
 */

const seeds20 = REALISM_SEEDS;

/** #349 이전 동작(롤백 스위치) — 변이체 킬 대조군. */
const legacyCfg = (): EngineConfig => ({
  ...defaultEngineConfig,
  rules: {
    ...defaultEngineConfig.rules,
    restart: { ...defaultEngineConfig.rules.restart, mustKick: false },
  },
});

/** 20시드 수집은 한 번만 한다(두 describe 가 같은 표본을 읽는다 — T0 예산). */
const r = collectRestart(defaultEngineConfig, seeds20);

describe("#349 재시작 첫 행동 = 킥", () => {
  it("재시작 창에서 드리블·홀드 결정이 0 건이다 (Law 8/13/15/16)", () => {
    // eslint-disable-next-line no-console
    console.log("\n" + formatRestart("#349 재시작 (기본 config, 20시드)", r) + "\n");
    const nk = nonKickDecisions(r);
    expect(nk.dribble).toBe(0);
    expect(nk.hold).toBe(0);
  });

  it("재개는 실제로 일어난다 — 데드락 없음(경기당 재시작 ≥ 5건, 종류 ≥ 3)", () => {
    const n = restartCount(r);
    expect(n / r.matches).toBeGreaterThanOrEqual(5);
    const kinds = RESTART_KINDS.filter((k) =>
      (["shoot", "pass", "dribble", "clearance", "hold"] as const).some((d) => r.first[k][d] > 0),
    );
    expect(kinds.length).toBeGreaterThanOrEqual(3);
  });

  it("변이체 킬 — mustKick 을 끄면 드리블 재개가 되살아난다", () => {
    const legacy = collectRestart(legacyCfg(), seeds20);
    const nk = nonKickDecisions(legacy);
    // 대조군은 "구 동작"이므로 반드시 드리블이 나온다. 안 나오면 이 계약은 아무것도 안 잡는 것이다.
    expect(nk.dribble).toBeGreaterThan(0);
  }, 600_000);
});

describe("#349 프리킥 벽 — 위협거리 매핑대로 실제 발화한다", () => {
  it("매핑이 벽을 요구한 프리킥에서 벽이 배정된다(want>0 인데 배정 0 = 0건)", () => {
    expect(r.wall.n).toBeGreaterThan(0);
    expect(r.wall.wantedButNone).toBe(0);
  });

  it("배정된 벽이 차는 틱에 실제로 그 자리에 서 있다(도착률 ≥ 70%)", () => {
    expect(r.wall.placedSum).toBeGreaterThan(0);
    expect(r.wall.standingSum / r.wall.placedSum).toBeGreaterThanOrEqual(0.7);
  });

  it("벽 슬롯이 9.15m 를 침범하지 않는다 (Law 13)", () => {
    expect(r.wallEncroach).toBe(0);
  });

  it("공격팀 백업이 벽에서 1m 밖이다 (Law 13 — 벽 3명 이상일 때)", () => {
    // 조사(#378 W0)에서 나온 규칙 결손: 백업 반경 8m 와 벽 거리 9.5m 가 1m 남짓이라 겹칠 수 있다.
    // 어기면 실축에선 **수비팀 간접 프리킥**이다. 슬롯 단계에서 구조적으로 막는다.
    expect(r.wallBackupTooClose).toBe(0);
  });

  it("변이체 킬 — routeAroundZone 을 끄면 벽 도착률이 무너진다(롤백 스위치가 실재한다)", () => {
    // ⚠️ 독립검증 B1: 이 계약이 없어서 `routeAroundZone` 이 **선언만 되고 아무도 안 읽는**
    // 상태로 통과했다(값을 false 로 바꿔도 7/7 green). 노브가 있다고 쓰면 노브가 있어야 한다.
    const off = collectRestart(
      {
        ...defaultEngineConfig,
        setPiece: {
          ...defaultEngineConfig.setPiece,
          freeKick: { ...defaultEngineConfig.setPiece.freeKick, routeAroundZone: false },
        },
      },
      seeds20,
    );
    expect(off.wall.placedSum).toBeGreaterThan(0);
    const offRate = off.wall.standingSum / off.wall.placedSum;
    const onRate = r.wall.standingSum / r.wall.placedSum;
    expect(offRate, `off ${offRate.toFixed(3)} vs on ${onRate.toFixed(3)}`).toBeLessThan(onRate / 2);
  }, 600_000);

  it("역할의 팀 축이 맞다 — 벽=수비팀 · 백업=공격팀, 오배정 0", () => {
    expect(r.axis.wallDef).toBeGreaterThan(0);
    expect(r.axis.backupAtt).toBeGreaterThan(0);
    expect(r.axis.wallWrong).toBe(0);
    expect(r.axis.backupWrong).toBe(0);
  });
});
