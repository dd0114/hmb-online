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

import { buildPlayback, spansReposition, inHighlight } from "./playback.mjs";
import { liveEventStats, computeCumulativePossession, possessionPct, momentum } from "./stats.impl.mjs";

export function createViewer(canvas, chrome = {}) {
  const ctx = canvas.getContext("2d");
  // chrome 콜백 안전 호출(호스트가 일부만 제공해도 무방).
  const cb = (name, ...args) => { const f = chrome[name]; if (f) f(...args); };

  // ===== 튜닝 상수(구 index.html 인라인과 동일) =====
  const PITCH_W = 105, PITCH_H = 68, MARGIN = 30; // MARGIN=피치 둘레 여백px(경계 위 taker·공이 안 잘리게).
  const FOLLOW_ZOOM = 2.6;                 // 공 따라가기 확대율
  const CONTACT_ZOOM = 2.6, FOUL_CONTACT_TICKS = 3; // 파울 접촉 순간 줌 + 지속 틱
  const FOUL_HOLD_MS = 1000; // 파울/페널티 정지는 길게(줌 완료+충돌 여유)
  const CAM_SMOOTH = 0.12;                 // 정지 중 카메라 팬 속도(0..1/frame)
  const CAM_MAX_PAN_PXPS = 900;            // #45: 카메라 팬 속도 상한(스크린px/s)
  const CAM_MAX_ZOOM_PS = 2.2;             // #45: 줌 변화 속도 상한(zoom/s)
  const DEADBALL_PAUSE_MS = 450;           // #59: 데드볼 자막 짧은 정지 후 정상 재생
  const BALL_TRAIL = 6, PLAYER_TRAIL = 10; // 잔상 길이(틱)
  const TICKS_PER_SEC = 2;                  // 1x = 2 게임초/실초
  const CRUISE_SPEED = 4, HL_SPEED = 1;     // 하이라이트 자동페이싱: 빌드업 4x → 찬스 1x
  const HL_PRE = 8, HL_POST = 3;            // #83 하이라이트 창 비대칭
  const TOAST_TICKS = 5, BANNER_TICKS = 16, CARD_SHOW_TICKS = 12; // 자막/카드 마커 지속(틱)

  // ===== 상태 =====
  let log = null, snaps = [], playing = false, speed = 1, tickPos = 0, lastTs = 0;
  let follow = false, showTrail = true, autoPace = true, keyTicks = [], confetti = [];
  let viewMode = "auto", fixZoom = 1;      // #114 뷰 모드
  let shotFx = [], shotFxTicks = new Set(); // 유효슛 링 이펙트
  let fx = [], passEvents = [], interceptEvents = [], surgeTicks = [];
  let cardMarks = [], lastCardMarks = [];   // R4(#100): 카드 받은 선수 표시
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
  const ownerSideOf = (o) => (o ? (o[0] === "H" ? "home" : "away") : null);
  const idxOfTick = (tick) => { const i = snaps.findIndex((s) => s.tick >= tick); return i < 0 ? snaps.length - 1 : i; };
  const mmss = (t) => `${Math.floor(t / 60)}'${String(Math.floor(t % 60)).padStart(2, "0")}"`;

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
      if (st.isGoal || !st.setPiece || tick < st.causeTick || tick > st.causeTick + 32) continue;
      const cs = snapByTick.get(st.causeTick), now = snapByTick.get(tick);
      if (cs && now && Math.hypot(now.ball.x - cs.ball.x, now.ball.y - cs.ball.y) < 3) return true;
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
      const pl = csnap && csnap.players.find((p) => p.playerId === st.contactAnchor);
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
    const segSideAt = (s) => ownerSideOf(snaps[s].ballOwner) || flightSides.get(snaps[s].tick) || null;
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
    const koById = koSnap ? new Map(koSnap.players.map((q) => [q.playerId, q.pos])) : null;
    const ptw = koSnap ? hold.tween * hold.tween * (3 - 2 * hold.tween) : 0; // smoothstep
    const playerRender = [];
    const pt = spansReposition(A.tick, B.tick, restartTickSet) ? 0 : t;
    for (let k = 0; k < A.players.length; k++) {
      const pa = A.players[k], pb = B.players[k] || pa;
      let x = lerp(pa.pos.x, pb.pos.x, pt), y = lerp(pa.pos.y, pb.pos.y, pt);
      if (koById) {
        const kp = koById.get(pa.playerId);
        if (kp) { x = lerp(pa.pos.x, kp.x, ptw); y = lerp(pa.pos.y, kp.y, ptw); }
      }
      const isHome = pa.team === "home", owner = A.ballOwner === pa.playerId;
      playerRender.push({ id: pa.playerId, x, y });
      const px = sx(x), py = sy(y);
      // 캐릭터 스킨(#145, S3): setSkin 으로 아틀라스가 주입됐고 이 선수 셀이 있으면 얼굴 아바타 +
      // 팀색 링/디스크/번호 뱃지로 그린다. 없으면(QA·미주입·로드전) 현행 단색 원(무회귀).
      const cell = skin && skin.ready && skin.byPlayer[pa.playerId];
      const num = (cell && cell.num) || pa.playerId.replace(/[HA]/, "");
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
        ctx.drawImage(skin.img, cell.col * skin.tile, cell.row * skin.tile, skin.tile, skin.tile,
          px - _S / 2, py - _S / 2, _S, _S);
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
      const pr = playerRender.find((p) => p.id === cm.playerId);
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
      const label = `#${cm.num}`;
      ctx.font = "bold 14px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      const lx = ix + iw + 3, ly = iy + ih / 2;
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.9)"; ctx.strokeText(label, lx, ly);
      ctx.fillStyle = cardCol; ctx.fillText(label, lx, ly);
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      lastCardMarks.push({ playerId: cm.playerId, num: cm.num, red: cm.red, side: cm.side, px, py });
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
      for (const f of shotFx) { f.r += 1.6; f.life -= 0.045; }
      shotFx = shotFx.filter((f) => f.life > 0);
      for (const f of shotFx) {
        ctx.globalAlpha = Math.max(0, f.life) * 0.9;
        ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(sx(f.x), sy(f.y), 6 + f.r, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // R2 재미 이펙트: 패스완성·가로챔·돌파.
    if (fx.length) {
      for (const f of fx) {
        f.life -= f.type === "steal" ? 0.05 : f.type === "surge" ? 0.06 : 0.09;
        if (f.r != null) f.r += f.type === "steal" ? 2.4 : 1.3;
      }
      fx = fx.filter((f) => f.life > 0);
      for (const f of fx) {
        const a = Math.max(0, f.life);
        if (f.type === "pass") {
          ctx.globalAlpha = a * 0.6; ctx.strokeStyle = `rgb(${f.rgb})`; ctx.lineWidth = 2.2;
          ctx.beginPath(); ctx.arc(sx(f.x), sy(f.y), 8 + f.r, 0, Math.PI * 2); ctx.stroke();
        } else if (f.type === "steal") {
          ctx.globalAlpha = a * 0.9; ctx.strokeStyle = `rgb(${f.rgb})`; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(sx(f.x), sy(f.y), 5 + f.r, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = a * 0.45; ctx.fillStyle = `rgb(${f.rgb})`;
          ctx.beginPath(); ctx.arc(sx(f.x), sy(f.y), 4.5, 0, Math.PI * 2); ctx.fill();
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
      for (const c of confetti) { c.x += c.vx; c.y += c.vy; c.vy += 0.16; c.life -= 0.012; }
      confetti = confetti.filter((c) => c.life > 0);
      for (const c of confetti) { ctx.globalAlpha = Math.max(0, c.life); ctx.fillStyle = c.col; ctx.fillRect(c.x, c.y, 4, 4); }
      ctx.globalAlpha = 1;
    }

    // 상황 배너(DOM=호스트) + 액션 토스트(캔버스)
    drawAnnos(A.tick);
    updateHud(A);
  }

  function drawAnnos(curTick) {
    let banner = null;
    for (const a of annos) if (a.kind === "banner" && curTick >= a.tick && curTick <= a.tick + BANNER_TICKS) banner = a;
    if (banner) cb("onBanner", banner.text, banner.col); else cb("onBanner", null, null);
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "bold 15px sans-serif";
    // #69 BL-1: 같은 틱·같은 앵커 동시 토스트는 세로 스택 오프셋으로 겹침 방지.
    const toastRow = new Map();
    for (const a of annos) {
      if (a.kind !== "toast") continue;
      const age = curTick - a.tick;
      if (age < 0 || age > TOAST_TICKS) continue;
      const s = snapByTick.get(a.at); if (!s) continue;
      const prog = age / TOAST_TICKS;
      let ax = s.ball.x, ay = s.ball.y;
      if (a.anchor) { const pl = s.players.find((p) => p.playerId === a.anchor); if (pl) { ax = pl.pos.x; ay = pl.pos.y; } }
      const key = `${a.at}:${a.anchor || "ball"}`;
      const row = toastRow.get(key) || 0; toastRow.set(key, row + 1);
      const px = sx(ax), py = sy(ay) - 18 - prog * 22 - row * 17;
      ctx.globalAlpha = 1 - prog;
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.85)"; ctx.strokeText(a.text, px, py);
      ctx.fillStyle = a.col; ctx.fillText(a.text, px, py);
      ctx.globalAlpha = 1;
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
  function spawnPassFx(pe) {
    const ss = snapByTick.get(pe.tick); if (!ss) return;
    fx.push({ type: "pass", x: ss.ball.x, y: ss.ball.y, rgb: teamRgb(pe.side), r: 0, life: 1 });
  }
  function spawnInterceptFx(ie) {
    const ss = snapByTick.get(ie.tick); if (!ss) return;
    fx.push({ type: "steal", x: ss.ball.x, y: ss.ball.y, rgb: teamRgb(ie.side), r: 0, life: 1 });
  }
  function spawnSurgeFx(tick) {
    const ss = snapByTick.get(tick); if (!ss) return;
    const side = ownerSideOf(ss.ballOwner);
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
      const eff = (!fixMode && autoPace) ? (nearKey ? HL_SPEED : CRUISE_SPEED) : speed;
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
  // 캐릭터 스킨(#145, S3): {atlasUrl, tile, byPlayer:{playerId:{col,row,num?}}} → 아틀라스 로드.
  // 로드 전/실패/미주입이면 draw 가 단색 원으로 폴백(무회귀). QA(dev-viewer)는 호출하지 않는다.
  function setSkin(payload) {
    if (!payload || !payload.atlasUrl || !payload.tile || !payload.byPlayer) { skin = null; return; }
    const img = new Image();
    const s = { img, tile: payload.tile, byPlayer: payload.byPlayer, ready: false };
    img.onload = () => { s.ready = true; };
    img.onerror = () => { if (skin === s) skin = null; };
    img.src = payload.atlasUrl;
    skin = s;
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
    passEvents = data.events.filter((e) => e.type === "pass").map((e) => ({ tick: e.tick, side: e.team || null, playerId: e.playerId || null }));
    interceptEvents = data.events.filter((e) => e.type === "interception").map((e) => ({ tick: e.tick, side: e.team || null }));
    surgeTicks = annos.filter((a) => a.text === "SURGE!").map((a) => a.tick);
    cardMarks = data.events.filter((e) => e.type === "card").map((e) => ({
      tick: e.tick, playerId: e.playerId || null, red: e.detail === "red",
      num: e.playerId ? e.playerId.replace(/[HA]/, "") : "?", side: e.playerId ? (e.playerId[0] === "H" ? "home" : "away") : null,
    }));
    totalMinutes = snaps.length ? snaps[snaps.length - 1].minute : 0;
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
    fx: () => fx.map((f) => ({ type: f.type, rgb: f.rgb })),
    surgeTicks: () => surgeTicks.slice(),
    cardMarks: () => lastCardMarks.map((c) => ({ ...c })),
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
  };

  function start() { drawPitch(); rafId = requestAnimationFrame(tickLoop); }
  // 마운트 해제(React unmount·half 전환) 시 rAF 루프 정지 — 좀비 루프/누수 방지.
  function stop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } playing = false; }

  return {
    start, stop, load: loadLog,
    play: () => setPlaying(true), pause: () => setPlaying(false), togglePlay,
    restart, scrubTo, jumpToTick, jumpEvent,
    setFollow, setTrail, setAutoPace, setSpeed, setViewMode, setFixZoom, setSkin,
    hooks,
  };
}
