// playback.mjs — 뷰어 재생 로직(순수 함수, DOM 무관). vitest 로 검증하고 뷰어가 인라인 사용한다.
// 핵심 원칙: "데드볼 재배치"에서만 공 보간을 끊는다. 빠른 슛 궤적은 이벤트로 구분되므로 끊지 않는다.

/** 이벤트 종류 키. kickoff+detail(corner/throw_in/goal_kick), shot+detail(saved/off_target/one_on_one) 를 펼친다. */
import { ownerSideOf } from "./owner-side.mjs";

export function eventKind(e) {
  return e.type === "kickoff" ? (e.detail || "kickoff")
    : e.type === "shot" && e.detail ? "shot_" + e.detail
    : e.type;
}

// 공이 세트피스 스팟으로 "재배치(순간이동)"되는 이벤트들. 이 틱 경계에서만 보간을 컷.
// ⚠️ goal 은 여기 넣지 않는다: 슛 발사→네트로 "날아 들어가는" 마지막 비행 레그를 컷하면
//    공이 안 보이고 순간이동한다(V3 #16). 골 후 네트→센터 리셋은 뒤따르는 kickoff(집합 포함)가 컷하므로 안전.
const REPOSITION = new Set(["corner", "goal_kick", "throw_in", "free_kick", "penalty", "kickoff"]);

/** 데드볼 재배치가 일어나는 틱 집합. */
export function buildRestartTicks(events) {
  const s = new Set();
  for (const e of events) if (REPOSITION.has(eventKind(e))) s.add(e.tick);
  return s;
}

/**
 * 하이라이트(슬로우+줌) 창 판정 — **비대칭**. keyTick(유효슛/골/PK) 앞은 pre 틱(빌드업 기대감),
 * 뒤는 post 틱(클라이맥스 후 빨리 풀림). 대칭(±)이면 슛 이후로도 pre 만큼 슬로우가 이어져
 * 세이브(키퍼 처리) 후 열린 플레이까지 늦게 풀렸다(#83). post<pre 로 뒤를 짧게.
 */
export function inHighlight(tick, keyTicks, pre, post) {
  return keyTicks.some((kt) => tick >= kt - pre && tick <= kt + post);
}

/**
 * 하이라이트 연출(autoPace) 페이싱 상수 — **여기가 SoT**(#216). 렌더 루프(`viewer.impl.mjs`)와
 * 재생 길이 모델(`autoPaceDurationMs`)이 같은 값을 읽어야 "실측 재생 길이에 서버 시계를 맞춘다"가
 * 성립한다. 어느 한쪽에 숫자를 다시 적으면 조용히 갈라진다.
 */
export const PACE = {
  TICKS_PER_SEC: 2, // 배율 1x = 2 게임초/실초
  CRUISE_SPEED: 4, // 빌드업 구간 배속
  HL_SPEED: 1, // 키장면(슛·골·PK) 구간 배속 — 슬로우
  HL_PRE: 8, // #83 하이라이트 창 비대칭(앞)
  HL_POST: 3, //           (뒤 — 짧게 풀림)
  FOUL_HOLD_MS: 1000, // 파울/페널티 정지(줌 완료+충돌 여유)
  DEADBALL_PAUSE_MS: 450, // #59 데드볼 자막 짧은 정지
  SETPIECE_WAIT_TICKS: 32, // #90 세트피스 재시작 대기 판정 창
  SETPIECE_WAIT_RADIUS_M: 3, // 그 창에서 공이 스팟에 머물렀다고 볼 반경
};

/**
 * 이 로그를 **하이라이트 연출로 처음부터 끝까지 재생하면 실시간 몇 ms 걸리는가**(#216 AC2).
 * 렌더 루프와 같은 규칙(크루즈/키장면 배속 + 정지 홀드 + 골 스킵)을 프레임 단위로 적분한다.
 *
 * 이 값이 서버 `hmb.match.clock.half-real-ms` 를 정하는 근거다 — 창이 이보다 짧으면 재생이 끝나기
 * 전에 하프타임이 열리고(구 240s = 실측의 57%), 길면 재생이 먼저 끝나 빈 시간이 생긴다.
 * 순수 함수(DOM·시계 무관)라 스크립트·테스트에서 그대로 돌린다.
 *
 * @param {{tick:number, ball:{x:number,y:number}}[]} snaps tickSnapshots
 * @param {{tick:number,type:string,detail?:string}[]} events
 * @param {number} [speedMul] 배율(라이브 페이스 정합용). 1 = 자연 페이스.
 * @returns {number} 실시간 재생 길이(ms)
 */
export function autoPaceDurationMs(snaps, events, speedMul = 1) {
  if (!Array.isArray(snaps) || snaps.length < 2) return 0;
  const P = PACE;
  const keyTicks = events
    .filter((e) => e.type === "goal" || e.type === "penalty" || (e.type === "shot" && e.detail !== "saved" && e.detail !== "off_target"))
    .map((e) => e.tick);
  const stoppages = buildStoppages(events).map((s) => ({ ...s, done: false }));
  const byTick = new Map(snaps.map((s) => [s.tick, s]));
  const idxOfTick = (t) => { const i = snaps.findIndex((s) => s.tick >= t); return i < 0 ? snaps.length - 1 : i; };
  const inSetpieceWait = (tick) => {
    for (const st of stoppages) {
      if (st.isGoal || !st.setPiece || tick < st.causeTick || tick > st.causeTick + P.SETPIECE_WAIT_TICKS) continue;
      const cs = byTick.get(st.causeTick), now = byTick.get(tick);
      if (cs && now && Math.hypot(now.ball.x - cs.ball.x, now.ball.y - cs.ball.y) < P.SETPIECE_WAIT_RADIUS_M) return true;
    }
    return false;
  };

  const dt = 1 / 60; // rAF 한 프레임(모델 적분 간격)
  let tickPos = 0, realMs = 0, guard = 0;
  while (tickPos < snaps.length - 1 && guard++ < 10_000_000) {
    const before = snaps[Math.min(Math.floor(tickPos), snaps.length - 1)].tick;
    const nearKey = !inSetpieceWait(before) && inHighlight(before, keyTicks, P.HL_PRE, P.HL_POST);
    tickPos += dt * P.TICKS_PER_SEC * effectiveSpeed(true, nearKey, speedMul, P.CRUISE_SPEED, P.HL_SPEED);
    realMs += dt * 1000;
    if (tickPos >= snaps.length - 1) break;
    const after = snaps[Math.min(Math.floor(tickPos), snaps.length - 1)].tick;
    for (const st of stoppages) {
      if (st.done || st.causeTick < before || st.causeTick > after) continue;
      st.done = true;
      realMs += st.isGoal ? st.hold : st.contactAnchor ? P.FOUL_HOLD_MS : P.DEADBALL_PAUSE_MS;
      tickPos = idxOfTick(st.isGoal ? st.restartTick : st.causeTick); // 골만 재시작으로 스킵
      break;
    }
  }
  return Math.round(realMs);
}

/**
 * 프레임당 유효 진행 배속(#216). 연출 페이싱이 도는 동안 `speed` 는 무시되는 값이 아니라
 * **그 위에 곱하는 배율**이다 — 1 = 코어 자연 페이스(크루즈 4x / 키장면 1x).
 *
 * 왜 곱셈인가: 하이라이트를 끄는 것 말고는 재생 속도를 조절할 방법이 없으면, "느리게/빠르게"가
 * 곧 "연출 끄기"가 된다(#216 이 제거하는 그 끔 경로). 배율이면 **슬로우모션 대비를 유지한 채**
 * 전체를 늘이고 줄일 수 있어, 라이브 재생을 서버 시계 창에 맞추는 일이 연출을 희생하지 않는다.
 * `speed=1` 이면 곱해도 같은 값이라 기존 소비자(dev-viewer 기본 1x)는 동작이 바뀌지 않는다.
 *
 * @param {boolean} paced 연출 페이싱이 이 프레임에 적용되는가(= autoPace && !fixMode)
 * @param {boolean} nearKey 키장면 창 안인가
 */
export function effectiveSpeed(paced, nearKey, speed, cruise, hl) {
  return paced ? (nearKey ? hl : cruise) * speed : speed;
}

/**
 * 스냅샷 A(aTick)→B(bTick) 보간 구간에 데드볼 재배치가 있으면 true(그 구간은 컷).
 * 슛 궤적은 재배치 이벤트가 없으므로 거리와 무관하게 false → 부드럽게 보간된다.
 */
export function spansReposition(aTick, bTick, restartTicks) {
  for (let t = aTick + 1; t <= bTick; t++) if (restartTicks.has(t)) return true;
  return false;
}

/**
 * #51 데드볼 재설계(R1): **연속 아웃**(공이 실제로 움직여 라인을 넘어 스팟이 곧 크로싱 지점) 판별.
 * 스로인처럼 직전 인플레이 틱이 움직이는 공이고 스팟이 가까우면 true → 그 구간을 컷하지 않고
 * 라이브로 재생(공이 나가는 걸 실제 보간으로 보여줌). 코너(세이브 park→깃발 순간이동)처럼 직전이
 * 정지 파킹공이거나 스팟이 멀면 false(teleport → 컷 유지).
 */
export function isContinuousOut(snaps, causeTick) {
  const ci = snaps.findIndex((s) => s.tick === causeTick);
  if (ci < 2) return false;
  const p2 = snaps[ci - 2].ball, p1 = snaps[ci - 1].ball, spot = snaps[ci].ball;
  const moving = Math.hypot(p1.x - p2.x, p1.y - p2.y) >= 0.3; // 직전 공이 움직이는 중
  const near = Math.hypot(p1.x - spot.x, p1.y - spot.y) <= 25; // 직전→스팟 근거리(진짜 크로싱)
  return moving && near;
}

/**
 * 공 보간을 컷할 틱 집합(= 순간이동 재배치만). 연속 아웃(스로인 등)은 제외해 공이 라이브로
 * 스팟까지 이동하는 걸 보여준다. 선수(taker)는 restartTicks 로 항상 컷(슬라이드 방지, #26).
 */
export function buildBallCutTicks(events, snaps) {
  const cut = new Set();
  for (const e of events) {
    const k = eventKind(e);
    if (!REPOSITION.has(k)) continue;
    if (k === "throw_in" && isContinuousOut(snaps, e.tick)) continue; // 연속 스로인 → 공 라이브
    cut.add(e.tick);
  }
  return cut;
}

/**
 * R1 정련(#100, hero): 슛/패스 **비행 구간**(공 owner=null)을 발사팀 색으로 칠하기 위한 tick→side 맵.
 * 슛하면 공이 무소유(루즈볼)가 돼 트레일이 중립으로 빠지던 것 방지 — "슛 판정(세이브/골/빗나감)까지
 * 소유권을 슛한 팀으로". 슛 시도(결과마커 saved/off_target 제외)·패스의 발사팀을, 그 이벤트 틱부터
 * 공이 다시 점유될 때까지의 무소유 틱들에 부여한다. 결정론(순수).
 * @returns {Map<number, "home"|"away">}
 */
export function buildFlightSides(events, snaps) {
  const map = new Map();
  const idxByTick = new Map(snaps.map((s, i) => [s.tick, i]));
  const isLaunch = (e) => e.team && (e.type === "pass" || (e.type === "shot" && e.detail !== "saved" && e.detail !== "off_target"));
  for (const e of events) {
    if (!isLaunch(e)) continue;
    const i = idxByTick.get(e.tick);
    if (i == null) continue;
    // 발사 틱부터 앞으로: 무소유 틱은 발사팀으로 마킹. 발사 이후 점유되면(리시버/키퍼) 비행 종료.
    for (let j = i; j < snaps.length && j < i + 24; j++) {
      const o = snaps[j].ballOwner;
      if (o == null) { map.set(snaps[j].tick, e.team); continue; }
      if (j > i) break; // 발사 후 점유 → 비행 끝.
      // j===i 인데 발사자가 아직 명목상 소유 → 마킹 스킵하고 뒤의 무소유(진짜 비행)로 계속.
    }
  }
  return map;
}

/**
 * @typedef {Object} Stoppage
 * @property {number} causeTick
 * @property {number} restartTick
 * @property {string} big
 * @property {string} bigCol
 * @property {number} hold
 * @property {boolean} isGoal
 * @property {boolean} done
 * @property {boolean} [wide]        정지 중 카메라 전체뷰 여부(세트피스로 이어지는 원인 정지).
 * @property {boolean} [setPiece]    코너/스로인 세트피스 정지.
 * @property {boolean} [pauseOnly]   자막 없는 짧은 비트(프리킥 등).
 * @property {string}  [kind]        setPiece 종류(corner/throw_in).
 * @property {string}  [contactAnchor] 파울/페널티: 접촉 지점 줌 앵커(파울러 playerId).
 * @property {string}  [contactAnchorTeam] 그 파울러의 팀 (#324) — playerId 는 양 팀에 중복될 수
 *   있어서(덱·봇이 선수 카탈로그 공유) id 만으로 찾으면 반대편 선수로 줌한다.
 * @property {boolean} [continuous]  연속 아웃 스로인.
 * @property {number}  [formFrom]    골 정지: 포메이션 트윈 시작 idx.
 * @property {number}  [koIdx]       골 정지: 킥오프 idx.
 * @property {number}  [tween]       골 정지: 트윈 진행.
 */
/**
 * 데드볼 정지 시퀀스(원인 → 큰 자막 + freeze → 재시작으로 skip).
 * 골은 isGoal:true(GOAL 자막 + 색종이), 나머지(선방/빗나감/파울/오프사이드/PK)는 isGoal:false(상황 카드).
 * → '선방인데 골처럼' 방지: 골과 상황 자막을 데이터 레벨에서 구분.
 * @returns {Stoppage[]}
 */
export function buildStoppages(events) {
  const CAUSE = {
    save: { big: "🧤 SAVE!", col: "#38bdf8", hold: 1300 },
    shot_off_target: { big: "OFF TARGET!", col: "#94a3b8", hold: 1100 },
    foul: { big: "😠 FOUL!", col: "#fb923c", hold: 1100 },
    offside: { big: "🚩 OFFSIDE!", col: "#f59e0b", hold: 1300 },
    penalty: { big: "⚽ PENALTY!", col: "#22c55e", hold: 1500 },
  };
  const RESTART = new Set(["corner", "goal_kick", "throw_in", "free_kick", "kickoff"]);
  // #42: 원인→재시작 skip 은 그 사이가 데드타임일 때만 유효하다. 세이브 후 공이 라이브인
  // 체인(패스→2차슛→빗나감→골킥)을 스킵하면 라이브 플레이가 통째로 사라지고, 중간 상황자막이
  // 드롭되며, 착지 프레임에 스킵 구간의 토스트/궤적선/선수 잔상이 유령처럼 몰아 나타난다.
  // → 재시작보다 먼저 라이브 액션 이벤트를 만나면 스킵하지 않고 제자리 재개. card 는 북키핑이라 투과.
  const SKIP_TRANSPARENT = new Set(["card"]);
  // #43: 라이브 이벤트가 개입해도 그 직전(LIVE_LEAD 틱 전)까지의 데드타임은 스킵한다.
  // 예: 페널티 선언(163)→PK 킥(171) 사이 준비 데드타임은 건너뛰고 런업(169~)부터 보여줌.
  const LIVE_LEAD = 2;
  const nextRestart = (fromIdx, fromTick, span) => {
    for (let j = fromIdx + 1; j < events.length && events[j].tick <= fromTick + span; j++) {
      const k = eventKind(events[j]);
      if (RESTART.has(k)) return events[j].tick;
      if (!SKIP_TRANSPARENT.has(k)) return Math.max(fromTick, events[j].tick - LIVE_LEAD); // 라이브 직전까지만
    }
    return fromTick + 6;
  };
  // 뒤따르는 재시작 종류(카메라 wide 판단용). 세이브/빗나감/파울 정지가 wide 세트피스로
  // 이어지면 그 정지부터 미리 전체뷰(wide)로 → 세트피스 시작 때 카메라가 이미 와이드라 팬 갭 없음.
  // 라이브 개입으로 스킵이 없으면 wide 미리보기도 하지 않는다(라이브는 통상 팔로우 카메라).
  const WIDE_RESTART = new Set(["corner", "throw_in", "free_kick"]);
  const leadsToWideRestart = (fromIdx, fromTick, span) => {
    for (let j = fromIdx + 1; j < events.length && events[j].tick <= fromTick + span; j++) {
      const k = eventKind(events[j]);
      if (RESTART.has(k)) return WIDE_RESTART.has(k);
      if (!SKIP_TRANSPARENT.has(k)) return false;
    }
    return false;
  };
  // 골 후에는 '킥오프' 이벤트로 skip(포메이션 리셋 지점). 없으면 아무 재시작으로 폴백.
  const nextKickoff = (fromIdx, fromTick, span) => {
    for (let j = fromIdx + 1; j < events.length && events[j].tick <= fromTick + span; j++)
      if (eventKind(events[j]) === "kickoff") return events[j].tick;
    return nextRestart(fromIdx, fromTick, span);
  };
  // 세트피스 큰 자막 정지(#29 hero 요구): 공이 나가면 "코너킥!/스로인!" 크게 띄우고 freeze →
  // 제자리 재개(restartTick=causeTick, 프레임 스킵 없음). setPiece:true → freeze 중 taker(공 소유자)로
  // 줌해 "던지는/차는 선수"를 크게 보여준다(#26 taker 잘림 수정이 전제). hold 는 관전 페이싱 튜닝값 —
  // 스로인은 빈도 높아 짧게. 배너(annotation)는 보조로 병행.
  // #230: 골킥도 데드볼이라 같은 대접을 한다(hero 지시). 이전엔 빈도를 이유로 정지가 아예 없어
  // 골킥만 아무 신호 없이 지나가는 세트피스였다 — 관객은 왜 공이 골문 앞에 놓였는지 모른 채
  // 선수들이 재배치되는 것만 봤다. 빈도 부담(경기당 ~13회)은 정지를 없애는 대신 hold 를
  // 스로인급(650ms)으로 짧게 잡아 흡수한다(코너 900ms 로 하면 경기당 +11초).
  const SETPIECE_STOP = {
    corner: { big: "⛳ CORNER!", col: "#e7edf6", hold: 900 },
    throw_in: { big: "🙌 THROW-IN!", col: "#e7edf6", hold: 650 },
    goal_kick: { big: "🥅 GOAL KICK!", col: "#e7edf6", hold: 650 },
  };
  // 프리킥만 자막 없는 짧은 정지 비트 유지.
  const PAUSE_BEAT = { free_kick: 600 };
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const k = eventKind(events[i]);
    if (k === "goal") {
      // ⚽ 이모지 제거: 화면 중앙 큰 ⚽ 가 '공이 미드필드에 있는 것처럼' 오해를 유발. 텍스트만.
      out.push({ causeTick: events[i].tick, restartTick: nextKickoff(i, events[i].tick, 60), big: "GOAL!", bigCol: "#22c55e", hold: 1700, isGoal: true, done: false });
      continue;
    }
    const c = CAUSE[k];
    if (c) {
      // 파울/페널티 정지는 접촉 지점(파울러)으로 줌해 "두 선수 충돌"을 보여준다(와이드로 작은 점 되던
      // 것 해소). 파울=자기 playerId, 페널티=같은 틱 파울 이벤트의 playerId(페널티 이벤트엔 없음).
      // #324: playerId 는 양 팀에 중복될 수 있다(덱·봇이 선수 카탈로그 공유) → 팀을 같이 싣는다.
      let contactAnchor, contactAnchorTeam;
      if (k === "foul") { contactAnchor = events[i].playerId; contactAnchorTeam = events[i].team; }
      else if (k === "penalty") { const f = events.find((e) => e.tick === events[i].tick && e.type === "foul"); contactAnchor = f && f.playerId; contactAnchorTeam = f && f.team; }
      out.push({ causeTick: events[i].tick, restartTick: nextRestart(i, events[i].tick, 45), big: c.big, bigCol: c.col, hold: c.hold, isGoal: false, wide: leadsToWideRestart(i, events[i].tick, 45), done: false, ...(contactAnchor ? { contactAnchor, contactAnchorTeam } : {}) });
      continue;
    }
    const sp = SETPIECE_STOP[k];
    if (sp) {
      out.push({ causeTick: events[i].tick, restartTick: events[i].tick, big: sp.big, bigCol: sp.col, hold: sp.hold, isGoal: false, setPiece: true, kind: k, done: false });
      continue;
    }
    const beat = PAUSE_BEAT[k];
    if (beat) {
      // pauseOnly: 상황카드 없이 그 틱에서 freeze 후 제자리 재개. 배너(annotation)만 보인다.
      out.push({ causeTick: events[i].tick, restartTick: events[i].tick, big: "", bigCol: "", hold: beat, isGoal: false, pauseOnly: true, done: false });
    }
  }
  // #43: 같은 틱 이중 정지 병합(예: 파울+페널티 같은 틱 → 홀드 2.6s 스태킹).
  // 우선순위 골 > 상황카드 > pauseOnly 비트. 같은 순위면 나중 정지가 이긴다(엔진이 구체
  // 이벤트를 나중에 내보냄: 파울→카드→페널티). 자막 없는 비트(free_kick)가 카드를 지우면 안 된다.
  const rank = (s) => (s.isGoal ? 2 : s.pauseOnly ? 0 : 1);
  const byTick = new Map();
  for (const s of out) {
    const prev = byTick.get(s.causeTick);
    if (!prev || rank(s) >= rank(prev)) byTick.set(s.causeTick, s);
  }
  return out.filter((s) => byTick.get(s.causeTick) === s);
}

// #59: synthOutFlight(아웃비행 합성)·freezeSpanEndIdx(정지 재생) 제거 — 엔진이 taker 걸음/정비를
// 자연 데이터로 방출하므로 뷰어 트릭 불필요. 뷰어는 데드볼도 정상 속도로 재생만 한다.

/**
 * @typedef {Object} Annotation
 * @property {string} kind    "toast" | "banner"
 * @property {number} tick
 * @property {number} [at]    토스트: 앵커 스냅샷 틱.
 * @property {string} text
 * @property {string} [col]
 * @property {string} [anchor] 토스트: 공 대신 이 playerId 선수 위치에 앵커(파울/카드 등 선수 사건).
 * @property {string} [anchorTeam] 그 선수의 팀 (#324) — 중복 playerId 에서 앵커가 반대편에 붙는 것 방지.
 */
/**
 * 액션 토스트(선수 근처) + 상황 배너(상단) + 돌파 추론 주석.
 * @returns {Annotation[]}
 */
export function buildAnnotations(events, snaps) {
  const annos = [];
  for (const e of events) {
    const k = eventKind(e);
    // anchor(선택): 토스트를 공이 아니라 그 playerId 선수 위치에 앵커(선수 사건용). #69.
    const T = (text, col, anchor) => annos.push({ kind: "toast", tick: e.tick, at: e.tick, text, col, ...(anchor ? { anchor, anchorTeam: e.team } : {}) });
    const B = (text, col) => annos.push({ kind: "banner", tick: e.tick, text, col });
    if (k === "shot") T("SHOT!", "#fbbf24");
    else if (k === "shot_one_on_one") T("1-ON-1!", "#fbbf24");
    else if (k === "save") T("🧤 SAVE!", "#38bdf8");
    else if (k === "shot_off_target") T("OFF TARGET", "#94a3b8");
    else if (k === "tackle") T("TACKLE", "#cbd5e1");
    else if (k === "interception") T("INTERCEPT", "#cbd5e1");
    else if (k === "foul") { T("FOUL", "#fb923c", e.playerId); B("😠 FOUL", "#fb923c"); } // 재시작(프리킥/페널티)은 후속 배너가 표시 — 박스 파울에 "프리킥" 오표기 방지.
    else if (k === "card") {
      // #334: id 파생이 등번호로 안 읽히면 **번호를 빼고** 찍는다 — 실경기 id 는 "P077" 이라
      // 그대로 두면 자막이 `🟨 YELLOW #P077` 이 된다(코어는 토큰엔 이미 같은 방어선이 있다, #218).
      const derived = e.playerId ? e.playerId.replace(/[HA]/, "") : "";
      // 길이가 아니라 숫자성(독립검증 minor-2) — 길이로 걸면 "PH7" 이 `#P7` 로 잘려 찍힌다.
      const tag = /^\d{1,2}$/.test(derived) ? ` #${derived}` : "";
      T(e.detail === "red" ? `🟥 RED${tag}` : `🟨 YELLOW${tag}`, e.detail === "red" ? "#ef4444" : "#fde047", e.playerId);
    }
    else if (k === "offside") B("🚩 OFFSIDE", "#f59e0b");
    else if (k === "penalty") B("⚽ PENALTY!", "#22c55e");
    else if (k === "corner") B("CORNER", "#e7edf6");
    else if (k === "goal_kick") B("GOAL KICK", "#e7edf6");
    else if (k === "throw_in") B("THROW-IN", "#e7edf6");
    else if (k === "free_kick") B("FREE KICK", "#e7edf6");
    else if (k === "kickoff" && e.minute > 0) B("▶ KICK-OFF", "#e7edf6");
  }
  // 돌파(롱 드리블) 추론: 같은 소유자 유지 + 전진.
  let start = 0;
  for (let i = 1; i <= snaps.length; i++) {
    const prevO = snaps[i - 1] ? snaps[i - 1].ballOwner : null;
    const curO = snaps[i] ? snaps[i].ballOwner : null;
    if (curO !== prevO || i === snaps.length) {
      const run = i - start;
      if (prevO && run >= 6) {
        const a = snaps[start].ball, b = snaps[i - 1].ball;
        // #324: 전진 방향은 소유팀이 정한다. `prevO[0] === "H"` 추측은 실경기 id(P077…)에서
        // 항상 away 로 읽혀 **홈팀의 돌파가 후진으로 계산**됐다(SURGE 가 홈에 안 뜬다).
        const side = ownerSideOf(snaps[i - 1]);
        const fwd = side === "home" ? b.x - a.x : a.x - b.x;
        const mid = snaps[start + Math.floor(run / 2)];
        if (fwd >= 9 && mid) annos.push({ kind: "toast", tick: mid.tick, at: mid.tick, text: "SURGE!", col: "#a78bfa" });
      }
      start = i;
    }
  }
  return annos;
}

/** 뷰어가 loadLog 에서 한 번 호출. */
export function buildPlayback(events, snaps) {
  const stoppages = buildStoppages(events);
  // #51: 연속 아웃(스로인) 정지는 라이브 재생 후 도착 시 자막 → synth/자막지연 불필요.
  for (const st of stoppages) {
    if (st.setPiece && st.kind === "throw_in") st.continuous = isContinuousOut(snaps, st.causeTick);
  }
  return {
    annos: buildAnnotations(events, snaps),
    stoppages,
    restartTicks: buildRestartTicks(events),
    ballCutTicks: buildBallCutTicks(events, snaps),
    flightSides: buildFlightSides(events, snaps),
  };
}
