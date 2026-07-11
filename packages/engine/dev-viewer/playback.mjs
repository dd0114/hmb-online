// playback.mjs — 뷰어 재생 로직(순수 함수, DOM 무관). vitest 로 검증하고 뷰어가 인라인 사용한다.
// 핵심 원칙: "데드볼 재배치"에서만 공 보간을 끊는다. 빠른 슛 궤적은 이벤트로 구분되므로 끊지 않는다.

/** 이벤트 종류 키. kickoff+detail(corner/throw_in/goal_kick), shot+detail(saved/off_target/one_on_one) 를 펼친다. */
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
 * 스냅샷 A(aTick)→B(bTick) 보간 구간에 데드볼 재배치가 있으면 true(그 구간은 컷).
 * 슛 궤적은 재배치 이벤트가 없으므로 거리와 무관하게 false → 부드럽게 보간된다.
 */
export function spansReposition(aTick, bTick, restartTicks) {
  for (let t = aTick + 1; t <= bTick; t++) if (restartTicks.has(t)) return true;
  return false;
}

/**
 * 데드볼 정지 시퀀스(원인 → 큰 자막 + freeze → 재시작으로 skip).
 * 골은 isGoal:true(GOAL 자막 + 색종이), 나머지(선방/빗나감/파울/오프사이드/PK)는 isGoal:false(상황 카드).
 * → '선방인데 골처럼' 방지: 골과 상황 자막을 데이터 레벨에서 구분.
 */
export function buildStoppages(events) {
  const CAUSE = {
    save: { big: "🧤 선방!", col: "#38bdf8", hold: 1300 },
    shot_off_target: { big: "빗나감!", col: "#94a3b8", hold: 1100 },
    foul: { big: "😠 파울!", col: "#fb923c", hold: 1100 },
    offside: { big: "🚩 오프사이드!", col: "#f59e0b", hold: 1300 },
    penalty: { big: "⚽ 페널티킥!", col: "#22c55e", hold: 1500 },
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
  const SETPIECE_STOP = {
    corner: { big: "⛳ 코너킥!", col: "#e7edf6", hold: 900 },
    throw_in: { big: "🙌 스로인!", col: "#e7edf6", hold: 650 },
  };
  // 프리킥만 자막 없는 짧은 정지 비트 유지(골킥은 빈도 높아 무정지).
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
      out.push({ causeTick: events[i].tick, restartTick: nextRestart(i, events[i].tick, 45), big: c.big, bigCol: c.col, hold: c.hold, isGoal: false, wide: leadsToWideRestart(i, events[i].tick, 45), done: false });
      continue;
    }
    const sp = SETPIECE_STOP[k];
    if (sp) {
      out.push({ causeTick: events[i].tick, restartTick: events[i].tick, big: sp.big, bigCol: sp.col, hold: sp.hold, isGoal: false, setPiece: true, done: false });
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

/**
 * #43: 스로인 등 아웃 비행 합성 — 엔진은 공이 라인을 넘는 틱에 곧바로 재시작 스팟으로 파킹하므로
 * "나가는" 마지막 레그가 데이터에 없다. 직전 두 스냅샷의 속도를 외삽해 경계 교차점(exit)을 구하고,
 * 그 교차점이 재시작 스팟 근처(왜곡 없음)일 때만 {from, exit} 를 반환한다. 뷰어는 freeze 도입부에
 * 이 레그를 그려 공이 실제로 나가는 걸 보여준 뒤 스팟에 놓는다. 합성 불가면 null(기존 컷 유지).
 */
export function synthOutFlight(prev2, prev1, spot, pitch = { w: 105, h: 68 }) {
  const vx = prev1.x - prev2.x, vy = prev1.y - prev2.y;
  if (Math.hypot(vx, vy) < 1e-6) return null; // 정지 공(세이브 파킹 등) — 합성 불가
  // 경계 4변과의 최소 양수 교차 t (prev1 + v*t 가 피치 밖으로 처음 나가는 지점)
  let tHit = Infinity;
  if (vx < 0) tHit = Math.min(tHit, (0 - prev1.x) / vx);
  if (vx > 0) tHit = Math.min(tHit, (pitch.w - prev1.x) / vx);
  if (vy < 0) tHit = Math.min(tHit, (0 - prev1.y) / vy);
  if (vy > 0) tHit = Math.min(tHit, (pitch.h - prev1.y) / vy);
  if (!isFinite(tHit) || tHit < 0 || tHit > 3) return null; // 3틱 내 도달 못 하면 외삽 신뢰 불가
  const exit = { x: prev1.x + vx * tHit, y: prev1.y + vy * tHit };
  if (Math.hypot(exit.x - spot.x, exit.y - spot.y) > 8) return null; // 스팟과 동떨어짐 → 왜곡 합성 금지
  return { from: { x: prev1.x, y: prev1.y }, exit };
}

/** 액션 토스트(선수 근처) + 상황 배너(상단) + 돌파 추론 주석. */
export function buildAnnotations(events, snaps) {
  const annos = [];
  for (const e of events) {
    const k = eventKind(e);
    const T = (text, col) => annos.push({ kind: "toast", tick: e.tick, at: e.tick, text, col });
    const B = (text, col) => annos.push({ kind: "banner", tick: e.tick, text, col });
    if (k === "shot") T("슛!", "#fbbf24");
    else if (k === "shot_one_on_one") T("1:1 찬스!", "#fbbf24");
    else if (k === "save") T("🧤 선방!", "#38bdf8");
    else if (k === "shot_off_target") T("빗나감", "#94a3b8");
    else if (k === "tackle") T("태클", "#cbd5e1");
    else if (k === "interception") T("차단", "#cbd5e1");
    else if (k === "foul") { T("파울", "#fb923c"); B("😠 파울 → 프리킥", "#fb923c"); }
    else if (k === "card") T(e.detail === "red" ? "🟥 레드!" : "🟨 옐로", e.detail === "red" ? "#ef4444" : "#fde047");
    else if (k === "offside") B("🚩 오프사이드", "#f59e0b");
    else if (k === "penalty") B("⚽ 페널티킥!", "#22c55e");
    else if (k === "corner") B("코너킥", "#e7edf6");
    else if (k === "goal_kick") B("골킥", "#e7edf6");
    else if (k === "throw_in") B("스로인", "#e7edf6");
    else if (k === "free_kick") B("프리킥", "#e7edf6");
    else if (k === "kickoff" && e.minute > 0) B("▶ 킥오프", "#e7edf6");
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
        const fwd = prevO[0] === "H" ? b.x - a.x : a.x - b.x;
        const mid = snaps[start + Math.floor(run / 2)];
        if (fwd >= 9 && mid) annos.push({ kind: "toast", tick: mid.tick, at: mid.tick, text: "돌파!", col: "#a78bfa" });
      }
      start = i;
    }
  }
  return annos;
}

/** 뷰어가 loadLog 에서 한 번 호출. */
export function buildPlayback(events, snaps) {
  return {
    annos: buildAnnotations(events, snaps),
    stoppages: buildStoppages(events),
    restartTicks: buildRestartTicks(events),
  };
}
