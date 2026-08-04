// @hmb/viewer-core — 관전 화면 렌더 엔진(SoT). 선수·공·카메라·FX·하이라이트 페이싱·정지 시퀀스·
// 실시간 통계 파생·재생 루프를 소유한다. **캔버스에 그리는 유일한 곳**(ctx. 호출은 이 파일에만).
//
// P4-D3(#169) S2: dev-viewer index.html 인라인 엔진을 여기로 추출. QA 셸(dev-viewer)·web(S3)은
// 이 코어를 마운트하고, DOM 크롬(스코어보드·HUD 그리드·티커·상황자막·타임라인·버튼)은 **호스트가 소유**한다.
// 코어는 canvas 와 `chrome`(DOM 갱신 콜백)만 받아 프레임워크·문서 구조에 무관하게 동작한다.
//
// 결정론 규율(§2-5): Math.random 은 골 세리머니 색종이(순수 시각, 상태·재현 무관)에만 — 렌더 계약 밖.
//
// 사용: const v = createViewer(canvas, chrome); v.start(); v.load(matchLog);
//   chrome 콜백(모두 선택): onScore(h,a) onMinute(s) onClock(s) onScrub(pct) onHud(data)
//     onBanner(text,col|null) onBigCaption(text,col) onSituation(text,col) onClearCaptions()
//     onPlaying(bool) onLoaded({events,snapCount,statusText}) onStatus(text)
//   반환: { start, load, play, pause, togglePlay, restart, scrubTo, jumpToTick, jumpEvent,
//           setFollow, setTrail, setAutoPace, setSpeed, setViewMode, setFixZoom, hooks }
//   hooks = window.__viewer 읽기 표면(captions 는 DOM 이라 호스트가 제공).

import { buildPlayback, spansReposition, inHighlight, effectiveSpeed, clockScaleOf, PACE } from "./playback.mjs";
import { skinKeyOf, skinLookup } from "./skin-key.mjs";
import { ownerSideOf } from "./owner-side.mjs";
import { liveEventStats, computeCumulativePossession, possessionPct, momentum } from "./stats.impl.mjs";

export function createViewer(canvas, chrome = {}) {
  const ctx = canvas.getContext("2d");
  // chrome 콜백 안전 호출(호스트가 일부만 제공해도 무방).
  const cb = (name, ...args) => { const f = chrome[name]; if (f) f(...args); };

  // ===== 튜닝 상수(구 index.html 인라인과 동일) =====
  const PITCH_W = 105, PITCH_H = 68, MARGIN = 30; // MARGIN=피치 둘레 여백px(경계 위 taker·공이 안 잘리게).
  const FOLLOW_ZOOM = 2.6;                 // 공 따라가기 확대율
  const CONTACT_ZOOM = 2.6, FOUL_CONTACT_TICKS = 3; // 파울 접촉 순간 줌 + 지속 틱
  const CAM_SMOOTH = 0.12;                 // 정지 중 카메라 팬 속도(0..1/frame)
  const CAM_MAX_PAN_PXPS = 900;            // #45: 카메라 팬 속도 상한(스크린px/s)
  const CAM_MAX_ZOOM_PS = 2.2;             // #45: 줌 변화 속도 상한(zoom/s)
  const BALL_TRAIL = 6, PLAYER_TRAIL = 10; // 잔상 길이(틱)
  // 페이싱 상수는 **playback.mjs 가 SoT**(#216) — 재생 길이 모델(autoPaceDurationMs)이 같은 값을
  // 읽어야 "실측 재생 길이에 서버 시계를 맞춘다"가 성립한다. 여기서 다시 적으면 조용히 갈라진다.
  const { TICKS_PER_SEC, CRUISE_SPEED, HL_SPEED, HL_PRE, HL_POST, FOUL_HOLD_MS, DEADBALL_PAUSE_MS,
          SETPIECE_WAIT_TICKS, SETPIECE_WAIT_RADIUS_M } = PACE;
  const TOAST_TICKS = 5, BANNER_TICKS = 16, CARD_SHOW_TICKS = 12; // 자막/카드 마커 지속(틱)
  // ── 행동 가시화 이펙트(#406 W5, 요구 4-2) ────────────────────────────────────────────────
  // 전부 **프레임 기반 감쇠**다 — 난수·벽시계를 쓰지 않는다(§2-5 + `skin.spec.ts` 가 같은 틱을
  // 두 번 찍어 픽셀을 비교하므로, 프레임마다 달라지는 요소가 끼면 그 계약이 공허해진다).
  // 값이 클수록 빨리 사라진다(life 1 → 0).
  const FX_DECAY = { pass: 0.075, steal: 0.05, surge: 0.06, clear: 0.045, tackle: 0.055 };
  const FX_RECEIVE_SPAN = 26;   // 수신 수축 링: 바깥 반경 여유(px). life 를 따라 안으로 조인다.
  const FX_CLEAR_LEN_M = 14;    // 걷어내기 쐐기 길이(m) — 방향이 본질이라 링이 아니라 벡터로 그린다.
  // 쐐기 최소 길이 비율. 종전엔 `grow = (1-life)*1.6` 이라 **스폰 프레임에서 정확히 0** 이었다 —
  // 쐐기가 점으로 찌그러져 방향을 말하지 못하고(가시성 하한 계약이 92px 로 걸렸다) 첫 인상이
  // "아무것도 안 뜬 것"이 된다. 자라나는 연출은 유지하되 시작점을 0 이 아니게 한다.
  const FX_CLEAR_GROW_MIN = 0.28;
  const FX_TACKLE_SPOKES = 8;   // 태클 방사 스파크 개수(고정 각도 = 결정론).
  // 가로챔 X 슬래시(#406 W5 독립검증 MAJOR-2 수리).
  // ⚠️ 초판은 반대각 7~12px 를 **팀색 그대로** 그렸다 — 같은 팀색 토큰(반경 8~11px) 안에 완전히
  //    묻혀 3× 크롭 육안으로 어느 프레임에서도 식별되지 않았다. 결과적으로 수신(수축 링)과
  //    가로챔(확산 링)이 한 프레임만 보면 같은 모양이었다("끊었다"의 판별자가 안 온 것).
  //    팀색은 링·중심점이 이미 말한다 → 슬래시는 **무채색 대비 + 토큰 밖 길이**로 자기 몫을 한다.
  //    ⚠️ 값은 **토큰 반경에서 역산**한다. 팔로우 줌에서 토큰 R=11 · 선택 링이 R+9=20 이므로,
  //    반팔 L 의 대각 끝(√2·L)이 그 층을 넘어야 "토큰 안에 묻힌" 초판으로 되돌아가지 않는다.
  //    L=13(초판 수리안)이면 끝이 18.4 라 R=11 화면에서 링 안쪽에 걸쳤다 — 실측 토큰밖 무채색
  //    78px. L=17 이면 끝 24.0 으로 확실히 밖이다(실측은 계약 콘솔 `[슬래시]` 참조).
  const FX_STEAL_SLASH_MIN = 17;  // 반팔 길이(px) 시작 — 대각 끝 √2·17 ≈ 24 > 선택 링 20.
  const FX_STEAL_SLASH_MAX = 26;  // 감쇠하며 여기까지 벌어진다.
  const FX_STEAL_SLASH_W = 3.2;   // 흰 심 두께(외곽선은 +3.5).
  // ── 액션 토스트 겹침 방지(#69 의 재해석 — #406 W5 독립검증 BLOCKER-1) ─────────────────────
  // 종전 스택 키는 `틱:팀:앵커` 라 **틱이 다르면 절대 스택하지 않았다**. 토스트는 TOAST_TICKS 동안
  // 살아 있으므로 "같은 선수 위, 인접 틱" 조합은 그대로 겹쳐 글자가 뭉갰다(실측 dx=0 · dy=4.4px ·
  // 같은 팀색). W5 이전엔 TACKLE/INTERCEPT 가 **공 앵커**라 그 조합이 열리지 않았을 뿐이다.
  // → 판정을 **틱이 아니라 화면 근접**으로 바꾼다: 살아 있는 토스트끼리 겹치면 위로 밀어낸다.
  //
  // ⚠️ **간격은 글자가 차지하는 세로에서 나온다 — 계약 임계에서 역산하지 않는다**(#406 W6 m3).
  //    초판은 계약(dy<14)보다 "한 칸 크게" 16/17 을 잡았는데, 실효 여유가 **1~2px** 이라 계약을
  //    한 칸만 넓혀도(dy<20 && dx<90) 읽기 불가 쌍이 **56건** 나왔다(최악 `INTERCEPT`/`CLEARED!`
  //    dx=0 · dy=17 = 그때의 `TOAST_STACK_GAP` 그 값). 즉 "계약보다 크다"는 아무것도 보장하지
  //    않았고 계약이 스스로의 임계를 근거로 초록이던 것이다.
  //    이제 기하에서 유도한다 — 글자는 `bold 15px sans-serif` 에 외곽선 `lineWidth 3`(바깥 1.5px)
  //    이고 `textBaseline="middle"` 이다.
  //    ⚠️ **세로 점유를 `15 × 1.1 + 3 ≈ 19.5px` 라고 적었던 것은 산술 추정이고 틀렸다**(W7 m-3).
  //    Chromium 실측(`measureText("INTERCEPT!")`)은 잉크 **11.3px**(asc 11.0 · desc 0.3 —
  //    전부 대문자라 디센더가 없다)이고 외곽선까지 **14.3px** 다. 되돌렸던 17 조차 2.7px
  //    여유가 있었으므로 *"17 이면 획이
  //    서로를 먹는다"* 는 성립하지 않았다. 값 22 는 그대로 두되(잉크 위 7.7px 여백 = 두 줄이
  //    확실히 갈리는 간격) **근거를 실측으로 바꾼다**. 그 실측은 계약이 매번 다시 잰다
  //    (`action-effects.spec.ts` 토스트 스윕 머리 — 폰트가 바뀌면 거기서 먼저 빨강이 난다).
  //    가로는 실측이 근거를 받쳤다 — `INTERCEPT!` 폭 **≈90.0px** 이라 72 는 절반만 덮었다.
  const TOAST_NEAR_DX = 96;     // 이 안쪽으로 가까우면 "같은 가로 자리"로 본다(px).
  const TOAST_NEAR_DY = 22;     // 그때 요구하는 최소 세로 간격(px) — 위 기하에서 유도.
  const TOAST_STACK_GAP = 24;   // 밀어낼 때 확보하는 간격(px) — TOAST_NEAR_DY 보다 커야 한다.
  const TOAST_STACK_MAX = 12;   // 밀어내기 반복 상한(무한루프 방어).
  // ── 선수 하이라이트(#406 W4, 요구 5-2) ────────────────────────────────────────────────
  // hero 확정 ② = **펄스 링 `R+9`**. 실화면 QA 후 갈아끼울 수 있게 값은 **여기 한 곳**에만 둔다.
  //
  // 왜 R+9 인가: 토큰 주변엔 이미 신호가 둘 있다 — 볼 소유자 노란 링(`R+2`)과 카드 마커(`R+6`).
  // 셋이 겹쳐도 읽히려면 **반경으로 층이 갈려야** 한다. 그래서 맥동은 **바깥으로만** 부풀린다
  // (안으로 접으면 최소 반경이 카드 마커 위로 내려앉아 층이 무너진다).
  //
  // ⚠️ **위상은 플레이헤드(`tickPos`)에서 나온다 — 벽시계(`Date.now`/`performance.now`) 금지.**
  //    ①루트 §2-5 결정론 규율 ②`skin.spec.ts` 가 **같은 틱을 두 번 찍어 `toDataURL` 을 비교**한다.
  //    프레임마다 달라지는 요소가 끼면 "on/off 렌더가 달라야 한다"가 늘 참이 되어 그 계약이
  //    공허해진다. `tickPos` 기반이면 같은 틱 재렌더는 바이트 동일이고, 재생 중에는 헤드가
  //    흐르므로 실제로 맥동한다(정지 중엔 멈춘 링 = 정지 화면에서도 보인다).
  const SELECT = {
    ringGap: 9,     // 링 기본 반경 = 토큰 반경 R + 이 값.
    pulsePx: 3,     // 맥동 폭(px, 바깥 방향으로만).
    pulseTicks: 9,  // 한 주기의 플레이헤드 인덱스 수.
    labelPadPx: 12, // 이름표 알약 좌우 여백(측정 폭에 더한다).
    mine: { color: "#ffffff", width: 3, labelAlpha: 1, labelEdge: 1.6, dash: null },
    opp: { color: "rgba(148,163,184,0.95)", width: 2, labelAlpha: 0.8, labelEdge: 1, dash: null },
    /*
     * **모른다**(`mine` 미지정) — 종전엔 `sel.mine ? mine : opp` 라 상대 스타일로 떨어졌다.
     * 그런데 호스트 카드는 같은 상태에서 **뱃지를 안 단다**(거짓 표식 금지, #322) → 한 화면의 두
     * 표면이 다른 말을 했다(#406 W6 m6: 링은 "상대", 카드는 무언). 세 번째 스타일을 둬서 둘을
     * 맞춘다 — 점선은 "확정되지 않음"을 색을 쓰지 않고 말하는 유일한 축이다(링은 무채색 규율 —
     * 팀색 fx 와 섞이면 안 된다, W5).
     */
    unknown: { color: "rgba(203,213,225,0.85)", width: 2, labelAlpha: 0.8, labelEdge: 1, dash: [5, 4] },
  };

  // ===== 상태 =====
  let log = null, snaps = [], playing = false, speed = 1, tickPos = 0, lastTs = 0;
  let follow = false, showTrail = true, autoPace = true, keyTicks = [], confetti = [];
  let viewMode = "auto", fixZoom = 1;      // #114 뷰 모드
  let shotFx = [], shotFxTicks = new Set(); // 유효슛 링 이펙트
  let fx = [], passEvents = [], interceptEvents = [], surgeTicks = [];
  // 행동 이펙트 레이어 on/off(#406 W5 가시성 하한 계약). **스폰은 그대로 두고 그리기만** 끈다 —
  // 같은 상태를 두 번 그려 "이펙트가 실제로 픽셀을 바꿨나"를 재려면 다른 것이 전부 같아야 한다.
  let fxLayerOn = true;
  let clearanceEvents = [], tackleEvents = [];  // #406 W5: 걷어내기·태클 이펙트 소스
  // #406 W4: 선택된 선수(하이라이트). 키 = `skinKeyOf(team, playerId)` — setSelection 주석 참조.
  let selection = new Map();
  let cardMarks = [], lastCardMarks = [];   // R4(#100): 카드 받은 선수 표시
  let lastToasts = [];                      // #324: 그려진 토스트(앵커 검증용 읽기 표면)
  let annos = [], snapByTick = new Map(), restartTickSet = new Set(), ballCutTickSet = new Set(), totalMinutes = 0;
  let flightSides = new Map();               // 슛/패스 비행 틱 → 발사팀 side
  let stoppages = [], hold = null;           // 데드볼: freeze→skip 시퀀스
  let lastRender = null, lastGeom = null, lastPlayers = [], lastTrail = [], lastPlayerTrail = [];
  let frameDt = 1 / 60;
  let cumPoss = { cumHome: [], cumAway: [] }, lastHudTick = -1;
  let lastGoalShown = -1;
  let rafId = 0;
  let skin = null; // 캐릭터 스킨(#145) — setSkin 으로 주입. null 이면 현행 단색 원(무회귀).

  const baseScale = Math.min(
    (canvas.width - 2 * MARGIN) / PITCH_W,
    (canvas.height - 2 * MARGIN) / PITCH_H,
  );
  let cam = { cx: PITCH_W / 2, cy: PITCH_H / 2, zoom: 1 };

  function sx(x) { return canvas.width / 2 + (x - cam.cx) * baseScale * cam.zoom; }
  function sy(y) { return canvas.height / 2 + (y - cam.cy) * baseScale * cam.zoom; }
  const lerp = (a, b, t) => a + (b - a) * t;
  const idxOfTick = (tick) => { const i = snaps.findIndex((s) => s.tick >= tick); return i < 0 ? snaps.length - 1 : i; };
  /**
   * 카드 라벨 등번호 (#324). 스킨(팀 포함 키) 우선 — 실경기 id 는 "P077" 이라 문자 치환이 안 먹고,
   * 게다가 같은 id 가 양 팀에 있어 팀 없이 조회하면 상대팀 번호가 나온다. 스킨이 없으면 종전 그대로
   * id 파생, 그것도 등번호로 안 읽히면(3자 이상) "?" — 토큰에 id 원문을 찍지 않는다.
   */
  const cardNumOf = (cm) => {
    const fromSkin = skin && cm.playerId ? skinLookup(skin.nums, cm.side, cm.playerId) : undefined;
    if (fromSkin) return fromSkin;
    const raw = cm.playerId ? cm.playerId.replace(/[HA]/, "") : "?";
    return raw.length <= 2 ? raw : "?";
  };
  /** 틱→표기분 스케일(#365). 유도 규칙은 `playback.mjs.clockScaleOf` 가 SoT. */
  let clockScale = 1;
  const mmss = (t) => {
    const d = t * clockScale;
    return `${Math.floor(d / 60)}'${String(Math.floor(d % 60)).padStart(2, "0")}"`;
  };

  function drawPitch() {
    ctx.fillStyle = "#14532d"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(255,255,255,0.035)";
    const stripes = 12, sw = PITCH_W / stripes;
    for (let i = 0; i < stripes; i += 2) ctx.fillRect(sx(i * sw), sy(0), sx((i + 1) * sw) - sx(i * sw), sy(PITCH_H) - sy(0));
    ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.lineWidth = 2;
    ctx.strokeRect(sx(0), sy(0), sx(PITCH_W) - sx(0), sy(PITCH_H) - sy(0));
    ctx.beginPath(); ctx.moveTo(sx(PITCH_W / 2), sy(0)); ctx.lineTo(sx(PITCH_W / 2), sy(PITCH_H)); ctx.stroke();
    ctx.beginPath(); ctx.arc(sx(PITCH_W / 2), sy(PITCH_H / 2), (sx(9.15) - sx(0)), 0, Math.PI * 2); ctx.stroke();
    const boxD = 16.5, boxW = 40.3, gy0 = (PITCH_H - boxW) / 2;
    ctx.strokeRect(sx(0), sy(gy0), sx(boxD) - sx(0), sy(gy0 + boxW) - sy(gy0));
    ctx.strokeRect(sx(PITCH_W - boxD), sy(gy0), sx(PITCH_W) - sx(PITCH_W - boxD), sy(gy0 + boxW) - sy(gy0));
    const g0 = (PITCH_H - 7.32) / 2;
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fillRect(sx(0) - 5, sy(g0), 5, sy(g0 + 7.32) - sy(g0));
    ctx.fillRect(sx(PITCH_W), sy(g0), 5, sy(g0 + 7.32) - sy(g0));
  }

  // #90: 세트피스 재시작 대기 구간(공이 스팟에 정지, taker 워크인) 판정 — 이 구간엔 클로즈업 억제.
  function inSetpieceWait(tick) {
    for (const st of stoppages) {
      if (st.isGoal || !st.setPiece || tick < st.causeTick || tick > st.causeTick + SETPIECE_WAIT_TICKS) continue;
      const cs = snapByTick.get(st.causeTick), now = snapByTick.get(tick);
      if (cs && now && Math.hypot(now.ball.x - cs.ball.x, now.ball.y - cs.ball.y) < SETPIECE_WAIT_RADIUS_M) return true;
    }
    return false;
  }

  function draw() {
    if (snaps.length === 0) { drawPitch(); return; }
    const i = Math.min(Math.floor(tickPos), snaps.length - 1);
    const j = Math.min(i + 1, snaps.length - 1);
    const t = tickPos - i;
    const A = snaps[i], B = snaps[j];
    // 데드볼 재배치 구간만 보간 안 함(슛 궤적은 이벤트로 구분 → 부드럽게).
    const bt = spansReposition(A.tick, B.tick, ballCutTickSet) ? 0 : t;
    let bx = lerp(A.ball.x, B.ball.x, bt), by = lerp(A.ball.y, B.ball.y, bt);
    lastRender = { x: bx, y: by, bt, aTick: A.tick, bTick: B.tick, tickPos, zoom: hold ? !!hold.zoom : false };

    // 카메라
    const curTick = A.tick;
    const fixMode = viewMode === "fix";
    const nearKey = !fixMode && autoPace && !inSetpieceWait(curTick) && inHighlight(curTick, keyTicks, HL_PRE, HL_POST);
    const koTweening = hold && hold.koIdx != null && hold.tween > 0.4;
    let contactPos = null;
    if (!fixMode && autoPace) for (const st of stoppages) {
      if (st.isGoal || !st.contactAnchor || curTick < st.causeTick || curTick > st.causeTick + FOUL_CONTACT_TICKS) continue;
      const csnap = snapByTick.get(st.causeTick);
      // #324: 중복 playerId 에서 반대 팀 선수로 줌하던 것 — 팀이 있으면 팀까지 맞춘다.
      const pl = csnap && csnap.players.find((p) =>
        p.playerId === st.contactAnchor && (!st.contactAnchorTeam || p.team === st.contactAnchorTeam));
      if (pl) { contactPos = pl.pos; break; }
    }
    const useFollow = !fixMode && !koTweening && !contactPos && (follow || nearKey || (hold ? !!hold.zoom : false));
    const camTarget = fixMode
      ? { cx: PITCH_W / 2, cy: PITCH_H / 2, zoom: fixZoom }
      : contactPos
      ? { cx: contactPos.x, cy: contactPos.y, zoom: CONTACT_ZOOM }
      : useFollow ? { cx: bx, cy: by, zoom: FOLLOW_ZOOM } : { cx: PITCH_W / 2, cy: PITCH_H / 2, zoom: 1 };
    if (fixMode) {
      cam = { cx: camTarget.cx, cy: camTarget.cy, zoom: camTarget.zoom };
    } else {
      const cs = playing ? 1 - Math.pow(1 - CAM_SMOOTH, Math.min(3, frameDt * 60)) : 1;
      let ncx = cam.cx + (camTarget.cx - cam.cx) * cs;
      let ncy = cam.cy + (camTarget.cy - cam.cy) * cs;
      let nz = cam.zoom + (camTarget.zoom - cam.zoom) * cs;
      if (playing) {
        const pxPerM = baseScale * cam.zoom;
        const maxPanM = (CAM_MAX_PAN_PXPS * frameDt) / pxPerM;
        const dxm = ncx - cam.cx, dym = ncy - cam.cy, dm = Math.hypot(dxm, dym);
        if (dm > maxPanM) { ncx = cam.cx + (dxm / dm) * maxPanM; ncy = cam.cy + (dym / dm) * maxPanM; }
        const maxDz = CAM_MAX_ZOOM_PS * frameDt;
        if (Math.abs(nz - cam.zoom) > maxDz) nz = cam.zoom + Math.sign(nz - cam.zoom) * maxDz;
      }
      cam = { cx: ncx, cy: ncy, zoom: nz };
    }
    drawPitch();

    // 선수 잔상(옵션). #100: 데드볼 재배치 전 위치 도트 클러터 제거(restartTickSet 로 컷).
    const ptrail = [];
    if (showTrail) {
      for (let s = Math.max(0, i - PLAYER_TRAIL); s < i; s++) {
        if (spansReposition(snaps[s].tick, A.tick, restartTickSet)) continue;
        const a = (s - (i - PLAYER_TRAIL)) / PLAYER_TRAIL * 0.18;
        for (const p of snaps[s].players) {
          ctx.beginPath(); ctx.arc(sx(p.pos.x), sy(p.pos.y), 3, 0, Math.PI * 2);
          ctx.fillStyle = p.team === "home" ? `rgba(59,130,246,${a})` : `rgba(239,68,68,${a})`; ctx.fill();
          ptrail.push({ id: p.playerId, x: p.pos.x, y: p.pos.y, srcTick: snaps[s].tick });
        }
      }
    }
    lastPlayerTrail = ptrail;
    // 공 궤적: 짧은 comet 꼬리. 소유팀 색(carry-forward). 데드볼 재배치 구간은 세그먼트 건너뜀.
    ctx.lineWidth = 2.8;
    const segSideAt = (s) => ownerSideOf(snaps[s]) || flightSides.get(snaps[s].tick) || null;
    let trailSide = null;
    for (let b = Math.max(0, i - BALL_TRAIL); b >= Math.max(0, i - BALL_TRAIL - 8); b--) {
      const sd = segSideAt(b); if (sd) { trailSide = sd; break; }
    }
    const trailRender = [];
    for (let s = Math.max(1, i - BALL_TRAIL + 1); s <= i; s++) {
      const segSide = segSideAt(s) || segSideAt(s - 1) || trailSide;
      if (segSide) trailSide = segSide;
      if (spansReposition(snaps[s - 1].tick, snaps[s].tick, ballCutTickSet)) continue;
      const a = (s - (i - BALL_TRAIL)) / BALL_TRAIL;
      const rgb = segSide === "home" ? "59,130,246" : segSide === "away" ? "239,68,68" : "203,213,225";
      ctx.strokeStyle = `rgba(${rgb},${(0.18 + 0.55 * Math.max(0, a)).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(sx(snaps[s - 1].ball.x), sy(snaps[s - 1].ball.y));
      ctx.lineTo(sx(snaps[s].ball.x), sy(snaps[s].ball.y));
      ctx.stroke();
      trailRender.push({ side: segSide || null, endTick: snaps[s].tick });
    }
    lastTrail = trailRender;

    // 선수
    const R = useFollow ? 11 : 8;
    const fs = useFollow ? 12 : 9;
    ctx.font = `bold ${fs}px monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    let ownerDraw = null;
    const drawNum = (num, px, py) => {
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.9)"; ctx.strokeText(num, px, py);
      ctx.fillStyle = "#fff"; ctx.fillText(num, px, py);
    };
    const koSnap = hold && hold.koIdx != null ? snaps[hold.koIdx] : null;
    // #324: 같은 playerId 가 양 팀에 뛰므로 팀까지 키에 넣는다 — 단독 키면 한 팀 인스턴스가
    // 다른 팀 것에 덮여, 킥오프 잔상 클립이 엉뚱한 선수의 위치로 보간된다.
    const koById = koSnap ? new Map(koSnap.players.map((q) => [skinKeyOf(q.team, q.playerId), q.pos])) : null;
    const ptw = koSnap ? hold.tween * hold.tween * (3 - 2 * hold.tween) : 0; // smoothstep
    const playerRender = [];
    const pt = spansReposition(A.tick, B.tick, restartTickSet) ? 0 : t;
    for (let k = 0; k < A.players.length; k++) {
      const pa = A.players[k], pb = B.players[k] || pa;
      let x = lerp(pa.pos.x, pb.pos.x, pt), y = lerp(pa.pos.y, pb.pos.y, pt);
      if (koById) {
        const kp = koById.get(skinKeyOf(pa.team, pa.playerId));
        if (kp) { x = lerp(pa.pos.x, kp.x, ptw); y = lerp(pa.pos.y, kp.y, ptw); }
      }
      const isHome = pa.team === "home", owner = A.ballOwner === pa.playerId;
      const px = sx(x), py = sy(y);
      // px/py = **실제로 그린 캔버스 픽셀 좌표**(#218). 계약 테스트가 토큰 자리를 픽셀로 검사할 때
      // 카메라 변환을 바깥에서 재구현하면(baseScale·zoom·MARGIN) 렌더와 조용히 어긋난다 —
      // "무엇이 그려졌나"는 그린 쪽이 알려준다. 읽기 전용·추가 필드(기존 소비자 무영향).
      // `r` = **오버레이 층의 기준 토큰 반경**(px). 소유자 링 R+2 · 카드 마커 R+6 · 선택 링 R+9 가
      // 전부 이 값에서 잰다. 밖에서 `useFollow ? 11 : 8` 을 다시 적으면 층 관계 계약이 렌더와
      // 조용히 어긋나고, web 히트테스트도 같은 값을 두 번 갖게 된다(#218 규율의 연장).
      // `selected` 는 아래 선택 패스가 채운다 — 기본은 항상 false(정의되지 않은 필드로 두지 않는다).
      const render = { id: pa.playerId, team: pa.team, x, y, px, py, r: R, selected: false };
      playerRender.push(render);
      // 캐릭터 스킨(#145, S3): setSkin 으로 아틀라스가 주입됐고 이 선수 셀이 있으면 얼굴 아바타 +
      // 팀색 링/디스크/번호 뱃지로 그린다. 없으면(QA·미주입·로드전) 현행 단색 원(무회귀).
      // #324: 팀 포함 키 우선, 없으면 단독 키(구 페이로드 호환).
      const entry = skin ? skinLookup(skin.byPlayer, pa.team, pa.playerId) : null;
      const atlas = entry ? skin.atlases[entry.atlas || 0] : null;
      const cell = atlas && atlas.ok ? entry : null;
      // 등번호 폴백(#218): 얼굴이 없다고 **선수 id 원문**("P173")을 토큰에 찍으면 안 된다 —
      // 실경기 id 는 길어서 토큰을 덮어 아이콘이 아예 안 보이는 것처럼 읽힌다(hero 제보의 실체).
      // 아트 유무와 무관하게 부모가 준 등번호를 쓰고, 그것마저 없을 때만 id 파생으로 떨어진다.
      const rawNum =
        (entry && entry.num) ||
        (skin && skinLookup(skin.nums, pa.team, pa.playerId)) ||
        pa.playerId.replace(/[HA]/, "");
      // 그 파생마저 등번호로 안 읽히면(3자 이상 = 실경기 id) **아무것도 안 찍는다**. 부모가 등번호를
      // 안 넘긴 소비자에서도 토큰이 글자에 덮이지 않게 — 코어 자체의 방어선(독립 QA 권고).
      const num = rawNum.length <= 2 ? rawNum : "";
      // #324: **실제로 그린 등번호와 얼굴 유무**를 계약이 읽을 수 있게 노출한다(#218 의 px/py 선례 —
      // "무엇이 그려졌나"는 그린 쪽이 알려준다). 이게 없으면 렌더러가 팀 키로 조회하는지를 밖에서
      // 확인할 길이 없어, 조회를 단독 키로 되돌려도 아무 계약이 안 깨진다(독립검증 blocker-1).
      render.num = num;
      if (!cell) {
        ctx.beginPath(); ctx.arc(px, py, owner ? R + 2 : R, 0, Math.PI * 2);
        ctx.fillStyle = isHome ? "#3b82f6" : "#ef4444"; ctx.fill();
        if (owner) { ctx.strokeStyle = "#fde047"; ctx.lineWidth = 3; ctx.stroke(); }
        if (owner) ownerDraw = { num, px, py }; else drawNum(num, px, py);
      } else {
        const _rr = owner ? R + 2 : R, _S = _rr * 2 * 1.55, _ring = _S / 2 + 2.5;
        const _team = isHome ? "#3b82f6" : "#ef4444";
        ctx.beginPath(); ctx.arc(px, py, _ring, 0, Math.PI * 2);
        ctx.fillStyle = isHome ? "rgba(37,99,235,0.55)" : "rgba(220,38,38,0.55)"; ctx.fill();
        const _sm = ctx.imageSmoothingEnabled; ctx.imageSmoothingEnabled = false;
        // 불투명 배경 위에 그려진 얼굴(#207 `iconBackground:"opaque-dark"`)은 타일이 **사각 덩어리**로
        // 남는다 → 토큰 링 안쪽 원으로 잘라 넣는다. 투명 얼굴은 자르지 않는다(글로우·머리끝 보존).
        const _clip = entry.bg === "opaque-dark";
        if (_clip) { ctx.save(); ctx.beginPath(); ctx.arc(px, py, _ring - 1, 0, Math.PI * 2); ctx.clip(); }
        ctx.drawImage(atlas.img, cell.col * atlas.tile, cell.row * atlas.tile, atlas.tile, atlas.tile,
          px - _S / 2, py - _S / 2, _S, _S);
        if (_clip) ctx.restore();
        ctx.imageSmoothingEnabled = _sm;
        ctx.beginPath(); ctx.arc(px, py, _ring, 0, Math.PI * 2);
        ctx.strokeStyle = owner ? "#fde047" : _team; ctx.lineWidth = owner ? 3.2 : 2.2; ctx.stroke();
        const _bx = px + _ring * 0.78, _by = py + _ring * 0.78, _br = Math.max(5, _rr * 0.62);
        ctx.beginPath(); ctx.arc(_bx, _by, _br, 0, Math.PI * 2);
        ctx.fillStyle = _team; ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.75)"; ctx.lineWidth = 1; ctx.stroke();
        ctx.save(); ctx.font = "bold " + Math.round(_br * 1.5) + "px monospace";
        ctx.fillStyle = "#fff"; ctx.fillText(num, _bx, _by); ctx.restore();
        if (owner) ownerDraw = { num: "", px, py };
      }
    }
    lastPlayers = playerRender;
    // R4(#100): 카드 받은 선수 표시.
    lastCardMarks = [];
    for (const cm of cardMarks) {
      if (curTick < cm.tick || curTick > cm.tick + CARD_SHOW_TICKS) continue;
      // #324: 중복 playerId 에서 카드가 상대팀 선수 위에 그려지던 것 — 팀까지 맞춘다.
      const pr = playerRender.find((p) => p.id === cm.playerId && (!cm.side || p.team === cm.side));
      if (!pr) continue;
      const px = sx(pr.x), py = sy(pr.y);
      const cardCol = cm.red ? "#ef4444" : "#eab308";
      ctx.beginPath(); ctx.arc(px, py, R + 6, 0, Math.PI * 2);
      ctx.strokeStyle = cardCol; ctx.lineWidth = 3; ctx.stroke();
      const iw = 12, ih = 16, ix = px + R + 3, iy = py - R - ih - 2;
      ctx.fillStyle = cardCol; ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineWidth = 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(ix, iy, iw, ih, 2); else ctx.rect(ix, iy, iw, ih);
      ctx.fill(); ctx.stroke();
      const cardNum = cardNumOf(cm);
      const label = `#${cardNum}`;
      ctx.font = "bold 14px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      const lx = ix + iw + 3, ly = iy + ih / 2;
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.9)"; ctx.strokeText(label, lx, ly);
      ctx.fillStyle = cardCol; ctx.fillText(label, lx, ly);
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      lastCardMarks.push({ playerId: cm.playerId, num: cardNum, red: cm.red, side: cm.side, px, py });
    }
    /*
     * 선수 하이라이트(#406 W4, 요구 5-2) — 카드 마커 **다음**에 그린다. 반경이 층으로 갈려 있어
     * (선택 R+9 > 카드 R+6 > 소유자 R+2) 겹쳐도 서로 덮지 않지만, 이름표는 다른 토큰 위로
     * 올라와야 읽히므로 순서가 뒤가 맞다.
     *
     * ⚠️ 조회 키는 **반드시 `skinKeyOf(team, playerId)`** 다 — 같은 playerId 가 양 팀에 동시에
     *    뛴다(#324/#231). 단독 id 로 잡으면 **반대 팀 선수가 같이 켜진다**.
     */
    if (selection.size) {
      // 위상 = 플레이헤드. 벽시계·난수 금지(SELECT 주석). 음수 tickPos 방어로 두 번 감싼다.
      const phase = (((tickPos / SELECT.pulseTicks) % 1) + 1) % 1;
      const wave = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2); // 0..1
      for (const pr of playerRender) {
        const sel = selection.get(skinKeyOf(pr.team, pr.id));
        if (!sel) continue;
        // 3값 축(#406 W6 m6) — true=내 선수 / false=상대 / null=모른다(점선). `sel.mine` 는
        // 주입 시점에 이미 3값으로 정규화돼 있다(아래 주입 함수 주석 참조).
        const style = sel.mine === true ? SELECT.mine : sel.mine === false ? SELECT.opp : SELECT.unknown;
        const rr = R + SELECT.ringGap + SELECT.pulsePx * wave;
        ctx.save();
        ctx.globalAlpha = 0.55 + 0.45 * wave;
        ctx.strokeStyle = style.color;
        ctx.lineWidth = style.width;
        if (style.dash) ctx.setLineDash(style.dash);
        ctx.beginPath(); ctx.arc(pr.px, pr.py, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]); // 이름표 알약 테두리까지 점선이 번지지 않게(같은 ctx 상태다).
        // 이름표 — **라벨은 부모가 준다**(코어는 선수 이름을 모른다: 도메인 지식 유출 0).
        // 안 주면 실제로 그린 등번호로 떨어지고, 그것도 없으면 이름표를 그리지 않는다.
        const label = sel.label || (pr.num ? `#${pr.num}` : "");
        if (label) {
          const th = Math.max(15, R * 1.35);
          const ty = pr.py + rr + th * 0.75;
          ctx.font = `bold ${Math.max(9, Math.round(R * 0.95))}px sans-serif`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          const tw = ctx.measureText(label).width + SELECT.labelPadPx;
          ctx.globalAlpha = style.labelAlpha;
          // 색 SoT 는 `teamRgb` 하나(playback.mjs:379 가 선언한 규약). 종전엔 여기만 `#3b82f6`/
          // `#ef4444` 를 하드코딩해 두 자리가 갈릴 수 있었다 — 값이 같아 조용했을 뿐이다(W4 m-1).
          ctx.fillStyle = `rgb(${teamRgb(pr.team)})`;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(pr.px - tw / 2, ty - th / 2, tw, th, th / 2);
          else ctx.rect(pr.px - tw / 2, ty - th / 2, tw, th);
          ctx.fill();
          ctx.strokeStyle = style.color; ctx.lineWidth = style.labelEdge; ctx.stroke();
          ctx.fillStyle = "#fff"; ctx.fillText(label, pr.px, ty + 0.5);
        }
        ctx.restore();
        /*
         * #218/#324 규율 — **그린 쪽이 알려준다**. 조회를 단독 키로 되돌리면(`selected`) 밖에서
         * 잡힌다.
         *
         * ⚠️ **이 장부는 "링이 그려졌다"를 뜻하지 않는다.** 초판 주석은 *"이게 없으면 반경을 카드
         *    마커 아래로 내려도 밖에서 확인할 길이 없다"* 라고 적었는데 **사실과 반대**였다 —
         *    `selectR` 은 위 `ctx.arc(...)` 와 **인접할 뿐 파생 관계가 아니라서**, 링을 통째로
         *    지워도(V7) 반경을 `R+2` 로 내려도(V7b) 이 값은 그대로 `R+ringGap+…` 을 보고한다.
         *    독립검증이 두 변이를 태워 **12/12 생존**을 확인했다(W4 BLOCKER-1).
         *    → 층·존재는 **픽셀로** 걸어라: `player-select.spec.ts` 의 "선택 링이 실제로 그
         *    반경의 픽셀을 바꾼다"(선택 on/off 차분의 **반경 분포**)가 그 계약이다. 여기 장부는
         *    *어느 토큰이 켜졌나*(팀 축)만 말한다.
         */
        pr.selected = true;
        // 3값 그대로 싣는다(`!!` 로 접으면 "모른다"가 밖에서 "상대"로 읽힌다 — m6 의 뿌리).
        pr.selectMine = sel.mine;
        pr.selectR = rr;
        pr.selectLabel = label || null;
      }
    }
    // 공
    const br = useFollow ? 7 : 5.5;
    const boy = ownerDraw ? R + br + 1 : 0;
    ctx.save();
    ctx.shadowColor = "#ffe600"; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(sx(bx), sy(by) + boy, br, 0, Math.PI * 2);
    ctx.fillStyle = "#ffe600"; ctx.fill();
    ctx.shadowBlur = 0; ctx.lineWidth = 1.5; ctx.strokeStyle = "#6b5200"; ctx.stroke();
    ctx.restore();
    if (ownerDraw) { ctx.font = `bold ${fs}px monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; drawNum(ownerDraw.num, ownerDraw.px, ownerDraw.py); }
    lastGeom = {
      cw: canvas.width, ch: canvas.height,
      ball: { px: sx(bx), py: sy(by) + boy, r: br },
      owner: ownerDraw ? { px: ownerDraw.px, py: ownerDraw.py, r: R + 2 } : null,
    };

    // 유효슛 링 이펙트
    if (shotFx.length) {
      for (const f of shotFx) {
        ctx.globalAlpha = Math.max(0, f.life) * 0.9;
        ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(sx(f.x), sy(f.y), 6 + f.r, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // R2 재미 이펙트: 패스수신(#406 W5 로 수축 링 재해석)·가로챔·돌파 + 걷어내기·태클(#406 W5).
    if (fxLayerOn && fx.length) {
      for (const f of fx) {
        const a = Math.max(0, f.life);
        if (f.type === "pass") {
          // **수축** 링(밖→안) = "받았다". 확산 링(가로챔·슛)과 방향이 반대라 "받았다/떠났다"가
          // 모양이 아니라 **방향**으로 갈린다(목업 §5). 그래서 여기만 r 누적을 쓰지 않고 life 로 조인다.
          // `drawnR` = **실제로 그린 반경**(#218 규율 "그린 쪽이 알려준다"). 링 부호 계약
          // (수신=감소 · 가로챔=증가)이 두 프레임을 비교할 때 읽는 값이다 — 밖에서 공식을 다시
          // 적으면 그리기를 바꿔도 계약이 안 깨진다.
          const rr = 8 + FX_RECEIVE_SPAN * a;
          f.drawnR = rr;
          ctx.globalAlpha = a * 0.75; ctx.strokeStyle = `rgb(${f.rgb})`; ctx.lineWidth = 2.6;
          ctx.beginPath(); ctx.arc(sx(f.x), sy(f.y), rr, 0, Math.PI * 2); ctx.stroke();
          // 토큰 밝기 플래시 — 수축이 끝나는 자리(선수 위)를 짚어 준다.
          ctx.globalAlpha = a * 0.55; ctx.fillStyle = "#ffffff";
          ctx.beginPath(); ctx.arc(sx(f.x), sy(f.y), 3 + 5 * a, 0, Math.PI * 2); ctx.fill();
        } else if (f.type === "steal") {
          const rr = 5 + f.r;               // 확산 링(수신의 수축과 부호가 반대) — `drawnR` 로 노출.
          f.drawnR = rr;
          const cx0 = sx(f.x), cy0 = sy(f.y);
          ctx.globalAlpha = a * 0.9; ctx.strokeStyle = `rgb(${f.rgb})`; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(cx0, cy0, rr, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = a * 0.45; ctx.fillStyle = `rgb(${f.rgb})`;
          ctx.beginPath(); ctx.arc(cx0, cy0, 4.5, 0, Math.PI * 2); ctx.fill();
          // X 슬래시 — "끊었다"의 판별자(확산 링만으로는 패스 계열과 모양이 같다).
          // ⚠️ 초판은 팀색 그대로 7~12px 라 같은 색 토큰 안에 묻혔다(MAJOR-2). 이제 **토큰 밖까지
          //    뻗는 길이 + 어두운 외곽선 위 흰 심**으로 대비를 만든다 — 팀색은 링·중심점이 말한다.
          const L = FX_STEAL_SLASH_MIN + (FX_STEAL_SLASH_MAX - FX_STEAL_SLASH_MIN) * (1 - a);
          f.drawnSlashL = L;
          ctx.lineCap = "round";
          const slash = (w, style, alpha) => {
            ctx.globalAlpha = alpha; ctx.lineWidth = w; ctx.strokeStyle = style;
            ctx.beginPath();
            ctx.moveTo(cx0 - L, cy0 - L); ctx.lineTo(cx0 + L, cy0 + L);
            ctx.moveTo(cx0 + L, cy0 - L); ctx.lineTo(cx0 - L, cy0 + L);
            ctx.stroke();
          };
          slash(FX_STEAL_SLASH_W + 3.5, "rgba(8,12,24,0.92)", a);          // 어두운 외곽선(잔디·토큰 무관)
          slash(FX_STEAL_SLASH_W, "#ffffff", Math.min(1, a * 1.15));       // 흰 심
          ctx.lineCap = "butt";
        } else if (f.type === "clear") {
          // 걷어내기(#406 W5): 방향이 본질인 행동(위험지역 **밖으로**)이라 링이 아니라 벡터로 그린다.
          // 방향(f.dx,f.dy)은 **실제 공 진행**에서 왔다 — 화면이 지어낸 값이 아니다(spawnClearFx).
          const grow = Math.min(1, FX_CLEAR_GROW_MIN + (1 - a) * 1.6);
          const px = sx(f.x), py = sy(f.y);
          // 쐐기 끝(피치 m) — 화면 좌표는 **이 값에서** 나온다. `f.tip` 으로 노출해 방향 계약이
          // "그린 것"을 읽게 한다(#218). 여기 부호를 뒤집으면(=자기 골대로 걷어냄) tip 도 같이
          // 뒤집혀 계약이 죽는다. 밖에서 f.dx 만 읽으면 그 변이가 살아남는다.
          const tipMx = f.x + f.dx * FX_CLEAR_LEN_M * grow, tipMy = f.y + f.dy * FX_CLEAR_LEN_M * grow;
          f.tip = { x: tipMx, y: tipMy };
          const tx = sx(tipMx), ty = sy(tipMy);
          const nx = -f.dy, ny = f.dx; // 법선(피치 좌표) — 쐐기 밑변
          const bw = 1.1;              // 밑변 반폭(m)
          ctx.globalAlpha = a * 0.75;
          ctx.fillStyle = `rgba(${f.rgb},0.35)`;
          ctx.beginPath();
          ctx.moveTo(sx(f.x + nx * bw), sy(f.y + ny * bw));
          ctx.lineTo(tx, ty);
          ctx.lineTo(sx(f.x - nx * bw), sy(f.y - ny * bw));
          ctx.closePath(); ctx.fill();
          ctx.strokeStyle = `rgb(${f.rgb})`; ctx.lineWidth = 2.2;
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(tx, ty); ctx.stroke();
          const ang = Math.atan2(ty - py, tx - px);
          ctx.beginPath();
          ctx.moveTo(tx, ty); ctx.lineTo(tx - 11 * Math.cos(ang - 0.42), ty - 11 * Math.sin(ang - 0.42));
          ctx.moveTo(tx, ty); ctx.lineTo(tx - 11 * Math.cos(ang + 0.42), ty - 11 * Math.sin(ang + 0.42));
          ctx.stroke();
          // 속도선 3줄 — 찬 자리 뒤쪽으로.
          ctx.lineWidth = 1.6;
          const bx = -Math.cos(ang), by = -Math.sin(ang), pxn = -by, pyn = bx;
          for (let k = -1; k <= 1; k++) {
            ctx.beginPath();
            ctx.moveTo(px + bx * 11 + pxn * k * 5, py + by * 11 + pyn * k * 5);
            ctx.lineTo(px + bx * 24 + pxn * k * 5, py + by * 24 + pyn * k * 5);
            ctx.stroke();
          }
        } else if (f.type === "tackle") {
          // 태클 성공(#406 W5): 모양은 방사 스파크, 색은 **태클한 팀**. 종전엔 무채색 토스트뿐이라
          // "누가 뺏었나"가 화면에 없었다. 각도는 고정(난수 없음).
          ctx.globalAlpha = a * 0.95; ctx.strokeStyle = `rgb(${f.rgb})`; ctx.lineWidth = 2.6;
          ctx.lineCap = "round";
          const px = sx(f.x), py = sy(f.y), p = 1 - a;
          for (let k = 0; k < FX_TACKLE_SPOKES; k++) {
            const ang = (k / FX_TACKLE_SPOKES) * Math.PI * 2 + 0.2;
            const r0 = 11 + 12 * p, r1 = r0 + 8 * a + 4;
            ctx.beginPath();
            ctx.moveTo(px + Math.cos(ang) * r0, py + Math.sin(ang) * r0);
            ctx.lineTo(px + Math.cos(ang) * r1, py + Math.sin(ang) * r1);
            ctx.stroke();
          }
          ctx.lineCap = "butt";
        } else if (f.type === "surge") {
          ctx.globalAlpha = a * 0.7; ctx.strokeStyle = `rgb(${f.rgb})`; ctx.lineWidth = 2.4;
          const Lm = 5, back = f.back;
          for (let k = -1; k <= 1; k++) {
            const oy = k * 1.5;
            ctx.beginPath();
            ctx.moveTo(sx(f.x), sy(f.y + oy));
            ctx.lineTo(sx(f.x + back * Lm), sy(f.y + oy));
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    // 골 세리머니 색종이
    if (confetti.length) {
      for (const c of confetti) { ctx.globalAlpha = Math.max(0, c.life); ctx.fillStyle = c.col; ctx.fillRect(c.x, c.y, 4, 4); }
      ctx.globalAlpha = 1;
    }

    // 상황 배너(DOM=호스트) + 액션 토스트(캔버스)
    drawAnnos(A.tick);
    updateHud(A);
  }

  /**
   * 프레임 상태 진행(감쇠·전진·소멸) — **`draw()` 에서 분리했다**(#406 W5 수리).
   *
   * 종전엔 감쇠가 그리기 안에 섞여 있어 `draw()` 가 호출될 때마다 이펙트가 늙었다. 그러면
   * **같은 상태를 두 번 그려 픽셀을 비교하는 일이 원리적으로 불가능**하다 — "이 이펙트가 화면에
   * 실제로 뭔가를 바꿨나"(가시성 하한 계약)를 재려면 두 프레임에서 이펙트 말고는 전부 같아야 한다.
   * `skin.spec.ts` 가 "같은 틱 재렌더 = 바이트 동일"을 전제하는 것과 같은 축이다.
   *
   * 호출은 rAF 루프 **한 곳**뿐 = 프레임당 정확히 한 번. seek·선택 주입 등이 부르는 부수적
   * `draw()` 는 이제 시간을 흘리지 않는다(종전보다 옳다).
   */
  function stepFx() {
    if (shotFx.length) {
      for (const f of shotFx) { f.r += 1.6; f.life -= 0.045; }
      shotFx = shotFx.filter((f) => f.life > 0);
    }
    if (fx.length) {
      for (const f of fx) {
        f.life -= FX_DECAY[f.type] ?? 0.09;
        if (f.r != null) f.r += f.type === "steal" ? 2.4 : 1.3;
      }
      fx = fx.filter((f) => f.life > 0);
    }
    if (confetti.length) {
      for (const c of confetti) { c.x += c.vx; c.y += c.vy; c.vy += 0.16; c.life -= 0.012; }
      confetti = confetti.filter((c) => c.life > 0);
    }
  }

  function drawAnnos(curTick) {
    lastToasts = [];
    let banner = null;
    for (const a of annos) if (a.kind === "banner" && curTick >= a.tick && curTick <= a.tick + BANNER_TICKS) banner = a;
    if (banner) cb("onBanner", banner.text, banner.col); else cb("onBanner", null, null);
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "bold 15px sans-serif";
    // #69 BL-1(→#406 W5 재해석): 겹치는 토스트는 세로로 밀어낸다.
    // 판정 축은 **틱이 아니라 화면 근접**이다 — 종전 키(`틱:팀:앵커`)는 틱이 다르면 절대 스택하지
    // 않아, 토스트가 TOAST_TICKS 동안 살아 있는 성질과 결합해 "같은 선수 위 인접 틱"이 통째로
    // 겹쳤다(TOAST_NEAR_* 주석 참조). 배치 순서는 `annos` 순서 = 결정론이라 같은 틱 재렌더는
    // 같은 그림이다(`skin.spec.ts` 전제 유지).
    const placed = [];
    for (const a of annos) {
      if (a.kind !== "toast") continue;
      const age = curTick - a.tick;
      if (age < 0 || age > TOAST_TICKS) continue;
      const s = snapByTick.get(a.at); if (!s) continue;
      const prog = age / TOAST_TICKS;
      let ax = s.ball.x, ay = s.ball.y;
      if (a.anchor) {
        // #324: 팀이 실려 있으면 팀까지 맞춰 앵커(중복 playerId 에서 상대팀 선수에 붙던 것).
        const pl = s.players.find((p) => p.playerId === a.anchor && (!a.anchorTeam || p.team === a.anchorTeam));
        if (pl) { ax = pl.pos.x; ay = pl.pos.y; }
      }
      const px = sx(ax);
      const py0 = sy(ay) - 18 - prog * 22;   // 밀어내기 **전** 자리(앵커 기준) — 아래 읽기 표면.
      let py = py0;
      // 이미 놓인 토스트와 겹치면 **가장 아래 것 위로** 올린다. 매 반복 py 가 TOAST_STACK_GAP
      // 이상 줄어드는 것이 보장되므로 종료한다(상한은 방어).
      for (let guard = 0; guard < TOAST_STACK_MAX; guard++) {
        let lowest = null;
        for (const q of placed) {
          if (Math.abs(q.px - px) >= TOAST_NEAR_DX || Math.abs(q.py - py) >= TOAST_NEAR_DY) continue;
          if (!lowest || q.py > lowest.py) lowest = q;
        }
        if (!lowest) break;
        py = Math.min(lowest.py, py) - TOAST_STACK_GAP;
      }
      // 팀색 토스트(#406 W5, 요구 4-2 "어느 팀 행동인지"). 색 SoT 는 `teamRgb` 하나 — playback 은
      // `team` 만 싣고 여기서 칠한다(팔레트를 두 곳에 적으면 조용히 갈라진다). 팀 없으면 종전 col.
      const col = a.team ? `rgb(${teamRgb(a.team)})` : a.col;
      ctx.globalAlpha = 1 - prog;
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.85)"; ctx.strokeText(a.text, px, py);
      ctx.fillStyle = col; ctx.fillText(a.text, px, py);
      ctx.globalAlpha = 1;
      // #324: **실제로 어디에 붙었나**를 계약이 읽을 수 있게(cardMarks 와 같은 규약). 앵커가 팀을
      // 무시하면 중복 playerId 에서 상대팀 선수 위에 뜨는데, 밖에서는 확인할 길이 없었다.
      // `py0` = 밀어내기 전 자리. 이게 있어야 "화면 밖으로 나간 것이 **스택 때문인가**"를 밖에서
      // 가를 수 있다 — 앵커 자체가 위쪽 터치라인이면 종전부터 py<0 이었고(그건 #406 W5 밖의
      // 선행 성질이다) 스택 계약이 그 선행분에 걸리면 신호가 죽는다.
      const rec = { text: a.text, anchor: a.anchor || null, anchorTeam: a.anchorTeam || null, col, px, py, py0 };
      placed.push(rec);
      lastToasts.push(rec);
    }
  }

  function scoreAt(tick) {
    let h = 0, a = 0;
    for (const e of log.events) if (e.type === "goal" && e.tick <= tick) (e.team === "home" ? h++ : a++);
    return { h, a };
  }

  // 골 거대 자막(#flash=호스트 DOM) + 색종이(캔버스=코어).
  function bigCaption(text, col, withConfetti) {
    cb("onBigCaption", text, col);
    if (withConfetti) {
      const cols = ["#22c55e", "#fde047", "#3b82f6", "#ef4444", "#ffffff"];
      for (let n = 0; n < 90; n++) {
        const ang = Math.random() * Math.PI * 2, spd = 2 + Math.random() * 7;
        confetti.push({ x: canvas.width / 2, y: canvas.height / 2, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - 3, life: 1, col: cols[n % cols.length] });
      }
    }
  }
  const teamRgb = (side) => (side === "home" ? "59,130,246" : side === "away" ? "239,68,68" : "203,213,225");
  /**
   * 행동 이펙트의 팀(#406 W5). **이벤트의 `team` 이 SoT** — `playerId[0] === "H"` 추측은 실경기
   * id("P077")에서 항상 away 로 읽힌다(#242/#324 와 같은 뿌리). 팀이 없는 구 로그만 스냅샷 소유팀.
   */
  const fxSideOf = (ev, snap) => ev.side || ownerSideOf(snap) || null;
  /**
   * 행동 이펙트 앵커(m) — 그 틱 스냅샷에서 (팀, playerId) 로 행동 주체를 찾는다. 못 찾으면 공.
   * 팀까지 맞추는 이유는 같은 playerId 가 양 팀에 있기 때문(#324) — 단독 키면 반대편에 붙는다.
   */
  function fxAnchor(snap, ev) {
    if (ev.playerId) {
      const p = snap.players.find((q) => q.playerId === ev.playerId && (!ev.side || q.team === ev.side));
      if (p) return { x: p.pos.x, y: p.pos.y };
    }
    return { x: snap.ball.x, y: snap.ball.y };
  }
  function spawnPassFx(pe) {
    const ss = snapByTick.get(pe.tick); if (!ss) return;
    // `pass` 는 **도착 틱에 리시버 playerId** 로 발행된다(contest.ts) → 이 이펙트는 "받았다"다.
    // 그래서 공이 아니라 **리시버 위에** 앵커한다(수축 링이 조여 드는 자리 = 받은 선수).
    const at = fxAnchor(ss, pe);
    fx.push({ type: "pass", x: at.x, y: at.y, rgb: teamRgb(fxSideOf(pe, ss)), life: 1 });
  }
  function spawnInterceptFx(ie) {
    const ss = snapByTick.get(ie.tick); if (!ss) return;
    const at = fxAnchor(ss, ie);
    fx.push({ type: "steal", x: at.x, y: at.y, rgb: teamRgb(fxSideOf(ie, ss)), r: 0, life: 1 });
  }
  function spawnClearFx(ce) {
    const ss = snapByTick.get(ce.tick); if (!ss) return;
    const side = fxSideOf(ce, ss);
    const at = fxAnchor(ss, ce);
    // 방향은 **실제 공 진행**에서 얻는다(추측 금지 — 화면에만 있는 사실을 만들지 않는다).
    // 다음 스냅샷과의 변위가 없을 때만 팀 전진 방향으로 떨어진다.
    const i = idxOfTick(ce.tick);
    const nx = snaps[Math.min(i + 1, snaps.length - 1)];
    let dx = nx ? nx.ball.x - ss.ball.x : 0, dy = nx ? nx.ball.y - ss.ball.y : 0;
    const d = Math.hypot(dx, dy);
    if (d < 0.5) { dx = side === "away" ? -1 : 1; dy = 0; } else { dx /= d; dy /= d; }
    fx.push({ type: "clear", x: at.x, y: at.y, dx, dy, rgb: teamRgb(side), life: 1 });
  }
  function spawnTackleFx(te) {
    const ss = snapByTick.get(te.tick); if (!ss) return;
    const at = fxAnchor(ss, te);
    fx.push({ type: "tackle", x: at.x, y: at.y, rgb: teamRgb(fxSideOf(te, ss)), life: 1 });
  }
  function spawnSurgeFx(tick) {
    const ss = snapByTick.get(tick); if (!ss) return;
    const side = ownerSideOf(ss);
    fx.push({ type: "surge", x: ss.ball.x, y: ss.ball.y, rgb: teamRgb(side), back: side === "away" ? 1 : -1, life: 1 });
  }
  // 상황 카드(#situation=호스트 DOM).
  function situationCaption(text, col) { cb("onSituation", text, col); }

  // F1(#100): 실시간 통계 — 현재 틱까지 누적. 코어가 수치를 계산해 호스트가 HUD 그리드를 그린다.
  function renderHud(idx, tick) {
    if (!log) return;
    const st = liveEventStats(log.events, tick);
    const posH = possessionPct(cumPoss.cumHome, cumPoss.cumAway, idx);
    const m = momentum(cumPoss.cumHome, cumPoss.cumAway, idx, 30);
    cb("onHud", { home: st.home, away: st.away, possHome: posH, momentum: m });
  }
  function updateHud(snap) {
    const s = scoreAt(snap.tick);
    cb("onScore", s.h, s.a);
    if (snap.tick !== lastHudTick) { lastHudTick = snap.tick; renderHud(Math.min(Math.floor(tickPos), snaps.length - 1), snap.tick); }
    const lastTick = snaps.length ? snaps[snaps.length - 1].tick : 0;
    cb("onMinute", mmss(snap.tick));
    cb("onClock", `${mmss(snap.tick)} / ${mmss(lastTick)}`);
    cb("onScrub", ((tickPos / (snaps.length - 1)) * 100));
    cb("onTick", snap.tick); // 원시 플레이헤드 틱 — 호스트가 통계/로그/시계 "지금까지"를 계산.
  }

  // #65 렌더 루프 방어: 한 프레임 예외가 rAF 체인을 영구히 끊지 않게.
  function tickLoop(ts) {
    try { tickLoopInner(ts); }
    catch (e) { console.error("tickLoop error:", e); rafId = requestAnimationFrame(tickLoop); }
  }
  function tickLoopInner(ts) {
    if (!lastTs) lastTs = ts;
    const dt = (ts - lastTs) / 1000; lastTs = ts;
    frameDt = dt;
    stepFx(); // 프레임당 정확히 한 번 — 그리기는 상태를 바꾸지 않는다(stepFx 주석).
    if (hold) {
      if (hold.koIdx != null) {
        hold.tween = Math.min(1, (ts - hold.start) / hold.dur);
        if (hold.tween > 0.4) hold.zoom = false;
      }
      if (ts < hold.until) { draw(); rafId = requestAnimationFrame(tickLoop); return; }
      cb("onClearCaptions"); confetti = [];
      tickPos = hold.jumpTo; hold = null;
    }
    if (playing && snaps.length > 1) {
      const beforeTick = snaps[Math.min(Math.floor(tickPos), snaps.length - 1)].tick;
      const fixMode = viewMode === "fix";
      const nearKey = !fixMode && autoPace && !inSetpieceWait(beforeTick) && inHighlight(beforeTick, keyTicks, HL_PRE, HL_POST);
      // #216: speed 는 연출 페이싱을 **끄는** 대신 그 위에 곱한다(playback.effectiveSpeed).
      const eff = effectiveSpeed(!fixMode && autoPace, nearKey, speed, CRUISE_SPEED, HL_SPEED);
      tickPos += dt * TICKS_PER_SEC * eff;
      if (tickPos >= snaps.length - 1) { tickPos = snaps.length - 1; setPlaying(false); }
      const afterTick = snaps[Math.min(Math.floor(tickPos), snaps.length - 1)].tick;
      for (const shk of shotFxTicks) {
        if (shk > beforeTick && shk <= afterTick) {
          const ss = snapByTick.get(shk); if (ss) shotFx.push({ x: ss.ball.x, y: ss.ball.y, r: 0, life: 1 });
        }
      }
      for (const pe of passEvents) if (pe.tick > beforeTick && pe.tick <= afterTick) spawnPassFx(pe);
      for (const ie of interceptEvents) if (ie.tick > beforeTick && ie.tick <= afterTick) spawnInterceptFx(ie);
      for (const ce of clearanceEvents) if (ce.tick > beforeTick && ce.tick <= afterTick) spawnClearFx(ce);
      for (const te of tackleEvents) if (te.tick > beforeTick && te.tick <= afterTick) spawnTackleFx(te);
      for (const st of surgeTicks) if (st > beforeTick && st <= afterTick) spawnSurgeFx(st);
      for (const st of stoppages) {
        if (!st.done && st.causeTick >= beforeTick && st.causeTick <= afterTick) {
          st.done = true;
          tickPos = idxOfTick(st.causeTick);
          if (st.isGoal) bigCaption(st.big, st.bigCol, true);
          else if (!st.pauseOnly) situationCaption(st.big, st.bigCol);
          const holdMs = st.isGoal ? st.hold : (st.contactAnchor ? FOUL_HOLD_MS : DEADBALL_PAUSE_MS);
          hold = { until: ts + holdMs, start: ts, dur: holdMs, jumpTo: idxOfTick(st.isGoal ? st.restartTick : st.causeTick), zoom: !!st.isGoal, wide: !!st.wide || !!st.pauseOnly || !!st.setPiece };
          if (st.isGoal) { hold.formFrom = idxOfTick(st.causeTick); hold.koIdx = idxOfTick(st.restartTick); hold.tween = 0; }
          break;
        }
      }
    }
    draw();
    rafId = requestAnimationFrame(tickLoop);
  }
  function clearCaptions() {
    confetti = []; shotFx = []; fx = [];
    cb("onClearCaptions");
  }
  function resetStops() { stoppages.forEach((s) => (s.done = false)); hold = null; clearCaptions(); }
  function setPlaying(p) { playing = p; cb("onPlaying", p); }
  function jumpToTick(tick) {
    const idx = snaps.findIndex((s) => s.tick >= tick);
    tickPos = idx < 0 ? snaps.length - 1 : Math.max(0, idx - 3);
    lastGoalShown = scoreAt(snaps[Math.floor(tickPos)].tick).h + scoreAt(snaps[Math.floor(tickPos)].tick).a;
    resetStops();
    draw();
  }
  function jumpEvent(type, dir) {
    const curTick = snaps[Math.min(Math.floor(tickPos), snaps.length - 1)].tick;
    const evs = log.events.filter((e) => e.type === type).map((e) => e.tick);
    const target = dir > 0 ? evs.find((t) => t > curTick + 2) : [...evs].reverse().find((t) => t < curTick - 2);
    if (target != null) jumpToTick(target);
  }

  function togglePlay() { if (tickPos >= snaps.length - 1) { tickPos = 0; resetStops(); } setPlaying(!playing); }
  function restart() { tickPos = 0; lastGoalShown = 0; resetStops(); draw(); }
  function setFollow(b) { follow = !!b; draw(); }
  function setTrail(b) { showTrail = !!b; draw(); }
  function setAutoPace(b) { autoPace = !!b; }
  function setSpeed(n) { speed = parseFloat(n); }
  function setFixZoom(z) { fixZoom = Math.max(1, Math.min(3, Number.isFinite(z) ? z : 1)); draw(); return fixZoom; }
  function setViewMode(mode) { viewMode = mode === "fix" ? "fix" : "auto"; draw(); }
  // 캐릭터 스킨(#145, S3 → #218 멀티 아틀라스).
  //
  //   { atlases:[{url,tile}],           // 아트 시트 여럿(선수 아트가 한 시트에 다 없다)
  //     byPlayer:{ id:{col,row,atlas?,num?,bg?} },
  //     nums:{ id:"7" },                // **셀이 없는 선수의 등번호** — 아래 폴백 참고
  //     atlasUrl, tile }                // 구 단일 아틀라스 계약(그대로 받는다)
  //
  // 왜 여럿인가(#218): 아트 발행이 축별로 나뉘어(캐릭터 원화 / 입고 유닛) 각자 아틀라스를 갖는다.
  // 단일 아틀라스 페이로드였을 땐 한 축이 통째로 빠져 그 선수들만 얼굴 없이 그려졌다.
  // **아틀라스 단위로 열화**한다 — 하나가 404 여도 그 시트를 쓰는 선수만 팀색 토큰이 되고 나머지는 뜬다.
  function setSkin(payload) {
    if (!payload || (!payload.byPlayer && !payload.nums)) { skin = null; return; }
    const list = Array.isArray(payload.atlases) && payload.atlases.length
      ? payload.atlases
      : payload.atlasUrl && payload.tile
        ? [{ url: payload.atlasUrl, tile: payload.tile }]
        : [];
    // 아트가 하나도 없어도 **등번호만 실린 페이로드**는 받는다 — 에셋 미배포에서도 토큰에
    // 선수 id 원문이 찍히는 일이 없게(폴백 보장, #218 AC2).
    if (!list.length && !payload.nums) { skin = null; return; }
    const s = { atlases: [], byPlayer: payload.byPlayer || {}, nums: payload.nums || {}, ready: false };
    for (const a of list) {
      if (!a || !a.url || !a.tile) { s.atlases.push({ img: null, tile: 0, ok: false }); continue; }
      const img = new Image();
      const rec = { img, tile: a.tile, ok: false };
      s.atlases.push(rec);
      // ready 는 "**하나라도** 그릴 수 있다" — 전부를 기다리면 느린 시트 하나가 전체를 멈춰 세운다.
      img.onload = () => { if (skin === s) { rec.ok = true; s.ready = true; } };
      img.onerror = () => { if (skin === s) rec.ok = false; }; // 그 시트 선수만 폴백(전체 무효화 X)
      img.src = a.url;
    }
    skin = s;
  }
  /**
   * 선택 하이라이트 주입 (#406 W4, 요구 5-2). `setSkin`(#145)과 같은 패턴 —
   * **부모가 무엇이 선택됐는지 알고, 코어는 그리기만** 한다.
   *
   *   setSelection([{ team:"home", playerId:"P077", mine:true, label:"손번개(7)" }])
   *   setSelection([])  // 또는 null — 해제
   *
   * - `team` **필수**. 같은 playerId 가 양 팀에 동시에 뛰므로(#324/#231) 키는
   *   `skinKeyOf(team, playerId)` 다. ⚠️ 여기선 `skinLookup` 의 **단독 키 폴백을 일부러 쓰지
   *   않는다** — 스킨은 "못 찾으면 팀색 원"이라 폴백이 무해하지만, 선택은 폴백이 곧
   *   **반대 팀을 켜는 것**이라 fail-closed 가 옳다(팀을 모르면 안 켠다).
   * - `mine` = 내 팀 선수인가(스타일 축) — **3값**이다. `true` 흰 굵은 링 / `false` 슬레이트 실선 /
   *   **`null`·미지정 = 점선**(모른다). 판정은 부모 몫이다(코어는 유저를 모른다).
   *   ⚠️ 종전엔 `s.mine === true` 로 접어 미지정이 **상대 스타일**이 됐는데, 호스트 카드는 같은
   *   상태에서 뱃지를 안 달아(#322) 한 화면의 두 표면이 다른 말을 했다(#406 W6 m6).
   * - `label` = 이름표 문구. 코어는 선수 **이름을 모른다**(도메인 지식 유출 0) — 안 주면
   *   실제로 그린 등번호로 떨어진다.
   */
  function setSelection(list) {
    const arr = Array.isArray(list) ? list : list ? [list] : [];
    const next = new Map();
    for (const s of arr) {
      if (!s || !s.playerId || !s.team) continue;
      next.set(skinKeyOf(s.team, s.playerId), {
        team: s.team,
        playerId: s.playerId,
        mine: s.mine === true ? true : s.mine === false ? false : null,
        label: typeof s.label === "string" && s.label.trim() ? s.label.trim() : null,
      });
    }
    selection = next;
    draw();
  }
  function scrubTo(pct) { tickPos = (parseFloat(pct) / 100) * (snaps.length - 1); lastGoalShown = -1; resetStops(); draw(); }

  function loadLog(data) {
    // #65: 신뢰 경계 밖 주입 대비 — 상태 변경 전 최소 검증(원자성). 실패 시 throw, 기존 상태 유지.
    if (!data || !Array.isArray(data.tickSnapshots) || !Array.isArray(data.events) || !data.finalScore) {
      throw new Error("Invalid MatchLog (tickSnapshots · events · finalScore required)");
    }
    log = data; snaps = data.tickSnapshots;
    keyTicks = data.events.filter((e) => e.type === "goal" || e.type === "penalty" || (e.type === "shot" && e.detail !== "saved" && e.detail !== "off_target")).map((e) => e.tick);
    shotFxTicks = new Set(data.events.filter((e) => e.type === "shot" && e.detail !== "off_target").map((e) => e.tick));
    snapByTick = new Map(snaps.map((s) => [s.tick, s]));
    cumPoss = computeCumulativePossession(snaps); lastHudTick = -1;
    const pb = buildPlayback(data.events, snaps);
    annos = pb.annos; stoppages = pb.stoppages; restartTickSet = pb.restartTicks; ballCutTickSet = pb.ballCutTicks; flightSides = pb.flightSides;
    // 행동 이펙트 소스(#406 W5). **팀·선수는 이벤트가 SoT** — 추측하지 않는다(fxSideOf/fxAnchor).
    const actionEvents = (type) => data.events.filter((e) => e.type === type)
      .map((e) => ({ tick: e.tick, side: e.team || null, playerId: e.playerId || null }));
    passEvents = actionEvents("pass");
    interceptEvents = actionEvents("interception");
    clearanceEvents = actionEvents("clearance");
    tackleEvents = actionEvents("tackle");
    surgeTicks = annos.filter((a) => a.text === "SURGE!").map((a) => a.tick);
    cardMarks = data.events.filter((e) => e.type === "card").map((e) => ({
      tick: e.tick, playerId: e.playerId || null, red: e.detail === "red",
      // #324: 팀은 이벤트가 SoT. 종전 `playerId[0] === "H"` 추측은 실경기 id(P077…)에서
      //       **항상 away** 로 판정됐다(#242 와 같은 패턴의 잔존). 팀이 없는 구 로그만 추측으로.
      side: e.team || (e.playerId ? (e.playerId[0] === "H" ? "home" : "away") : null),
    }));
    clockScale = clockScaleOf(data.events, snaps);
    totalMinutes = snaps.length ? snaps[snaps.length - 1].minute : 0;
    // 새 로그 = 새 라인업. 선택을 들고 가면 **유령 링**이 된다(W4 m-11) — web 은 부모가 `half`
    // 변화로 지워 주지만 코어를 단독으로 쓰는 소비자(QA 셸·하네스)엔 그 부모가 없다.
    selection = new Map();
    tickPos = 0; lastGoalShown = 0;
    const statusText = `Loaded · config ${data.configVersion} · seed ${data.seed} · ${snaps.length} ticks · final ${data.finalScore.home}:${data.finalScore.away} · tip: turn on "Follow ball" and jump with "Next shot"`;
    // 호스트가 티커·타임라인 마크를 그린다(logLines 투영·idxOfTick 사용).
    cb("onLoaded", { events: data.events, snapCount: snaps.length, statusText });
    setPlaying(true);
  }

  // 테스트/QA 훅(Playwright) — DOM 무관 읽기 표면. captions()는 DOM 이라 호스트가 제공.
  const hooks = {
    ready: () => !!log,
    events: () => (log ? log.events : []),
    seek: (tick) => { setPlaying(false); resetStops(); tickPos = idxOfTick(tick); draw(); },
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    autoPace: (on) => { autoPace = on; },
    showSituationAt: (tick) => {
      const st = stoppages.find((s) => s.causeTick === tick);
      setPlaying(false); resetStops(); tickPos = idxOfTick(tick);
      if (st) situationCaption(st.big, st.bigCol);
      draw();
    },
    cur: () => { const s = snaps[Math.floor(tickPos)]; return { tickPosIdx: Math.floor(tickPos), tick: s.tick, ball: s.ball, ballOwner: s.ballOwner, follow }; },
    render: () => (lastRender ? { ...lastRender } : null),
    renderAt: (tp) => { setPlaying(false); resetStops(); tickPos = tp; draw(); return lastRender ? { ...lastRender } : null; },
    screenGeom: () => (lastGeom ? JSON.parse(JSON.stringify(lastGeom)) : null),
    renderPlayersAt: (tp) => { setPlaying(false); resetStops(); tickPos = tp; draw(); return lastPlayers.map((p) => ({ ...p })); },
    curPlayers: () => lastPlayers.map((p) => ({ ...p })),
    trail: () => lastTrail.map((t) => ({ ...t })),
    playerTrailAt: (tick) => { setPlaying(false); resetStops(); tickPos = idxOfTick(tick); draw(); return lastPlayerTrail.map((t) => ({ ...t })); },
    // #406 W5: x/y(피치 m)는 **순수 추가**다 — 앵커 계약(이펙트가 행동 주체 위에 떴나)이 밖에서
    // 확인 가능해야 하고, 없으면 앵커를 공으로 되돌려도 아무 계약이 안 깨진다(#324 의 교훈).
    // `r`·`tip`·`slashL` 은 **draw() 가 실제로 쓴 값**이다(#218 "그린 쪽이 알려준다"). 밖에서
    // 같은 공식을 다시 적으면 그리기를 뒤집어도 계약이 안 깨진다 — 실제로 W5 초판엔 모양 축
    // 계약이 없어 "쐐기를 정확히 반대로"(자기 골대로 걷어냄) 변이가 통과했다.
    fx: () => fx.map((f) => ({
      type: f.type, rgb: f.rgb, x: f.x, y: f.y,
      r: f.drawnR ?? null,                                   // 그린 링 반경(px) — 수신=감소 / 가로챔=증가
      tip: f.tip ? { x: f.tip.x, y: f.tip.y } : null,        // 걷어내기 쐐기 끝(피치 m)
      slashL: f.drawnSlashL ?? null,                         // 가로챔 X 반팔 길이(px)
    })),
    // 가시성 하한 계약(#406 W5 MAJOR-2 수리) — fx 레이어**만** 끄고 같은 상태를 두 번 그려
    // "토큰 원판 바깥에서 픽셀이 바뀌었나"를 잰다. 스폰·감쇠는 건드리지 않는다(stepFx 가 소유).
    setFxLayer: (on) => { fxLayerOn = on !== false; },
    fxLayer: () => fxLayerOn,
    /** 상태를 바꾸지 않고 현재 상태를 다시 그린다(seek/renderAt 과 달리 resetStops 없음). */
    redraw: () => { draw(); },
    /*
     * 플레이헤드**만** 옮긴다 — `seek`/`renderAt` 과 달리 `resetStops()` 를 부르지 않는다
     * (그 함수는 `clearCaptions()` 를 거쳐 **`fx = []`** 로 이펙트를 지운다).
     *
     * 왜 필요한가: 이펙트 픽셀 계약(`action-effects.spec.ts`)은 **이펙트가 살아 있는 상태**에서
     * 앵커 토큰 좌표를 재는데, 스폰 감지는 rAF 프레임을 세지만 `tickPos` 는 **벽시계 `dt`** 로
     * 흐른다(`tickLoopInner`). 그래서 "스폰을 본 순간"의 플레이헤드가 부하에 따라 프레임 안쪽
     * 어딘가로 떨어져 앵커가 서브픽셀만큼 움직이고 래스터화가 갈렸다 — 콜드 13회 중 2회 red
     * (#406 W10 B-1). 이펙트를 죽이지 않고 플레이헤드를 스냅샷 인덱스에 정확히 앉힐 수단이
     * 없어서 생긴 플레이키였다.
     *
     * `redraw` 와 같은 축의 **측정 심**이다(그리기는 시간을 흘리지 않는다 — `stepFx` 주석).
     */
    pinPlayhead: (tp) => { tickPos = tp; draw(); },
    /*
     * 공 따라가기(팔로우 줌) — **읽기 표면에 있어야 계약이 실사용 기하를 재현할 수 있다**
     * (#406 W4/W5 독립검증 MAJOR-1). 게임 화면은 하이라이트 창에서 `nearKey` 로 이 상태에 들고
     * (토큰 `R=11`), 종전 계약은 `autoPace(false)` 로 재서 **와이드(`R=8`)만** 검사했다. 컨트롤러엔
     * 이미 있던 것을 훅에도 내는 것이라 동작 변경은 없다.
     */
    setFollow: (on) => setFollow(on),
    follow: () => follow,
    surgeTicks: () => surgeTicks.slice(),
    cardMarks: () => lastCardMarks.map((c) => ({ ...c })),
    toasts: () => lastToasts.map((t) => ({ ...t })),
    liveStats: () => {
      const idx = Math.min(Math.floor(tickPos), snaps.length - 1);
      const tick = snaps[idx].tick;
      return { tick, ...liveEventStats(log.events, tick), possessionHome: possessionPct(cumPoss.cumHome, cumPoss.cumAway, idx), momentum: momentum(cumPoss.cumHome, cumPoss.cumAway, idx, 30) };
    },
    trailAt: (tick) => { setPlaying(false); resetStops(); tickPos = idxOfTick(tick); draw(); return lastTrail.map((t) => ({ ...t })); },
    cam: () => ({ cx: cam.cx, cy: cam.cy, zoom: cam.zoom }),
    viewMode: () => viewMode,
    setViewMode: (m) => setViewMode(m),
    fixZoom: () => fixZoom,
    setFixZoom: (z) => setFixZoom(z),
    idxOfTick: (tick) => idxOfTick(tick),
    // 캐릭터 스킨(#145, S3) — 주입/준비 상태 훅(계약검증용). setSkin(null) 로 비활성.
    setSkin: (payload) => setSkin(payload),
    skinReady: () => !!(skin && skin.ready),
    // 선수 하이라이트(#406 W4). `selection()` 은 **이 프레임에 실제로 그린** 링만 돌려준다 —
    // 주입값을 되읽으면 "그렸다"가 아니라 "달라고 했다"를 검사하게 된다(#324 의 교훈).
    setSelection: (list) => setSelection(list),
    selection: () =>
      lastPlayers
        .filter((p) => p.selected)
        // `mine` 은 **3값**이다(true/false/null). `!!` 로 접으면 "모른다"가 "상대"로 읽힌다(m6).
        .map((p) => ({
          id: p.id, team: p.team,
          mine: p.selectMine === true ? true : p.selectMine === false ? false : null,
          r: p.selectR, label: p.selectLabel, px: p.px, py: p.py,
        })),
  };

  function start() { drawPitch(); rafId = requestAnimationFrame(tickLoop); }
  // 마운트 해제(React unmount·half 전환) 시 rAF 루프 정지 — 좀비 루프/누수 방지.
  function stop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } playing = false; }

  return {
    start, stop, load: loadLog,
    play: () => setPlaying(true), pause: () => setPlaying(false), togglePlay,
    restart, scrubTo, jumpToTick, jumpEvent,
    setFollow, setTrail, setAutoPace, setSpeed, setViewMode, setFixZoom, setSkin, setSelection,
    hooks,
  };
}
