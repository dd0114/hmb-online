import { test, expect } from "@playwright/test";
import { loadViewer, eventsOfType, ballAtTick, ballOwnerAtTick, outsideGoalLine, inGoalMouth, VIEWER_REAL_URL } from "./fixture";

// 슛 결과 공 위치 의미론: 결과 타입별로 공이 서로 다른 곳에 있어 관객이 구분 가능한가.
test.beforeEach(async ({ page }) => { await loadViewer(page); });

test("off_target → 공이 골라인 밖으로 벗어난다(옆/뒤)", async ({ page }) => {
  // 쇼케이스 시드엔 off_target 이 없을 수 있어 real config 픽스처(off_target 다수)로 검증.
  await loadViewer(page, VIEWER_REAL_URL);
  const offs = await eventsOfType(page, "shot", "off_target");
  expect(offs.length).toBeGreaterThan(0);
  for (const o of offs) {
    // 빗맞은 슛은 다음 틱에 골라인 너머로 흘러 벗어나 보인다(overrunX).
    const ball = (await ballAtTick(page, o.tick + 1)) ?? (await ballAtTick(page, o.tick));
    expect(
      outsideGoalLine(ball),
      `off_target t${o.tick} 공(${ball.x.toFixed(1)},${ball.y.toFixed(1)}) 이 골라인 안 → 벗어남 안 보임`
    ).toBe(true);
    expect(inGoalMouth(ball)).toBe(false);
  }
});

test("#91 save→corner → 공이 골라인 밖 와이드로 나간다(키퍼에 안 멈춤, 골 오인 없음)", async ({ page }) => {
  // ── 왜 쇼케이스가 아니라 real 픽스처인가 (#182, gameqa 승인) ────────────────────────
  // 이 계약의 본질은 "**굴절 세이브는 골문 밖 와이드로 라이브아웃**"이라는 엔진 의미론이다.
  // 쇼케이스 시드에 그 사례가 들어있냐는 부수 사정이고, 실제로 #182(코너 rest defence)로 데모
  // 매치 전개가 바뀌며 쇼케이스의 판정대상 굴절 save→corner 가 **2건 → 0건**이 됐다
  // (쇼케이스 세이브 자체가 1건뿐이고 그마저 캐치). 그래서 real config 픽스처로 옮긴다 —
  // 바로 위 off_target, 아래 penalty 테스트와 **같은 이유·같은 방식**.
  //
  // ⚠️ 오해 방지: 이건 "굴절 세이브가 줄었다"는 뜻이 **아니다**. 같은 real 픽스처에서 판정대상이
  // main 4건 → 이 브랜치 6건으로 오히려 늘었다 = 쇼케이스 시드 노이즈일 뿐 엔진 회귀가 아니다.
  // (#91 로직 소재인 contest.ts 는 main..HEAD 무변경.)
  //
  // 커버리지(반쪽 계약 아님을 확인): real 6건 = 세이브팀 home 4 / away 2, 골문도 좌(away) 4 /
  // 우(home) 2 로 **양팀·양쪽 골문 모두** 포함한다.
  await loadViewer(page, VIEWER_REAL_URL);
  const saves = await eventsOfType(page, "save");
  const corners = await eventsOfType(page, "kickoff", "corner");
  let checked = 0;
  for (const s of saves) {
    // #91 굴절 세이브만 판정한다(캐치 제외). 굴절은 공을 라인 밖에 **소유자 없이**(parkForRestart)
    // 세워 shot_out→코너로 이어진다. 캐치(giveBallTo)는 키퍼가 공을 **소유**하므로 여기서 배제한다.
    // (구: `c.team !== s.team` 로 캐치를 걸렀는데, 이는 #110 스퓨리어스 반대편 코너 버그에 의존한
    //  프록시였다. 버그 수정 후 캐치→상대 코너(정상)가 되어 프록시가 깨지므로, 소유자로 직접 구분.)
    const owner = await ballOwnerAtTick(page, s.tick);
    if (owner) continue; // 키퍼가 공 소유 = 캐치 → #91 대상 아님.
    const corner = corners.find((c) => c.tick > s.tick && c.tick <= s.tick + 8 && c.team !== s.team);
    if (!corner) continue;
    const ball = await ballAtTick(page, s.tick);
    if (!ball) continue;
    // 공이 골라인 밖으로 나감(키퍼 앞에 잡혀 멈추지 않음) = off_target 처럼 라이브로 나가는 게 보임.
    expect(outsideGoalLine(ball), `save→corner t${s.tick}: 공이 골라인 밖으로 나가야 (${ball.x.toFixed(1)},${ball.y.toFixed(1)})`).toBe(true);
    // 골문 안(포스트 사이)이 아님 = 와이드 굴절 → 골 오인 없음(V2 #15 보존).
    expect(inGoalMouth(ball), `save→corner t${s.tick}: 공이 골문 안이면 골 오인 (${ball.x.toFixed(1)},${ball.y.toFixed(1)})`).toBe(false);
    checked++;
  }
  expect(checked, "판정 가능한 save→corner 없음").toBeGreaterThan(0);
});

// #316(engine@0.26.0+): **되살렸다.** 0.24.0 에서 기본 코어가 chain 으로 바뀌며 이 이벤트가
// 0건이 됐던 이유는 판정이 `decision.ts:decideBallOwner`(weighted) 안에만 있었고 `chain.ts` 의
// shoot 반환에 `detail` 이 없었기 때문이다(= 값 문제가 아니라 코드가 없었다).
// 이제 판정 본체는 `decision.oneOnOneShot` 으로 추출돼 **두 코어가 같은 함수**를 쓰고, chain 은
// 그것을 **루트(실제 슈터 자리)에서만** 불러 결과 xg + detail 에 싣는다(가상 도착 지점에서 재면
// "상대가 그때까지 안 움직인다"는 가정이 EV 에 심긴다).
// ⚠️ `contest.oneOnOneShootBias`(슛 **가중치** 배수)는 의도적으로 이식하지 않았다 — EV 공간에
// 대응물이 없고 넣으면 슛 볼륨 레버가 `chain.goalValue` 와 이중이 된다. 그래서 발생 빈도는
// weighted 시절보다 낮다(60시드 4건). 이 계약은 **경로 생존**을 본다(정밀 판정은
// `packages/engine/src/realism/one-on-one.test.ts`).
test("one_on_one → 슛 이벤트로 발행되고 팀이 명시된다", async ({ page }) => {
  const one = await eventsOfType(page, "shot", "one_on_one");
  expect(one.length).toBeGreaterThan(0);
  for (const e of one) expect(e.team === "home" || e.team === "away").toBe(true);
});

test("penalty → PK 판정 + PK 슛(shot:penalty) 발행 (real 뷰어: PK 포함 시드)", async ({ page }) => {
  // 쇼케이스 시드엔 PK 가 없을 수 있어 real config 픽스처(PK 포함)로 검증.
  await loadViewer(page, VIEWER_REAL_URL);
  const award = await eventsOfType(page, "penalty");
  const pk = await eventsOfType(page, "shot", "penalty");
  expect(award.length).toBeGreaterThan(0);
  expect(pk.length).toBeGreaterThan(0);
});
