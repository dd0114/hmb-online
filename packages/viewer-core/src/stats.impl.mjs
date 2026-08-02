// stats.mjs — 뷰어 실시간 통계(F1, #100). 순수 함수(DOM 무관), vitest 검증. 뷰어가 인라인 사용.
// "현재 틱까지"의 누적 스탯을 계산해 HUD 가 재생 중 실시간 갱신하게 한다. match-stats.ts(종료후 일괄,
// TS)와 별개로, 뷰어에서 매 프레임 싸게 부를 수 있는 증분 계산을 제공한다(계약은 동일 정의).

import { ownerSideOf } from "./owner-side.mjs";

/**
 * @typedef {{shots:number, onTarget:number, goals:number, offTarget:number, saves:number, xg:number,
 *   passCompleted:number, passAttempts:number, passPct:number, corners:number, fouls:number,
 *   offsides:number, yellow:number, red:number}} TeamLiveStats
 */

/** 빈 팀 스탯. @returns {TeamLiveStats} */
function empty() {
  return {
    shots: 0, onTarget: 0, goals: 0, offTarget: 0, saves: 0, xg: 0,
    passCompleted: 0, passAttempts: 0, passPct: 0,
    corners: 0, fouls: 0, offsides: 0, yellow: 0, red: 0,
  };
}

/**
 * 이벤트 시계열에서 uptoTick(포함)까지의 누적 팀 스탯. match-stats.ts 정의와 일치:
 * shots=슛시도(결과마커 saved/off_target 제외), onTarget=goals+savedShots, xg=시도 xg 합,
 * passAttempts=완성+상대인터셉트+상대스로인, saves=GK 선방(수비팀).
 * @returns {{home:TeamLiveStats, away:TeamLiveStats}}
 */
export function liveEventStats(events, uptoTick) {
  const home = empty(), away = empty();
  const S = (side) => (side === "home" ? home : away);
  const opp = (side) => (side === "home" ? "away" : "home");
  for (const e of events) {
    if (e.tick > uptoTick) continue;
    const side = e.team;
    switch (e.type) {
      case "shot":
        if (!side) break;
        if (e.detail === "saved") { S(side).onTarget++; /* savedShot: 유효슛 */ }
        else if (e.detail === "off_target") { S(side).offTarget++; }
        else { S(side).shots++; if (typeof e.xg === "number") S(side).xg += e.xg; }
        break;
      case "goal":
        if (side) { S(side).goals++; S(side).onTarget++; }
        break;
      case "save":
        if (side) S(side).saves++;
        break;
      case "pass":
        if (side) { S(side).passCompleted++; S(side).passAttempts++; }
        break;
      case "interception":
        // 가로챔 = 상대 패스 실패 → 상대 passAttempts++.
        if (side) S(opp(side)).passAttempts++;
        break;
      // ⚠️ `clearance` 는 **의도적으로 어느 항목에도 안 센다**(#406 W5 에서 재확인).
      //  ① 패스로 세면 안 된다 — 엔진이 별도 타입으로 뺀 이유가 정확히 "패스 성공률 캘리브레이션
      //     오염 방지"다(shared `MatchEventType` 주석). 지금 default 로 떨어지는 게 맞는 동작이다.
      //  ② 새 항목(`clearances`)을 만들려면 이 함수의 짝인 `packages/engine/dev-viewer/match-stats.ts`
      //     (종료 후 일괄 집계)와 HUD 그리드를 그리는 **호스트 둘**(dev-viewer 셸 · apps/web)을 같이
      //     고쳐야 한다. 셋 다 이 모듈 밖이라 여기만 늘리면 두 정의가 조용히 갈라진다(머리말 규율).
      //  요구 4-2(행동 가시화)는 캔버스 축이라 HUD 항목을 요구하지 않는다 — 필요해지면 별도 이슈.
      case "kickoff":
        if (e.detail === "corner" && side) S(side).corners++;
        else if (e.detail === "throw_in" && side) S(opp(side)).passAttempts++; // 상대 스로인 = 내 패스 아웃
        break;
      case "foul":
        if (side) S(side).fouls++;
        break;
      case "offside":
        if (side) S(side).offsides++;
        break;
      case "card":
        if (side) { if (e.detail === "red") S(side).red++; else S(side).yellow++; }
        break;
      default:
        break;
    }
  }
  for (const t of [home, away]) t.passPct = t.passAttempts > 0 ? Math.round((t.passCompleted / t.passAttempts) * 100) : 0;
  return { home, away };
}

/**
 * 스냅샷별 누적 점유(ballOwner) 카운트. cumHome[i]/cumAway[i] = 0..i 틱 중 소유 틱 수.
 * @returns {{cumHome:number[], cumAway:number[]}}
 */
export function computeCumulativePossession(snaps) {
  const cumHome = new Array(snaps.length), cumAway = new Array(snaps.length);
  let h = 0, a = 0;
  for (let i = 0; i < snaps.length; i++) {
    // #324: 종전엔 `ballOwner[0] === "H"` 로 팀을 추측해 **실경기 id(P077)가 전부 away** 로 집계됐다
    // (라이브 실측 home 0 : away 2219 → 화면 점유율 home 0%). 소유팀은 스냅샷에서 찾는다.
    const side = ownerSideOf(snaps[i]);
    if (side === "home") h++; else if (side === "away") a++;
    cumHome[i] = h; cumAway[i] = a;
  }
  return { cumHome, cumAway };
}

/** idx 까지의 홈 점유율(%). 무소유 틱 제외. 소유 없으면 50. */
export function possessionPct(cumHome, cumAway, idx) {
  const h = cumHome[idx] || 0, a = cumAway[idx] || 0;
  const tot = h + a;
  return tot > 0 ? Math.round((h / tot) * 100) : 50;
}

/**
 * 최근 window 스냅샷의 점유 차 기반 모멘텀(−1..1, 홈 양수). 소유 없으면 0.
 * (고급 모멘텀=슛/xG 가중은 다음 단계.)
 */
export function momentum(cumHome, cumAway, idx, window = 30) {
  const lo = Math.max(0, idx - window);
  const dh = (cumHome[idx] || 0) - (cumHome[lo] || 0);
  const da = (cumAway[idx] || 0) - (cumAway[lo] || 0);
  const tot = dh + da;
  return tot > 0 ? (dh - da) / tot : 0;
}
