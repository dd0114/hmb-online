import { describe, it, expect } from "vitest";
import { runMatch } from "./match";
import { defaultEngineConfig } from "./config";
import { demoSeed, demoHome, demoAway, demoSelect } from "./fixtures";
import type { MatchLog, TickSnapshot } from "@hmb/shared";

/**
 * #48 페널티 스팟 무드리프트 계약: PK 는 페널티 스팟(정중앙)에서 실행돼야 한다.
 * restartPenalty 가 taker.posFx 만 스팟에 고정하고 targetFx 를 오픈플레이 잔여값으로 두면,
 * 세트피스 정지 동안 위치적분 루프(match.ts)가 taker 를 그 targetFx 로 걸어나가게 해 공이
 * 스팟에서 드리프트한다 — 코너/스로인의 #31 과 동일 메커니즘(restartSetPiece 는 targetFx 도
 * 스팟으로 핀). 페널티만 그 라인이 누락됐던 회귀를 박제한다.
 */
const config = defaultEngineConfig;
const CENTER_Y = config.pitch.height / 2; // 34
// default config 에서 페널티가 발생하는 시드(스캔으로 확정). 재현 고정.
// 매치 전개가 바뀔 때마다 재스캔한다: "3"(~0.15.0) → "2"(0.16.0 좌우대칭 픽스) →
// "1"(#182 코너 rest defence) → "5"(#182 리베이스, #181 공 도착/아웃 판정 반영) →
// "3"(#279 사슬 코어) → **"4"**(#307 프리킥 벽/백업 + 데드볼 도착 페이싱 — 데드볼 배치와
// 프리킥 정지 길이가 바뀌며 시드 3 에서 페널티가 소멸).
// 스캔 결과 보유 시드(1~60): 4/6/7/8/9/10/11/12/14/16/18/20/24/25/26/28/29/38/42/45/46/48/
// 49/50/51/54/57/58/59/60. 재스캔은 penalty 이벤트 유무로 훑으면 된다.
//   → **"13"**(engine@0.25.0 볼륨 재보정 — 공 물리 3건 + 데드볼 2건 + config 재보정).
// ⚠️ 재스캔 실측: 1~60 중 penalty 보유 시드가 **13 하나뿐**이다(0.24.0 엔 30개였다). 백업이 없다.
//    원인은 PK 자체가 아니라 그 상류 **파울**이다 — 팀당 11.63 → 5.11 회(벤치 11–12의 절반).
//    0.25.0 에서 공 소유 틱이 46.2%→25.2% 로 줄며 태클 시도가 함께 줄었고, `foul.base` 는
//    태클 시도당 확률이라 자동으로 따라 내려갔다. 파울 복원은 이번 볼륨 재보정 스코프 밖이며,
//    복원되면 이 스캔은 다시 넉넉해진다(같은 사유가 `e2e/gen-fixtures.test.ts` 에도 적혀 있다).
//   → **"8"**(#314 행동·의도 계층 — 걷어내기 신설 + 런 오더 + 수비 블록 추종(`defendCompactX`
//     0.16→0.32)으로 매치 전개가 통째로 바뀌며 시드 13 에서 페널티가 소멸).
//   재스캔 실측(1~60): penalty 보유 시드 **8/9/11/17/22/34/44/46/59/60 = 10개**로 회복했다
//   (0.25.0 엔 13 하나뿐이었다). 블록이 공을 더 따라가며 박스 안 접촉이 늘어 파울이 팀당
//   5.11 → 6.6 으로 돌아온 결과다 — 위 "파울 복원은 스코프 밖" 주석의 부수 효과.
//   → **"1"**(#365 경기 길이 90 → 45분 + engine@0.29.0 파울 복구 리베이스 — 경기가 절반이 되며
//     시드 8 에서 페널티가 소멸). 재스캔 실측(1~60): penalty 보유 시드 **25개**
//     (1/2/9/10/11/12/14/15/16/18/19/20/22/23/28/30/31/35/39/43/45/48/50/52/58) — #358 이 파울을
//     되돌려 놔서, 경기가 반으로 짧아졌는데도 보유 시드는 10개 → 25개로 **오히려 늘었다**.
//   → **34**(#377 M1-pre · engine@0.31.0 — #349 재시작 킥 강제 + #347 킥오프 자기진영 배치로
//     전개가 통째로 바뀌며 시드 1 에서 페널티가 소멸). 재스캔 실측(1~40): penalty 보유 시드
//     **14개**(3·6·9·10·11·16·17·18·21·22·27·31·33·34) — 넉넉하다. 34 는 PK 3건으로 표본 최다.
//   → **21**(#378 M1-본 · 재개 게이트 — 정지 길이가 게이트의 함수가 되며 전개가 바뀌어 시드 34
//     에서 페널티가 소멸). 재스캔(1~40): penalty 보유 시드 14개. 21 = PK 2건 + 8골(표본 넉넉).
//   → **28**(#370 되돌림 `shootXgThreshold` 0.197 → 0.07, 배포 발차 — 볼륨이 크게 움직여
//     시드 21 에서 페널티가 소멸). 재스캔(1~40): PK 보유 시드 5·12·28·35. 28 = 9골 + PK 1건.
//   → **10**(#377 M3-A · #369 예고 패스 — 리시버가 도착 예정 지점으로 먼저 움직이며 전개가
//     바뀌어 시드 28 에서 페널티가 소멸).
//   → **18**(같은 웨이브 1R 수습에서 `pull` 을 0.75 → 0.7 로 내리며 시드 10 에서 소멸).
//     ⚠️ 그때는 1~80 에 보유 시드가 18 하나뿐이라 범위를 1~200 으로 넓혀 뽑았다.
//   → **10** 복귀(#377 M3-A **2R** — `pull` 0.75 로 되돌리며 시드 18 에서 페널티가 소멸.
//     0.75 쪽 전개에서 PK 를 갖던 시드로 되돌아온 것이라 우연이 아니다).
//     재스캔(1~200, 처음부터 넓게): PK 보유 시드 **16개** —
//     10(PK1·골6) · 21(1·8) · 41(1·7) · 54(1·11) · 58(1·7) · 64(1·6) · 74(1·4) · 89(1·8) ·
//     92(1·5) · 121(1·7) · 143(1·9) · 144(1·9) · 157(1·7) · 158(1·5) · 164(1·7) · 178(1·4).
//     ⚠️ 다음 재스캔자도 **1~200** 으로 잡아라. 상류(파울)가 벤치 아래라 PK 적중률이 낮은 것이
//     근본이고(경기당 PK 1건이 상한), 그래서 좁은 범위는 자주 빈다.
//   → **29**(#377 M3-C · 스루패스 공간 타깃 후보 — 후보 공간이 넓어지며 전개가 바뀌어 시드 10
//     에서 페널티가 소멸). 재스캔(1~200): PK 보유 시드 **10개** —
//     29(PK1·골9) · 53(1·9) · 64(1·6) · 69(1·10) · 93(1·5) · 101(1·6) · 107(1·10) · 130(1·6) ·
//     158(1·3) · 198(1·6). 29 는 골 9 로 표본이 넉넉한 쪽이다.
//   → **209**(#377 S3-A · 압박 유닛 — 수비 오프더볼 목표가 또 바뀌며 전개가 달라져 재스캔.
//     1~250 재스캔 후보: 11(PK1·골7) · 83(1·10) · 103(1·5) · 107(1·4) · 109(1·6) · 111(1·5) ·
//     134(1·4) · 183(1·6) · **209(1·12)** · 232(1·5). 209 가 골 12 로 표본이 가장 넉넉하다.
//   (직전) **179**(#377 M3-B · #379 수비 레인 예측 — 수비 오프더볼 목표가 바뀌며 전개가 달라져
//     시드 29 에서 페널티가 소멸). 재스캔(1~200): PK 보유 시드 **8개** —
//     44(PK1·골5) · 51(1·6) · 105(1·6) · 108(1·6) · 157(1·8) · **179(1·11)** · 189(1·4) · 195(1·4).
//     179 는 골 11 로 표본이 가장 넉넉하다.
const PK_SEED = "209";

function snapByTick(log: MatchLog): Map<number, TickSnapshot> {
  return new Map(log.tickSnapshots.map((s) => [s.tick, s]));
}

/**
 * 정지 창을 **같은 하프 안으로 잘라내는** 상한 틱(포함).
 *
 * 왜 필요한가 (engine@0.24.0 사슬 채택에서 처음 걸림): 세트피스가 하프 종료 직전에 선언되면
 * `from + stoppageTicks` 창이 하프 경계를 넘는다. 경계 다음 틱의 공은 **킥오프 리셋으로 중앙
 * (52.5, 34)** 에 있으므로, 스팟 대비 거리가 30m+ 로 찍혀 "드리프트"로 오판된다.
 * 실제로 `free_kick@2693`(STOP=8 → 창 2693..2701)이 t2700 의 하프 휘슬+킥오프를 삼켜
 * 35.8m 를 기록했다 — 공은 2693~2699 내내 (88.3, 33.4) 에 **정확히 정지**해 있었다.
 * 이건 드리프트 회귀가 아니라 **측정 창 버그**다. 창을 하프 안으로 자른다(가드는 그대로 유지).
 */
function halfBoundedEnd(log: MatchLog, from: number, stop: number): number {
  const whistle = log.events.find((e) => e.type === "half_whistle" && e.tick > from);
  const cap = whistle ? whistle.tick - 1 : Number.POSITIVE_INFINITY;
  return Math.min(from + stop, cap);
}


/**
 * 정지 창의 끝 = **공이 실제로 차인 틱**(#378).
 *
 * 구 코드는 창을 `이벤트 틱 + rules.freeKickStoppageTicks`(8) 로 **하드코딩**했다. 그건 "정지는
 * 항상 8틱"이라는 가정인데, #378 이 정지 길이를 게이트의 함수로 만들면서 그 가정이 깨졌다 —
 * 빠른 재개(quick)는 2~3틱이라 그 뒤 구간은 **정지가 아니라 라이브 플레이**이고, 날아가는 공을
 * "드리프트 36m"로 읽는다.
 *
 * 그래서 창을 **관측 신호**로 닫는다: 한 틱 변위가 걷기 속도를 넘으면 그건 걸어서 끌고 간 게
 * 아니라 **찬 것**이다. #48 이 잡으려던 버그(taker 가 공을 발에 붙이고 걸어나감)는 정의상
 * 걷기 속도 이하라 이 창 안에 그대로 남는다.
 */
function kickBoundedEnd(
  log: MatchLog,
  from: number,
  hardCap: number,
  byTick: Map<number, TickSnapshot>,
  walkM: number,
): number {
  const capped = halfBoundedEnd(log, from, hardCap);
  for (let t = from + 1; t <= capped; t++) {
    const a = byTick.get(t - 1);
    const b = byTick.get(t);
    if (!a || !b) continue;
    if (Math.hypot(b.ball.x - a.ball.x, b.ball.y - a.ball.y) > walkM) return t - 1;
  }
  return capped;
}

describe("penalty spot no-drift (#48)", () => {
  it("PK 정지 동안 공이 페널티 스팟에서 드리프트하지 않는다(스팟에서 슛)", () => {
    const log = runMatch(PK_SEED, demoHome, demoAway, demoSelect, config);
    const byTick = snapByTick(log);
    const pens = log.events.filter((e) => e.type === "penalty");
    expect(pens.length, `시드 ${PK_SEED} 에 페널티가 있어야 한다(스캔 확정)`).toBeGreaterThan(0);

    const STOP = config.rules.penalty.stoppageTicks;
    const DRIFT_MAX_M = 2; // 스팟 정착 허용치. 버그 드리프트는 5m+ 라 넉넉히 판별.
    for (const p of pens) {
      const spot = byTick.get(p.tick)!.ball; // 선언 순간 = 페널티 스팟(정중앙).
      // 스팟 자체가 정중앙(y=34)인지 확인.
      expect(
        Math.abs(spot.y - CENTER_Y),
        `penalty@${p.tick} 스팟 y=${spot.y.toFixed(1)} 중앙 아님`,
      ).toBeLessThan(0.5);
      // 선언~슛(정지 종료)까지 공이 스팟에 머무는가.
      let maxDrift = 0;
      let worst = -1;
      const end = kickBoundedEnd(log, p.tick, STOP, byTick, config.rules.deadBall.walkSpeedM);
      for (let t = p.tick; t <= end; t++) {
        const s = byTick.get(t);
        if (!s) continue;
        const d = Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y);
        if (d > maxDrift) {
          maxDrift = d;
          worst = t;
        }
      }
      expect(
        maxDrift <= DRIFT_MAX_M,
        `penalty@${p.tick} 정지 중 공 드리프트 ${maxDrift.toFixed(1)}m (t${worst}) — taker 가 스팟에서 걸어나감`,
      ).toBe(true);
    }
  });

  // 프리킥도 restartSetPiece 를 거치지 않아 같은 targetFx 누락 버그가 있었다(#48 스윕에서 발견,
  // demoSeed free_kick@226 은 수정 전 22m 드리프트). 같은 1줄 수정으로 함께 해소 → 회귀 방지.
  it("free_kick 정지 동안 공이 스팟에서 드리프트하지 않는다", () => {
    const log = runMatch(demoSeed, demoHome, demoAway, demoSelect, config);
    const byTick = snapByTick(log);
    const fks = log.events.filter((e) => e.type === "free_kick");
    expect(fks.length).toBeGreaterThan(0);
    const STOP = config.rules.freeKickStoppageTicks;
    const DRIFT_MAX_M = 3;
    for (const fk of fks) {
      const spot = byTick.get(fk.tick)!.ball;
      let maxDrift = 0;
      let worst = -1;
      const end = kickBoundedEnd(log, fk.tick, STOP, byTick, config.rules.deadBall.walkSpeedM);
      for (let t = fk.tick; t <= end; t++) {
        const s = byTick.get(t);
        if (!s) continue;
        const d = Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y);
        if (d > maxDrift) {
          maxDrift = d;
          worst = t;
        }
      }
      expect(
        maxDrift <= DRIFT_MAX_M,
        `free_kick@${fk.tick} 정지 중 공 드리프트 ${maxDrift.toFixed(1)}m (t${worst})`,
      ).toBe(true);
    }
  });
});
