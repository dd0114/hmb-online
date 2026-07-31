/**
 * 무리빌드 튜닝 하네스 — UI (#377 M0-1)
 *
 * 렌더는 **@hmb/viewer-core 가 소유한다**(SoT). 이 파일은 캔버스에 아무것도 그리지 않는다 —
 * 코어를 마운트하고 DOM 크롬(스코어·자막·핀 스트립·요약표)만 제공한다. dev-viewer 셸과 같은 규율.
 * viewer-core 의 런타임(.mjs)은 브라우저 안전한 순수 ESM 이라 **빌드 없이** 서버가 그대로 서빙한다.
 */
import { createViewer } from "/vendor/viewer.impl.mjs";
import { clockScaleOf } from "/vendor/playback.mjs";

const $ = (id) => document.getElementById(id);

/**
 * 시계 — **코어와 같은 스케일**을 쓴다. 엔진 하프는 45분인데 표기는 0–90분이라(#365) 원시 틱을
 * 그대로 mm:ss 로 찍으면 뷰어 시계와 **2배 어긋난다**. 실제로 첫 캡처에서 이벤트 목록은 7'56",
 * 뷰어 시계는 15'46" 를 가리켜 "점프가 엉뚱한 데로 간다"로 오독했다. 스케일은 로그가 정한다
 * (`clockScaleOf` = playback.mjs 의 SoT).
 */
let clockScale = 1;
const fmt = (tick) => {
  const t = tick * clockScale;
  return `${Math.floor(t / 60)}'${String(Math.floor(t % 60)).padStart(2, "0")}"`;
};

let META = null;
let lastRun = null; // A/B 대조 — 직전 런의 집계
let tiles = []; // {match, viewer, canvas}
let focusViewer = null;
let focusMatch = null;

// ── 부트 ────────────────────────────────────────────────────────────────
const meta = await (await fetch("/api/meta")).json();
META = meta;
$("ver").textContent = `${meta.engineVersion} · 하프 ${meta.matchMinutes}분(표기 ${meta.displayMinutes ?? meta.matchMinutes}) · 산출물 ${meta.runHome}`;

$("source").innerHTML = meta.sources
  .map((s) => `<option value="${s.id}">${s.label}</option>`)
  .join("");
$("source").onchange = () => {
  const s = meta.sources.find((x) => x.id === $("source").value);
  $("srcNote").textContent = s?.note || "";
};
$("source").onchange();

// 노브 — 기본값을 채워 넣고, 바뀐 것만 오버라이드로 보낸다.
$("knobs").innerHTML = meta.knobs
  .map(
    (k, i) => `<div class="knob" data-path="${k.path}">
      <div class="kl" title="${k.path}${k.note ? " — " + k.note : ""}">${k.label}<small>${k.path}</small></div>
      <input id="knob${i}" type="number" step="any" value="${k.value}" data-default="${k.value}" />
    </div>`,
  )
  .join("");
for (const inp of document.querySelectorAll("#knobs input")) {
  inp.oninput = () => {
    inp.closest(".knob").classList.toggle("changed", inp.value !== inp.dataset.default);
  };
}

$("reset").onclick = () => {
  for (const inp of document.querySelectorAll("#knobs input")) {
    inp.value = inp.dataset.default;
    inp.closest(".knob").classList.remove("changed");
  }
  $("raw").value = "";
};

/** 화면의 노브 + 자유 JSON → 서버로 보낼 오버라이드 맵. 기본값과 같은 노브는 보내지 않는다. */
function collectOverrides() {
  const ov = {};
  for (const el of document.querySelectorAll("#knobs .knob")) {
    const inp = el.querySelector("input");
    if (inp.value === inp.dataset.default || inp.value === "") continue;
    ov[el.dataset.path] = Number(inp.value);
  }
  const raw = $("raw").value.trim();
  if (raw) Object.assign(ov, JSON.parse(raw));
  return ov;
}

// ── 실행 ────────────────────────────────────────────────────────────────
$("run").onclick = async () => {
  $("err").textContent = "";
  $("run").disabled = true;
  $("run").textContent = "시뮬 중…";
  const t0 = performance.now();
  try {
    const overrides = collectOverrides();
    const seeds = $("seeds").value.split(",").map((s) => s.trim()).filter(Boolean);
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        overrides,
        source: $("source").value,
        count: Number($("count").value),
        seeds,
      }),
    });
    const run = await res.json();
    if (!res.ok) throw new Error(run.error || "실행 실패");
    renderRun(run, performance.now() - t0);
  } catch (e) {
    $("err").textContent = String(e.message || e);
  } finally {
    $("run").disabled = false;
    $("run").textContent = "재시뮬 · 재생";
  }
};

$("playAll").onclick = () => {
  const any = tiles.some((t) => !t.playing);
  for (const t of tiles) {
    if (any) t.viewer.play();
    else t.viewer.pause();
    t.playing = any;
  }
};

// ── 요약표 ──────────────────────────────────────────────────────────────
const COLS = [
  ["shots", "슛"],
  ["onTarget", "유효"],
  ["goals", "골"],
  ["xgPerShot", "슛당xG"],
  ["passSuccessPct", "패스%"],
  ["possessionPct", "점유%"],
  ["corners", "코너"],
  ["throwIns", "스로인"],
  ["fouls", "파울"],
  ["avgWidthM", "폭m"],
];

function agg(matches) {
  const out = {};
  for (const [k] of COLS) {
    let s = 0;
    for (const m of matches) s += m.stats.home[k] + m.stats.away[k];
    out[k] = Math.round((s / (matches.length * 2)) * 100) / 100;
  }
  // 최악 케이스 — 팀-경기 단위 최소. #374 규율: 평균이 입력 의존 붕괴를 가린다.
  out.__worstShots = Math.min(...matches.flatMap((m) => [m.stats.home.shots, m.stats.away.shots]));
  return out;
}

function delta(now, before) {
  if (before == null || !isFinite(before)) return "";
  const d = Math.round((now - before) * 100) / 100;
  if (d === 0) return "";
  return `<span class="d ${d > 0 ? "up" : "dn"}">${d > 0 ? "+" : ""}${d}</span>`;
}

function renderSummary(run) {
  const a = agg(run.matches);
  const prev = lastRun ? agg(lastRun.matches) : null;
  const head = COLS.map(([, l]) => `<th>${l}</th>`).join("");
  const rows = run.matches
    .map((m, i) => {
      const cells = COLS.map(([k]) => {
        const h = m.stats.home[k];
        const aw = m.stats.away[k];
        return `<td>${h} / ${aw}</td>`;
      }).join("");
      const minShots = Math.min(m.stats.home.shots, m.stats.away.shots);
      return `<tr class="${minShots === a.__worstShots ? "worst" : ""}" data-i="${i}">
        <td><b>#${i + 1}</b> <span style="color:var(--dim)">${m.seed.slice(0, 14)}</span> · ${m.score.home}:${m.score.away}</td>${cells}</tr>`;
    })
    .join("");
  const aggCells = COLS.map(([k]) => `<td>${a[k]}${delta(a[k], prev?.[k])}</td>`).join("");
  $("summary").innerHTML = `<table class="sum">
    <thead><tr><th>경기 (home / away)</th>${head}</tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr class="agg"><td>팀-경기 평균 (${run.matches.length}경기)</td>${aggCells}</tr>
    <tr class="worst"><td>⚠️ 최악 케이스 팀 슛</td><td>${a.__worstShots}</td><td colspan="${COLS.length - 1}" style="text-align:left;color:var(--dim)">평균이 아니라 이 값이 붕괴를 잡는다 (#374)</td></tr></tfoot>
  </table>`;
  for (const tr of $("summary").querySelectorAll("tbody tr")) {
    tr.style.cursor = "pointer";
    tr.onclick = () => openFocus(Number(tr.dataset.i));
  }
}

// ── 타일(복수 경기 나란히) ───────────────────────────────────────────────
const PIN_COLOR = {
  goal: "#facc15", penalty: "#22c55e", save: "#38bdf8", shot: "#fb923c",
  foul: "#f472b6", card: "#ef4444", offside: "#a78bfa", free_kick: "#94a3b8", kickoff: "#64748b",
};
const PIN_H = { goal: 16, penalty: 13, save: 11, shot: 9, foul: 7, card: 9, offside: 7, free_kick: 7, kickoff: 6 };

function pinStrip(match, height) {
  return match.pins
    .map((p) => {
      const pct = (p.tick / Math.max(1, match.ticks - 1)) * 100;
      const h = Math.min(height, PIN_H[p.type] ?? 6);
      return `<div class="pin" data-tick="${p.tick}" title="${fmt(p.tick)} ${p.type}${p.detail ? " · " + p.detail : ""}"
        style="left:${pct}%;height:${h}px;background:${PIN_COLOR[p.type] || "#64748b"}"></div>`;
    })
    .join("");
}

function renderRun(run, wallMs) {
  clockScale = run.matches[0]?.clockScale ?? 1;
  $("runTitle").textContent = `${run.matches.length}경기 · ${run.source === "benchmark" ? "벤치마크 덱" : run.matches[0]?.label ?? run.source}`;
  const ovKeys = Object.keys(run.overrides);
  $("runSub").innerHTML = ovKeys.length
    ? `오버라이드 ${ovKeys.length}개: ${ovKeys.map((k) => `<span class="badge">${k}=${run.overrides[k]}</span>`).join(" ")}`
    : "오버라이드 없음 (기본 config)";
  $("timing").textContent = `시뮬 ${run.totalMs}ms · 왕복 ${Math.round(wallMs)}ms · ${run.runId}`;

  renderSummary(run);

  // 이전 타일 정리(rAF 루프 종료).
  for (const t of tiles) t.viewer.stop();
  tiles = [];
  $("grid").innerHTML = run.matches
    .map(
      (m, i) => `<div class="tile" data-i="${i}">
      <div class="wrap"><canvas width="800" height="500"></canvas><div class="cap"></div></div>
      <div class="pins">${pinStrip(m, 16)}</div>
      <div class="bar">
        <button data-act="play">▶</button>
        <span class="sc">${m.score.home} : ${m.score.away}</span>
        <span class="seed">#${i + 1} ${m.seed}</span>
        <span class="badge clk">0'00"</span>
        <button data-act="focus">확대</button>
      </div>
    </div>`,
    )
    .join("");

  run.matches.forEach((m, i) => {
    const el = $("grid").querySelector(`.tile[data-i="${i}"]`);
    const canvas = el.querySelector("canvas");
    const capEl = el.querySelector(".cap");
    const clkEl = el.querySelector(".clk");
    const scEl = el.querySelector(".sc");
    const playBtn = el.querySelector('[data-act="play"]');
    const v = createViewer(canvas, {
      onBigCaption: (text, color) => {
        capEl.textContent = text;
        capEl.style.color = color;
        setTimeout(() => (capEl.textContent = ""), 1400);
      },
      onScore: (h, a) => (scEl.textContent = `${h} : ${a}`),
      onMinute: (mmss) => (clkEl.textContent = mmss),
      onPlaying: (p) => (playBtn.textContent = p ? "❚❚" : "▶"),
    });
    const t = { match: m, viewer: v, playing: false };
    tiles.push(t);
    v.setSpeed($("speed").value);
    v.setAutoPace(true);
    // 타일은 **피치 전체 고정 뷰**(#114 Fix). 여러 경기를 훑는 화면에서 볼 추적 줌은 화면마다
    // 다른 구석을 확대해 "팀이 어떻게 서 있나"를 못 보게 만든다 — 첫 캡처에서 4타일 중 3개가
    // 그랬다. 확대 보기는 Auto(연출 줌)를 그대로 쓴다.
    v.setViewMode("fix");
    v.start();
    fetch(m.logUrl)
      .then((r) => r.json())
      .then((log) => v.load(log));

    playBtn.onclick = () => {
      t.playing = !t.playing;
      t.playing ? v.play() : v.pause();
    };
    el.querySelector('[data-act="focus"]').onclick = () => openFocus(i);
    canvas.onclick = () => openFocus(i);
    el.querySelector(".pins").onclick = (ev) => {
      const pin = ev.target.closest(".pin");
      if (pin) v.jumpToTick(Number(pin.dataset.tick));
    };
  });

  lastRun = run;
}

// ── 확대 보기 (상황 핀 점프) ─────────────────────────────────────────────
const JUMP_TYPES = [
  ["goal", "골"], ["penalty", "PK"], ["save", "선방"], ["shot", "슛"],
  ["foul", "파울"], ["card", "카드"], ["offside", "오프사이드"], ["free_kick", "프리킥"], ["kickoff", "코너/킥오프"],
];

function openFocus(i) {
  const t = tiles[i];
  if (!t) return;
  focusMatch = t.match;
  $("focus").classList.add("on");
  if (focusViewer) focusViewer.stop();
  focusViewer = createViewer($("focusCanvas"), {
    onBigCaption: (text, color) => {
      $("focusCap").textContent = text;
      $("focusCap").style.color = color;
      setTimeout(() => ($("focusCap").textContent = ""), 1600);
    },
    onScore: (h, a) => ($("fScore").textContent = `${h} : ${a}`),
    onMinute: (mmss) => ($("fClock").textContent = mmss),
    onScrub: (pct) => ($("fScrub").value = pct),
    onPlaying: (p) => ($("fPlay").textContent = p ? "❚❚" : "▶"),
  });
  focusViewer.setSpeed($("speed").value);
  focusViewer.setAutoPace(true);
  focusViewer.start();
  fetch(t.match.logUrl)
    .then((r) => r.json())
    .then((log) => {
      focusViewer.load(log);
      focusViewer.play();
    });

  $("fPins").innerHTML = pinStrip(t.match, 22);
  $("fPins").onclick = (ev) => {
    const pin = ev.target.closest(".pin");
    if (pin) focusViewer.jumpToTick(Number(pin.dataset.tick));
  };

  const counts = {};
  for (const p of t.match.pins) counts[p.type] = (counts[p.type] || 0) + 1;
  $("fJump").innerHTML = JUMP_TYPES.filter(([k]) => counts[k]).map(
    ([k, l]) => `<button data-t="${k}">${l} <span style="color:var(--dim)">${counts[k]}</span></button>`,
  ).join("");
  const cursor = {};
  for (const b of $("fJump").querySelectorAll("button")) {
    b.onclick = () => {
      const k = b.dataset.t;
      const list = t.match.pins.filter((p) => p.type === k);
      cursor[k] = ((cursor[k] ?? -1) + 1) % list.length;
      focusViewer.jumpToTick(list[cursor[k]].tick);
    };
  }

  $("fEvents").innerHTML = t.match.pins
    .map(
      (p) => `<div class="evrow" data-tick="${p.tick}">
        <span class="t">${fmt(p.tick)}</span>
        <span style="color:${PIN_COLOR[p.type] || "#94a3b8"}">${p.type}</span>
        <span style="color:var(--dim)">${p.team ?? ""} ${p.detail ?? ""}</span></div>`,
    )
    .join("");
  for (const r of $("fEvents").querySelectorAll(".evrow")) {
    r.onclick = () => focusViewer.jumpToTick(Number(r.dataset.tick));
  }
}

$("fClose").onclick = () => {
  $("focus").classList.remove("on");
  if (focusViewer) focusViewer.stop();
  focusViewer = null;
};
$("fPlay").onclick = () => focusViewer?.togglePlay();
$("fScrub").oninput = (e) => focusViewer?.scrubTo(e.target.value);
$("speed").onchange = () => {
  for (const t of tiles) t.viewer.setSpeed($("speed").value);
  focusViewer?.setSpeed($("speed").value);
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("fClose").onclick();
});

/**
 * QA 훅 — dev-viewer 의 `window.__viewer` 와 같은 규율(임의 틱을 밖에서 검수할 수 있어야 한다).
 * 이게 없으면 "점프가 진짜 그 틱으로 갔나"를 화면 글자로 추측하게 된다.
 */
window.__harness = {
  run: () => lastRun,
  tiles: () => tiles.map((t) => ({ seed: t.match.seed, viewer: t.viewer })),
  tileViewer: (i) => tiles[i]?.viewer ?? null,
  focus: () => focusViewer,
  focusMatch: () => focusMatch,
  curTick: () => focusViewer?.hooks.cur()?.tick ?? null,
  loaded: () => Boolean(focusViewer?.hooks.ready()),
};

void META;
