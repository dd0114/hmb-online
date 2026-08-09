/**
 * #479 — adboost 프레임시퀀스 플레이어 (`~/hmb-submit/boost/lib/player-final-20260809.js` 이설)
 *
 * ## 이설 원칙 — 로직은 축자 이식, 바꾼 것은 **둘**뿐이다
 *
 * 이 파일은 #475 동결본 플레이어의 **수식·반복 순서·엔벨로프를 한 줄도 바꾸지 않았다**.
 * 카메라 보간(`camAt`/`frameCam`) · 속도 램프(`rampAt`) · 이징 · 오버레이 애니메이션 ·
 * flash/shake 합성이 원본과 같아야 hero 가 #475 에서 R1~R3 로 직접 튜닝한 그림이 그대로 나온다.
 *
 * 바꾼 것:
 *  1. **classic script(`window.HMBAd`) → ESM**. 원본은 `file://` 에서 돌아야 해서 IIFE + 전역
 *     export 였다.
 *  2. **에셋 경로 주입** (`resolveAsset`). 원본 `clip()` 은 `'../seq/'+name+'/f-'+pad3(i)+'.png'`
 *     를 하드코딩했는데, 그 상대경로는 **문서 URL 기준**으로 풀린다 → SPA 에서 `/login` 이면
 *     `/seq/…`, `/share/notice/x` 면 `/share/seq/…` = **라우트마다 다른 곳을 찾는다**.
 *     그래서 `import.meta.env.BASE_URL` 기준 절대경로 + `.webp` 로 만든다.
 *
 * ⚠️ **`page()` 는 이식하지 않았다.** 원본의 그 함수는 `file://` 단독 재생용 페이지 크롬이라
 * `document.body.className` 을 덮어쓰고(`hmbpage`) ⏸/↺ 바를 붙이고 `location.search` 를 읽고
 * `window.__show`·`__seek`·`__play` 전역을 심는다 — SPA 안에서는 전부 해롭다. rAF 루프·fit·
 * 라이프사이클은 React 호스트(`SplashScreen.tsx`)가 갖는다. 원본에서 그 함수가 하던 일 중
 * **재생 규칙만** 가져왔다: `t = (elapsed) % (total + GAP)`, `GAP = 0.7`(→ `SHOW_GAP_SEC`).
 *
 * ⚠️ **소재는 `public/splash/**` 의 webp 137장**이고 반입 절차는
 * `scripts/import-splash-assets.mjs` 가 소유한다. 참조 정합은 `splash-assets.test.ts` 가 계약이다.
 */

/** 원본 `page()` 의 루프 간격 — 15.0s 재생 뒤 0.7s 쉬고 다시 시작한다. */
export const SHOW_GAP_SEC = 0.7;

/** 무대 논리 해상도(9:16). 원본 `.hmb-inner` 와 같다. */
export const STAGE_W = 1080;
export const STAGE_H = 1920;

/** 세로 UI 프레임에서 재사용하는 사각형 — 원본 실측값(ad.html 이 눈금으로 쟀다). */
export const CARD = { x: 86, y: 924, w: 998, h: 593 } as const;

/** 소재 인벤토리 중 이 광고가 쓰는 것만. `n` = 실제 파일 수(f-000 … f-(n-1)). */
const SEQ: Record<string, { n: number; w: number; h: number }> = {
  steal: { n: 72, w: 2100, h: 1360 },
  tackle: { n: 110, w: 2100, h: 1360 },
  say1: { n: 48, w: 1170, h: 2532 },
  "say-captain": { n: 47, w: 1170, h: 2532 },
};

/**
 * 반입 경로 해석 — `public/splash/` 아래. `BASE_URL` 기준이라 서브패스 배포에서도 성립한다.
 * ⚠️ 확장자가 `.webp` 인 것이 반입(`import-splash-assets.mjs`)과 짝이다.
 */
export function resolveAsset(rel: string): string {
  const base = import.meta.env.BASE_URL ?? "/";
  return `${base.endsWith("/") ? base : `${base}/`}splash/${rel}`;
}

const pad3 = (n: number) => String(n).padStart(3, "0");

export interface Clip {
  name: string;
  files: string[];
  w: number;
  h: number;
}

/** 시퀀스 구간 → {files,w,h}. 범위는 실제 파일 수로 클램프한다(원본과 동일). */
export function clip(name: string, from: number, to: number): Clip {
  const m = SEQ[name];
  if (!m) throw new Error(`unknown seq: ${name}`);
  const a = Math.max(0, from | 0);
  const b = Math.min(m.n - 1, to | 0);
  const files: string[] = [];
  for (let i = a; i <= b; i++) files.push(resolveAsset(`seq/${name}/f-${pad3(i)}.webp`));
  return { name, files, w: m.w, h: m.h };
}

/** 정지컷 → clip 과 같은 모양. `rel` 은 `public/splash/` 기준 상대경로. */
export function still(rel: string, w: number, h: number): Clip {
  return { name: rel, files: [resolveAsset(rel)], w, h };
}

// ── 수학 (원본 축자) ──────────────────────────────────────────────────────────
function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v;
}

type Ease = (p: number) => number;
export const EASE = {
  linear: (p: number) => p,
  out: (p: number) => 1 - Math.pow(1 - p, 3),
  in: (p: number) => p * p * p,
  inout: (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  expo: (p: number) => (p >= 1 ? 1 : 1 - Math.pow(2, -9 * p)),
} satisfies Record<string, Ease>;

/**
 * 이름으로 이징을 고른다 — 모르는 이름/미지정은 `linear`(원본 `EASE[name] || EASE.linear` 과 동일).
 * ⚠️ 별도 함수인 것은 타입 때문이다(`Record` 인덱스는 `undefined` 를 낸다). 동작은 원본 그대로.
 */
function easeBy(name: string | undefined): Ease {
  return name && name in EASE ? EASE[name as keyof typeof EASE] : EASE.linear;
}

/** 꺾은선 매핑 [[x,y],…] — 속도 램프. 없으면 항등. */
function rampAt(pts: readonly (readonly [number, number])[] | undefined, x: number): number {
  if (!pts || pts.length < 2) return x;
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i]![0]) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const span = b[0] - a[0];
      const u = span <= 0 ? 1 : (x - a[0]) / span;
      return a[1] + (b[1] - a[1]) * u;
    }
  }
  return pts[pts.length - 1]![1];
}

export interface CamKey {
  t: number;
  cx: number;
  cy: number;
  w: number;
  ease?: string;
}

/** 카메라 키프레임 보간. */
function camAt(kfs: readonly CamKey[] | undefined, p: number): { cx: number; cy: number; w: number } | null {
  if (!kfs || !kfs.length) return null;
  if (kfs.length === 1) return kfs[0]!;
  for (let i = 1; i < kfs.length; i++) {
    if (p <= kfs[i]!.t || i === kfs.length - 1) {
      const a = kfs[i - 1]!;
      const b = kfs[i]!;
      const span = b.t - a.t;
      let u = span <= 0 ? 1 : clamp((p - a.t) / span, 0, 1);
      u = easeBy(b.ease)(u);
      return { cx: a.cx + (b.cx - a.cx) * u, cy: a.cy + (b.cy - a.cy) * u, w: a.w + (b.w - a.w) * u };
    }
  }
  return kfs[kfs.length - 1]!;
}

/** 카메라 → 이미지 배치. 창이 소재 안에 들어가면 가장자리를 넘지 않게 클램프한다. */
function frameCam(
  cam: { cx: number; cy: number; w: number },
  sw: number,
  sh: number,
  pw: number,
  ph: number,
) {
  const camW = cam.w;
  const camH = (camW * ph) / pw;
  let cx = cam.cx;
  let cy = cam.cy;
  if (camW <= sw) cx = clamp(cx, camW / 2, sw - camW / 2);
  else cx = sw / 2;
  if (camH <= sh) cy = clamp(cy, camH / 2, sh - camH / 2);
  else cy = sh / 2;
  const s = pw / camW;
  return { s, left: pw / 2 - cx * s, top: ph / 2 - cy * s };
}

// ── preload (실패 프레임은 목록에서 제거) ─────────────────────────────────────
type LoadedMap = Record<string, boolean>;

function preload(urls: string[], onProgress: ((done: number, total: number) => void) | undefined, done: (ok: LoadedMap) => void) {
  const total = urls.length;
  let left = total;
  const ok: LoadedMap = Object.create(null) as LoadedMap;
  if (!left) {
    done(ok);
    return;
  }
  const step = () => {
    left--;
    onProgress?.(total - left, total);
    if (left === 0) done(ok);
  };
  urls.forEach((u) => {
    const im = new Image();
    im.onload = () => {
      ok[u] = true;
      step();
    };
    im.onerror = step; // 콘솔 에러 대신 조용히 스킵 (원본과 동일)
    im.src = u;
  });
}

// ── CSS 주입 (원본 축자 — 페이지 크롬 규칙 `.hmbpage`/`.hmbbar`/`.hmbhost` 만 제외) ──────
const CSS =
  ".hmb-stage{position:relative;overflow:hidden;background:#000}" +
  ".hmb-inner{position:absolute;left:0;top:0;width:1080px;height:1920px;transform-origin:0 0;background:#05070a}" +
  ".hmb-shake{position:absolute;left:0;top:0;width:1080px;height:1920px;will-change:transform}" +
  ".hmb-pane{position:absolute;overflow:hidden;background:#05070a}" +
  ".hmb-pane .pbg{position:absolute;inset:-14%;filter:blur(34px) brightness(.4);background-size:cover;background-position:center}" +
  ".hmb-pane img{position:absolute;transform-origin:0 0;image-rendering:auto}" +
  ".hmb-pane img.dim{filter:blur(10px) brightness(.42) saturate(.7)}" +
  ".hmb-ov{position:absolute;left:0;top:0;width:1080px;height:1920px;pointer-events:none}" +
  '.hmb-t{position:absolute;text-align:center;color:#fff;font-weight:900;letter-spacing:-.03em;line-height:1.14;' +
  "white-space:pre-line;text-shadow:0 8px 28px rgba(0,0,0,.8),0 2px 6px rgba(0,0,0,.95);" +
  'font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;will-change:transform,opacity}' +
  ".hmb-t .ch{display:inline-block;will-change:transform,opacity}" +
  ".hmb-flash{position:absolute;inset:0;background:#fff;opacity:0;mix-blend-mode:screen}" +
  ".hmb-vig{position:absolute;inset:0;pointer-events:none;" +
  "background:radial-gradient(120% 78% at 50% 46%,rgba(0,0,0,0) 38%,rgba(0,0,0,.22) 72%,rgba(0,0,0,.62) 100%)}";

function injectCSS() {
  if (typeof document === "undefined" || document.getElementById("hmb-css")) return;
  const s = document.createElement("style");
  s.id = "hmb-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ── Cut / Pane ───────────────────────────────────────────────────────────────
export interface Cut {
  /** 컷 길이(초). */
  d: number;
  clip?: Clip;
  /** 끝에서 정지하는 시간(초). */
  hold?: number;
  ramp?: readonly (readonly [number, number])[];
  cam?: readonly CamKey[];
  /** 이 사각형만 선명하게 덧댄다(나머지는 dim). */
  focus?: { x: number; y: number; w: number; h: number };
  /** 블러 배경 판 사용 여부(기본 true). */
  bg?: boolean;
  dim?: boolean;
  /** 소재 없이 단색으로 채우는 컷. */
  blank?: string;
  /** preload 후 실제로 살아 있는 파일 목록(내부). */
  _files?: string[] | null;
}

export interface PaneSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  radius?: number;
  cuts: Cut[];
}

class Pane {
  spec: PaneSpec;
  el: HTMLDivElement;
  bg: HTMLDivElement;
  base: HTMLImageElement;
  sharp: HTMLImageElement;
  cuts: Cut[];

  constructor(spec: PaneSpec) {
    this.spec = spec;
    this.el = document.createElement("div");
    this.el.className = "hmb-pane";
    this.el.style.left = `${spec.x}px`;
    this.el.style.top = `${spec.y}px`;
    this.el.style.width = `${spec.w}px`;
    this.el.style.height = `${spec.h}px`;
    if (spec.radius) this.el.style.borderRadius = `${spec.radius}px`;
    this.bg = document.createElement("div");
    this.bg.className = "pbg";
    this.base = document.createElement("img");
    this.sharp = document.createElement("img");
    // 광고 소재는 장식이다 — 스크린리더가 137장을 읽지 않게 한다.
    this.base.alt = "";
    this.sharp.alt = "";
    this.el.append(this.bg, this.base, this.sharp);
    this.cuts = spec.cuts ?? [];
  }

  files(): string[] {
    let out: string[] = [];
    this.cuts.forEach((c) => {
      if (c.clip) out = out.concat(c.clip.files);
    });
    return out;
  }

  filter(ok: LoadedMap) {
    this.cuts.forEach((c) => {
      if (!c.clip) return;
      c._files = c.clip.files.filter((u) => ok[u]);
      if (!c._files.length) c._files = null; // 전부 실패 → 빈 컷 취급
    });
  }

  cutAt(t: number): { cut: Cut; local: number; i: number } | null {
    let acc = 0;
    for (let i = 0; i < this.cuts.length; i++) {
      const c = this.cuts[i]!;
      if (t < acc + c.d) return { cut: c, local: t - acc, i };
      acc += c.d;
    }
    const last = this.cuts[this.cuts.length - 1];
    return last ? { cut: last, local: last.d - 1e-4, i: this.cuts.length - 1 } : null;
  }

  draw(t: number) {
    const hit = this.cutAt(t);
    const cut = hit?.cut;
    if (!hit || !cut || cut.blank || !cut._files) {
      this.base.style.display = "none";
      this.sharp.style.display = "none";
      this.bg.style.display = "none";
      this.el.style.background = cut?.blank || "#05070a";
      return;
    }
    this.el.style.background = "#05070a";
    const files = cut._files;
    const n = files.length;
    const playD = Math.max(1e-3, cut.d - (cut.hold || 0));
    const lp = clamp(hit.local / playD, 0, 1);
    const fp = clamp(rampAt(cut.ramp, lp), 0, 1);
    const idx = Math.min(n - 1, Math.floor(fp * n));
    const f = files[idx]!;
    if (this.base.getAttribute("src") !== f) this.base.src = f;
    this.base.style.display = "block";

    // 블러 배경 = 컷당 1장 고정(매 프레임 갈아끼우면 경기장 밖이 깜빡인다 — 원본의 교훈)
    const wantBg = cut.bg !== false;
    this.bg.style.display = wantBg ? "block" : "none";
    if (wantBg) {
      const bf = files[Math.floor(n / 2)]!;
      if (this.bg.dataset.f !== bf) {
        this.bg.style.backgroundImage = `url("${bf}")`;
        this.bg.dataset.f = bf;
      }
    }

    const sw = cut.clip!.w;
    const sh = cut.clip!.h;
    const cam = camAt(cut.cam, lp) || { cx: sw / 2, cy: sh / 2, w: sw };
    const g = frameCam(cam, sw, sh, this.spec.w, this.spec.h);
    const st = this.base.style;
    st.width = `${sw * g.s}px`;
    st.height = "auto";
    st.left = `${g.left}px`;
    st.top = `${g.top}px`;
    this.base.classList.toggle("dim", !!cut.focus || !!cut.dim);

    if (cut.focus) {
      // 지정 사각형만 선명하게 덧댄다
      if (this.sharp.getAttribute("src") !== f) this.sharp.src = f;
      this.sharp.style.display = "block";
      const s2 = this.sharp.style;
      s2.width = st.width;
      s2.height = "auto";
      s2.left = st.left;
      s2.top = st.top;
      const r = cut.focus;
      s2.clipPath =
        `inset(${r.y * g.s}px ${(sw - r.x - r.w) * g.s}px ` +
        `${(sh - r.y - r.h) * g.s}px ${r.x * g.s}px round ${20 * g.s}px)`;
    } else {
      this.sharp.style.display = "none";
    }
  }
}

// ── 오버레이 ─────────────────────────────────────────────────────────────────
export interface Overlay {
  from: number;
  to: number;
  text?: string;
  html?: string;
  x?: number;
  y?: number;
  w?: number;
  size?: number;
  color?: string;
  weight?: string;
  lh?: string;
  ls?: string;
  align?: string;
  anim?: "slam" | "rise" | "drop" | "wipe" | "pop" | "type" | "fade";
  outAnim?: "up";
  inDur?: number;
  outDur?: number;
  stagger?: number;
  charDur?: number;
  typeDur?: number;
  cls?: string;
  style?: Record<string, string>;
  _el?: HTMLDivElement;
  _chars?: NodeListOf<HTMLElement>;
}

function escapeHtml(c: string) {
  return c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c;
}

function buildOverlay(o: Overlay): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `hmb-t${o.cls ? ` ${o.cls}` : ""}`;
  const w = o.w || 980;
  el.style.left = `${(o.x != null ? o.x : 540) - w / 2}px`;
  el.style.top = `${o.y || 0}px`;
  el.style.width = `${w}px`;
  el.style.fontSize = `${o.size || 64}px`;
  if (o.weight) el.style.fontWeight = o.weight;
  if (o.color) el.style.color = o.color;
  if (o.lh) el.style.lineHeight = o.lh;
  if (o.ls) el.style.letterSpacing = o.ls;
  if (o.align) el.style.textAlign = o.align;
  if (o.style) {
    const s = el.style as unknown as Record<string, string>;
    for (const k in o.style) {
      const v = o.style[k];
      if (v !== undefined) s[k] = v;
    }
  }
  if (o.html) el.innerHTML = o.html;
  else if (o.anim === "pop" || o.anim === "type") {
    let frag = "";
    (o.text || "").split("").forEach((c) => {
      frag += `<span class="ch">${
        c === " " ? "&nbsp;" : c === "\n" ? '</span><br><span class="ch">' : escapeHtml(c)
      }</span>`;
    });
    el.innerHTML = frag;
    o._chars = el.querySelectorAll<HTMLElement>(".ch");
  } else el.textContent = o.text || "";
  el.style.opacity = "0";
  return el;
}

function drawOverlay(o: Overlay, t: number) {
  const el = o._el!;
  if (t < o.from - 1e-6 || t > o.to) {
    el.style.opacity = "0";
    el.style.visibility = "hidden";
    return;
  }
  el.style.visibility = "visible";
  const inD = o.inDur != null ? o.inDur : 0.22;
  const outD = o.outDur != null ? o.outDur : 0.26;
  const pi = clamp((t - o.from) / inD, 0, 1);
  const po = clamp((o.to - t) / outD, 0, 1);
  const eo = EASE.out(pi);
  let op = 1;
  let tr = "";
  switch (o.anim) {
    case "slam":
      op = pi;
      tr = `scale(${1 + 0.55 * (1 - EASE.expo(pi))})`;
      if (po < 1) tr = `scale(${1 + 0.07 * (1 - po)})`;
      break;
    case "rise":
      op = pi;
      tr = `translateY(${48 * (1 - eo)}px)`;
      break;
    case "drop":
      op = pi;
      tr = `translateY(${-40 * (1 - eo)}px)`;
      break;
    case "wipe":
      op = 1;
      el.style.clipPath = `inset(0 ${(1 - eo) * 100}% 0 0)`;
      break;
    case "pop":
    case "type":
      op = 1;
      break;
    default:
      op = pi;
  }
  if (o.anim === "pop" && o._chars) {
    for (let i = 0; i < o._chars.length; i++) {
      const ci = clamp((t - o.from - i * (o.stagger || 0.028)) / (o.charDur || 0.2), 0, 1);
      const e = EASE.out(ci);
      const c = o._chars[i]!;
      c.style.opacity = String(ci * po);
      c.style.transform = `translateY(${30 * (1 - e)}px) scale(${0.45 + 0.55 * e})`;
    }
  } else if (o.anim === "type" && o._chars) {
    const vis = Math.ceil(clamp((t - o.from) / (o.typeDur || 1), 0, 1) * o._chars.length);
    for (let j = 0; j < o._chars.length; j++) o._chars[j]!.style.opacity = j < vis ? String(po) : "0";
  }
  if (o.outAnim === "up" && po < 1) tr += ` translateY(${-34 * (1 - po)}px)`;
  el.style.opacity = String(clamp(op * (o.anim === "pop" || o.anim === "type" ? 1 : po), 0, 1));
  el.style.transform = tr;
}

// ── fx ──────────────────────────────────────────────────────────────────────
export interface Fx {
  type: "flash" | "shake";
  at: number;
  dur: number;
  a?: number;
  color?: string;
  /** 'dip' = 삼각 엔벨로프(0→1→0) — 컷 경계에서 가장 어둡다. */
  shape?: "dip";
  hold?: number;
  amp?: number;
}

// ── Show ────────────────────────────────────────────────────────────────────
export interface ShowOpt {
  total: number;
  panes: PaneSpec[];
  overlays?: Overlay[];
  fx?: Fx[];
  vignette?: boolean;
  onTick?: (t: number, show: Show) => void;
}

export class Show {
  opt: ShowOpt;
  total: number;
  panes: Pane[];
  overlays: Overlay[];
  fx: Fx[];
  stage: HTMLDivElement;
  inner: HTMLDivElement;
  shake: HTMLDivElement;
  ov: HTMLDivElement;
  flash: HTMLDivElement;
  missing: string[] = [];

  constructor(opt: ShowOpt) {
    injectCSS();
    this.opt = opt;
    this.total = opt.total;
    this.panes = (opt.panes || []).map((p) => new Pane(p));
    this.overlays = (opt.overlays || []).slice();
    this.fx = (opt.fx || []).slice();

    this.stage = document.createElement("div");
    this.stage.className = "hmb-stage";
    this.inner = document.createElement("div");
    this.inner.className = "hmb-inner";
    this.shake = document.createElement("div");
    this.shake.className = "hmb-shake";
    this.ov = document.createElement("div");
    this.ov.className = "hmb-ov";
    this.flash = document.createElement("div");
    this.flash.className = "hmb-flash";
    this.panes.forEach((p) => this.shake.appendChild(p.el));
    this.shake.appendChild(this.ov);
    this.inner.appendChild(this.shake);
    this.inner.appendChild(this.flash);
    if (opt.vignette !== false) {
      const v = document.createElement("div");
      v.className = "hmb-vig";
      this.inner.appendChild(v);
    }
    this.stage.appendChild(this.inner);

    this.overlays.forEach((o) => {
      o._el = buildOverlay(o);
      this.ov.appendChild(o._el);
    });
  }

  /** 무대를 `boxW` CSS px 폭으로 맞춘다(9:16 고정). */
  resize(boxW: number) {
    const k = boxW / STAGE_W;
    this.stage.style.width = `${boxW}px`;
    this.stage.style.height = `${Math.round((boxW * STAGE_H) / STAGE_W)}px`;
    this.inner.style.transform = `scale(${k})`;
  }

  /** 전 프레임 preload 후 콜백. 실패분은 목록에서 제거하고 재생한다(원본과 동일). */
  load(cb?: () => void, onProgress?: (done: number, total: number) => void) {
    let urls: string[] = [];
    this.panes.forEach((p) => {
      urls = urls.concat(p.files());
    });
    urls = Array.from(new Set(urls));
    preload(urls, onProgress, (ok) => {
      this.panes.forEach((p) => p.filter(ok));
      this.missing = urls.filter((u) => !ok[u]);
      cb?.();
    });
  }

  draw(t: number) {
    t = clamp(t, 0, this.total - 1e-4);
    this.panes.forEach((p) => p.draw(t));
    for (let i = 0; i < this.overlays.length; i++) drawOverlay(this.overlays[i]!, t);

    // ⚠️ flash 레이어는 기본이 흰색 + mix-blend-mode:screen 이라 어두운 색이 안 먹는다(screen 은
    //    어두운 값을 항등으로 만든다). f.color 가 있으면 blend 를 normal 로 전환해 "다크 딥"이
    //    실제로 화면을 어둡게 만들게 한다. 색은 매 draw 마다 다시 결정한다(색 누수 방지).
    let flashA = 0;
    let flashCol: string | null = null;
    let sx = 0;
    let sy = 0;
    for (let j = 0; j < this.fx.length; j++) {
      const f = this.fx[j]!;
      if (t < f.at || t > f.at + f.dur) continue;
      const p = (t - f.at) / f.dur;
      if (f.type === "flash") {
        const a =
          f.shape === "dip"
            ? 1 - Math.abs(2 * p - 1)
            : f.hold
              ? p < f.hold
                ? 1
                : 1 - (p - f.hold) / (1 - f.hold)
              : 1 - p;
        const v = (f.a != null ? f.a : 1) * a;
        if (v > flashA) {
          flashA = v;
          flashCol = f.color || null;
        }
      } else if (f.type === "shake") {
        const d = (1 - p) * (f.amp || 14);
        sx += Math.sin(t * 91.3 + j) * d;
        sy += Math.cos(t * 77.1 + j * 2) * d;
      }
    }
    this.flash.style.opacity = String(flashA);
    this.flash.style.background = flashCol || "#fff";
    this.flash.style.mixBlendMode = flashCol ? "normal" : "screen";
    this.shake.style.transform = sx || sy ? `translate(${sx.toFixed(2)}px,${sy.toFixed(2)}px)` : "";
    this.opt.onTick?.(t, this);
  }
}
