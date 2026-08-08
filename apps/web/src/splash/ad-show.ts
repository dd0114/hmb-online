/**
 * #479 — V1 「임팩트 콜드오픈」 쇼 정의 (`~/hmb-submit/boost/v1-final-20260809.html` 이설)
 *
 * ## 이것이 #475 동결본의 **정본 사본**이다
 *
 * 컷 경계·카메라 키프레임·램프·오버레이 타이밍·fx 가 전부 hero 가 #475 에서 R1~R3 로 직접
 * 리뷰·튜닝한 값이다. **숫자를 임의로 바꾸지 마라** — 바꾸면 그 리뷰가 무효가 된다.
 * 원본 주석의 설계 근거(D1~D5 · R1~R3)를 아래에 함께 옮겨 뒀다.
 *
 * 이설에서 바뀐 것은 **소재 경로 2줄**뿐이다(`../seq/…png` → `seq/…webp`, `../shots/…` → `shots/…`).
 * 프레임 참조 정합은 `splash-assets.test.ts` 가 계약으로 잡는다.
 *
 * ⚠️ **`document.getElementById` → 오버레이 루트 안 `data-*` 조회로 바꿨다.** 원본은 `file://`
 * 단독 문서라 전역 id(`#c4`)로 찾고 그 결과를 모듈 전역에 캐시했는데, SPA 에서는 언마운트 후
 * 다시 마운트하면 **제거된 노드를 계속 가리킨다**(합성 레이어가 영영 안 그려진다). 그래서
 * 쇼 인스턴스마다 자기 상태를 갖는 팩토리(`createAdShow`)로 만들고, 조회도 그 쇼의 오버레이
 * 엘리먼트 안으로 좁혔다. 렌더 결과는 같다(id → data 속성은 기계적 개명이다).
 *
 * ── 원본 구조 ────────────────────────────────────────────────────────────────
 * [0.0] 골망이 터지는 순간을 슬로모 펀치인으로 먼저 던진다(훅) → "그 골은 네가 시킨 거다" 로
 *       인과를 열고 → 지시/결과 2쌍 → 수집 축 한 컷 → CTA.
 *
 * D1 콜드오픈 소재 = steal f065~071 (골망 파티클 버스트는 f068 부터).
 * D2 훅 카피 = 「말 한마디로」 / 「골이 터진다」 2비트. 두 번째를 골 순간에 때린다.
 * D3 2쌍의 대사 = say1(공격 지시) + say-captain(수비 지시) — "공격만 시키는 게임"으로 안 읽히게.
 * D4 마지막 자리는 뽑기/도감 실화면 + 타이틀 카드(실제 게임 화면이라 실체 오도가 없다).
 * D5 모든 경기 컷은 넓게(피치 폭 55%) 시작해 클라이맥스에서 풀크롭으로 펀치인한다.
 * R1 흰 섬광 **전면 제거**(hero: "반복적인 섬광 때문에 보기 너무 힘들다"). 컷 전환은 다크 딥.
 * R2 결과 컷(③⑤) 감속 — 앞 1/3 유효 fps −30% 이상. 감속 성질은 유지.
 * R3 지시② 카드 문구를 실화면 위에 합성(글자만) — 결과② 컷과 인과가 맞는 문장으로 교체.
 */
import { CARD, type Fx, type Overlay, Show, type ShowOpt, clip, still } from "./ad-player";

/** 컷 경계 (합 15.0) — ① 1.60 · ② 1.90 · ③ 3.20 · ④ 1.90 · ⑤ 3.10 · ⑥ 1.00 · ⑦ 2.30 */
const T = { open: 0, s1: 1.6, a1: 3.5, s2: 6.7, a2: 8.6, col: 11.7, cta: 12.7, end: 15.0 } as const;

/** 총 재생 길이(초) — 호스트가 진행 표시에 쓴다. */
export const AD_TOTAL_SEC = T.end;

/** 결과 컷의 정지(hold) 시작 = GOAL 텍스트/shake 앵커. 컷 경계가 움직이면 여기서 파생된다. */
const HOLD = 0.4;
const G1 = T.s2 - HOLD; // 6.30
const G2 = T.col - HOLD; // 11.30
const D = (a: number, b: number) => b - a;

// ── 카메라 프리셋 ────────────────────────────────────────────────────────────
// 2100×1360 소재에서 9:16 창의 최대 폭은 1360*0.5625 = 765px — 풀크롭은 언제나 강한 줌이다.
// ⚠️ WIDE 를 소재 전폭(2100)으로 잡으면 실캡처에서 **화면의 절반이 검은 띠**다(9:16 무대에
//    1.54:1 소재를 전폭으로 넣으면 세로 36%만 그림이다). 1150 = 피치 폭 55% 를 보여주면서
//    세로 84% 를 채우는 지점 — 여기서 시작해 765 이하로 펀치인한다.
const WIDE = 1150;
const TIGHT = 780;
// ⚠️ 두 중심은 **크롭 실캡처로 눈으로 맞춘 값**이다(§2-2 좌표 추론 금지).
const GOAL_STEAL = { cx: 1060, cy: 700 }; // steal f066~071 골망 버스트
const GOAL_TACKLE = { cx: 1080, cy: 670 }; // tackle f057~059 골 버스트

/* ── R3 · 지시② 카드 문구 합성 ────────────────────────────────────────────────
 * 실녹화 say-captain 은 「주장을 조심해…」가 타이핑된다. 이걸 결과② 컷(tackle: 끊고→역습→골)과
 * 인과가 맞는 문장으로 바꾼다. 방식 = **카드 UI 는 실화면 그대로, 글자만 합성**.
 *   · 배경 = `say-captain/f-016` 1장 정지(meta.json 이 note:"empty" 로 표시한 마지막 프레임).
 *   · 그 위에 ⓐ입력창 본문 ⓑ글자수 카운터 ⓒ하단 미리보기 줄을 같은 좌표·같은 색으로 다시 그린다.
 * ⚠️ 좌표·색은 **전부 실측**이다(소재를 1:1 크롭해 눈금과 함께 보고 픽셀을 직접 샘플):
 *      입력창 안쪽 #10141b · 카운터 줄 #191e29→#181d28 · 지시문 패널 #0f1115
 *      본문 글자 #eef0f4 · 카운터 회색 #8e95a2 · 패널 회색 #939aa5
 *      입력창 안쪽 사각형 ≈ x127–1049 / y1045–1338, 본문 좌상단 (150, 1076), 글자 ~40px
 * ⚠️ 미리보기 줄(y≈1975)은 CARD 포커스 사각형 **밖**이라 원본이 blur(10px) brightness(.42)
 *    saturate(.7) 로 흐려진다 → 합성분도 **같은 필터를 건 레이어**에 넣어야 이음매가 안 보인다.
 * ⚠️ 타이핑 속도는 원본과 맞춘다(≈21자/초). 등속이면 기계적이라 **결정론적 사인 지터**를 얹었다
 *    (`Math.random` 금지 — 루트 §2-5 결정론 규율과 같은 관용구).
 * ────────────────────────────────────────────────────────────────────────── */
const SAY2 = "패스 길목만 노려. 끊으면 바로 역습이야"; // 22자 (카운터 표시와 일치)
const SAY2_EMPTY = "아직 이 선수에게 전달될 지시가 없습니다."; // f-016 미리보기 줄 원문
const SRC_W = 1170; // say-captain 소재 가로(세로 UI 프레임)
const TYPE_IN = 0.1;
const TYPE_DUR = 1.1; // 컷 ④ 로컬 0.10s 부터 1.10s 동안 타이핑 → 0.70s 홀드

function pill(from: number, to: number, text: string, col: string): Overlay {
  return {
    from,
    to,
    y: 140,
    w: 1000,
    size: 40,
    anim: "drop",
    inDur: 0.2,
    html:
      `<span style="display:inline-block;padding:14px 30px;border-radius:999px;background:${col}` +
      `;color:#fff;font-weight:900;letter-spacing:-.02em;box-shadow:0 10px 30px rgba(0,0,0,.45)">${text}</span>`,
  };
}

/**
 * R3 합성 레이어 — 두 겹. CARD 포커스 사각형 **안**은 선명(`c4s`), **밖**(미리보기 줄)은
 * 원본 dim 과 같은 필터를 건 레이어(`c4d`). 두 겹 모두 좌표를 **소재 픽셀 그대로** 쓰고
 * `paintSayCard` 가 매 틱 pane 이미지의 실제 배치를 읽어 같은 변환을 건다(카메라가 계속
 * 줌하므로 고정 좌표로는 어긋난다).
 */
function sayCardHtml(): string {
  const P = "position:absolute;";
  const layer = "position:absolute;left:0;top:0;width:1080px;height:1920px;overflow:hidden";
  const fit = "position:absolute;left:0;top:0;width:1170px;height:2532px;transform-origin:0 0";
  return (
    `<div data-c4 style="${P}left:0;top:0;width:1080px;height:1920px;text-align:left;` +
    `text-shadow:none;font-weight:400;letter-spacing:0;line-height:1;color:#eef0f4">` +
    // ⓐ 카드 안 = 선명. 입력창 본문 + 글자수 카운터.
    `<div style="${layer}">` +
    `<div data-c4s style="${fit}">` +
    // 플레이스홀더를 덮는 판. 안쪽 사각형(127–1049 / 1045–1338)보다 안으로 물려
    // 라운드 코너를 안 건드린다(모서리를 물면 주황 테두리에 검은 이가 생긴다).
    `<div style="${P}left:136px;top:1054px;width:908px;height:200px;` +
    `border-radius:24px;background:#10141b"></div>` +
    `<div data-c4t style="${P}left:150px;top:1072px;width:890px;font-size:44.5px;line-height:1.34"></div>` +
    // 카운터 줄은 미세한 세로 그라디언트라 단색이 아니라 그라디언트로 덮는다.
    `<div style="${P}left:104px;top:1384px;width:212px;height:66px;` +
    `background:linear-gradient(#191e29,#181d28)"></div>` +
    `<div data-c4n style="${P}left:112px;top:1414px;font-size:33px;white-space:nowrap"></div>` +
    `</div>` +
    `</div>` +
    // ⓑ 카드 밖 = 흐림. `.hmb-pane img.dim` 과 **같은 필터**를 스테이지 좌표계에서 건다.
    `<div style="${layer};filter:blur(10px) brightness(.42) saturate(.7)">` +
    `<div data-c4d style="${fit}">` +
    `<div style="${P}left:86px;top:1958px;width:1000px;height:77px;background:#0f1115"></div>` +
    `<div data-c4p style="${P}left:112px;top:1974px;width:950px;font-size:35px;color:#939aa5"></div>` +
    `</div>` +
    `</div>` +
    `</div>`
  );
}

/**
 * 동결본 쇼를 새로 만든다.
 *
 * ⚠️ **팩토리인 것이 중요하다** — 합성 레이어 캐시(`c4`)가 인스턴스마다 새로 생겨야 언마운트 후
 * 재마운트에서 제거된 노드를 가리키지 않는다(파일 머리말 참조).
 */
export function createAdShow(): Show {
  const sayOverlay: Overlay = {
    // 페이드 없이 컷 전 구간 상주 — 카드 UI 의 일부처럼 보여야 한다.
    from: T.s2 - 0.02,
    to: T.a2,
    y: 0,
    w: 1080,
    size: 1,
    inDur: 0.001,
    outDur: 0.001,
    html: sayCardHtml(),
    style: { pointerEvents: "none" },
  };

  /** 이 쇼 인스턴스 전용 합성 레이어 핸들 캐시. */
  let c4: {
    root: HTMLElement;
    s: HTMLElement;
    d: HTMLElement;
    txt: HTMLElement;
    num: HTMLElement;
    pv: HTMLElement;
    n: number;
  } | null = null;

  function paintSayCard(t: number, show: Show) {
    if (c4 === null) {
      const host = sayOverlay._el;
      const root = host?.querySelector<HTMLElement>("[data-c4]");
      if (!host || !root) return;
      c4 = {
        root,
        s: host.querySelector<HTMLElement>("[data-c4s]")!,
        d: host.querySelector<HTMLElement>("[data-c4d]")!,
        txt: host.querySelector<HTMLElement>("[data-c4t]")!,
        num: host.querySelector<HTMLElement>("[data-c4n]")!,
        pv: host.querySelector<HTMLElement>("[data-c4p]")!,
        n: -1,
      };
    }
    // ⚠️ 게이트를 시각이 아니라 **지금 화면에 있는 프레임**으로 건다. 오버레이 창을 컷 경계보다
    //    조금이라도 넓게 잡으면 그 순간 pane 은 아직 경기 소재(2100px 폭)라 스케일이 완전히
    //    틀어지고, 판때기가 피치 위 엉뚱한 자리로 한 프레임 찍힌다. src 로 물으면 원천봉쇄된다.
    const img = show.panes[0]!.base;
    const ok = (img.getAttribute("src") || "").indexOf("say-captain") >= 0;
    c4.root.style.visibility = ok ? "visible" : "hidden";
    if (!ok) return;

    // pane 이미지의 실제 배치를 읽어 그대로 따라간다(카메라 수식 재구현 금지 — 어긋난다).
    const s = (parseFloat(img.style.width) || SRC_W) / SRC_W;
    const tr = `translate(${parseFloat(img.style.left)}px,${parseFloat(img.style.top)}px) scale(${s})`;
    c4.s.style.transform = tr;
    c4.d.style.transform = tr;

    let u = (t - T.s2 - TYPE_IN) / TYPE_DUR;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    if (u > 0 && u < 1) u = Math.max(0, Math.min(1, u + 0.035 * Math.sin(u * 15.7))); // 결정론적 지터
    const n = Math.round(u * SAY2.length);
    if (n === c4.n) return;
    c4.n = n;
    c4.txt.textContent = SAY2.slice(0, n);
    c4.pv.textContent = n ? SAY2.slice(0, n) : SAY2_EMPTY;
    c4.num.innerHTML =
      `<b style="font-weight:700">${n}</b><span style="color:#8e95a2;margin-left:22px">/ 500</span>`;
  }

  const fx: Fx[] = [
    // ⚠️ R1 — 흰 섬광 0개. 밝게 번쩍이는 fx 는 이 리스트에 다시 들어오면 안 된다.
    //    강조가 필요하면 shake / 타이포 슬램으로. dip 은 삼각 엔벨로프라 컷 경계에서 가장 어둡다.
    { type: "flash", at: 0.0, dur: 0.5, a: 1, color: "#05070a" }, // 검정에서 페이드 인
    { type: "shake", at: 0.74, dur: 0.4, amp: 20 }, // 콜드오픈 골망 임팩트
    { type: "flash", at: T.s1 - 0.15, dur: 0.3, a: 0.94, color: "#05070a", shape: "dip" }, // ①→②
    { type: "shake", at: G1, dur: 0.38, amp: 18 }, // 결과① 골
    { type: "shake", at: G2, dur: 0.38, amp: 18 }, // 결과② 골
    { type: "flash", at: T.cta - 0.15, dur: 0.3, a: 0.96, color: "#05070a", shape: "dip" }, // ⑥→⑦
  ];

  const opt: ShowOpt = {
    total: T.end,
    panes: [
      {
        x: 0,
        y: 0,
        w: 1080,
        h: 1920,
        cuts: [
          // ① 콜드오픈 — 골망. 슬로모(7프레임을 1.30초)로 늘리고 마지막 0.30초 정지.
          {
            d: D(T.open, T.s1),
            clip: clip("steal", 65, 71),
            hold: 0.3,
            ramp: [
              [0, 0],
              [0.45, 0.5],
              [1, 1],
            ],
            cam: [
              { t: 0, cx: GOAL_STEAL.cx + 55, cy: GOAL_STEAL.cy, w: 930 },
              { t: 1, cx: GOAL_STEAL.cx, cy: GOAL_STEAL.cy, w: TIGHT, ease: "out" },
            ],
          },

          // ② 지시 ①
          {
            d: D(T.s1, T.a1),
            clip: clip("say1", 17, 47),
            focus: CARD,
            bg: false,
            hold: 0.35,
            cam: [
              { t: 0, cx: 585, cy: 1245, w: 1120 },
              { t: 1, cx: 585, cy: 1230, w: 1010, ease: "out" },
            ],
          },

          // ③ 결과 ① — 박스 스크램블에서 탈취 → 역습 → 골. 뒤로 갈수록 느려지며 펀치인.
          // ⚠️ f-071 은 파티클이 이미 사그라든 뒤라 정지 화면이 밋밋했다 → f-070 에서 얼린다.
          // R2 감속: 57프레임 / play 2.80s. 초반 기울기만 편 것이라 감속 성질은 그대로다.
          {
            d: D(T.a1, T.s2),
            clip: clip("steal", 14, 70),
            hold: HOLD,
            ramp: [
              [0, 0],
              [0.44, 0.48],
              [0.8, 0.84],
              [1, 1],
            ],
            cam: [
              { t: 0, cx: 1050, cy: 690, w: WIDE },
              { t: 0.52, cx: 1060, cy: 694, w: 990, ease: "out" },
              { t: 1, cx: GOAL_STEAL.cx, cy: GOAL_STEAL.cy, w: TIGHT, ease: "out" },
            ],
          },

          // ④ 지시 ② (수비 축) — R3: 빈 카드(f-016) 정지 + 문구 합성.
          //    카메라 키프레임은 컷②(say1)와 **동일**하게 둔다 — 두 지시 컷은 대구(對句)라
          //    구도가 어긋나면 바로 보인다.
          {
            d: D(T.s2, T.a2),
            clip: still("seq/say-captain/f-016.webp", 1170, 2532),
            focus: CARD,
            bg: false,
            hold: 0.35,
            cam: [
              { t: 0, cx: 585, cy: 1245, w: 1120 },
              { t: 1, cx: 585, cy: 1230, w: 1010, ease: "out" },
            ],
          },

          // ⑤ 결과 ② — 끊고 역습해서 골. (같은 이유로 f-059 에서 얼린다.)
          {
            d: D(T.a2, T.col),
            clip: clip("tackle", 14, 59),
            hold: HOLD,
            ramp: [
              [0, 0],
              [0.44, 0.48],
              [0.8, 0.84],
              [1, 1],
            ],
            cam: [
              { t: 0, cx: 1000, cy: 680, w: WIDE },
              { t: 0.5, cx: 1050, cy: 676, w: 970, ease: "out" },
              { t: 1, cx: GOAL_TACKLE.cx, cy: GOAL_TACKLE.cy, w: TIGHT, ease: "out" },
            ],
          },

          // ⑥ 수집 축 — 실제 뽑기 결과 화면(켄번즈)
          {
            d: D(T.col, T.cta),
            clip: still("shots/76-reveal-all.webp", 780, 1688),
            bg: false,
            cam: [
              { t: 0, cx: 390, cy: 840, w: 830 },
              { t: 1, cx: 390, cy: 790, w: 730, ease: "linear" },
            ],
          },

          // ⑦ CTA
          { d: D(T.cta, T.end), blank: "#05070a" },
        ],
      },
    ],

    overlays: [
      // 훅 2비트
      {
        from: 0.18,
        to: 0.86,
        text: "말 한마디로",
        y: 1080,
        size: 74,
        color: "#cfe0ff",
        anim: "rise",
        outAnim: "up",
        style: { fontWeight: "800", letterSpacing: "-.02em" },
      },
      {
        from: 0.8,
        to: 1.6,
        text: "골이 터진다",
        y: 1170,
        size: 132,
        anim: "slam",
        inDur: 0.16,
        style: { fontWeight: "900" },
      },

      // 인과 라벨 (지시/결과 배지) — 각자 자기 컷 안에서만 산다.
      pill(T.s1 + 0.12, T.a1 - 0.1, "① 선수에게 말한다", "#2b5cff"), // 1.72 – 3.40
      pill(T.a1 + 0.12, T.a1 + 1.6, "② 그대로 뛴다", "#35c86a"), // 3.62 – 5.10
      pill(T.s2 + 0.12, T.a2 - 0.1, "① 이번엔 수비를 시킨다", "#2b5cff"), // 6.82 – 8.50
      pill(T.a2 + 0.12, T.a2 + 1.6, "② 끊고, 역습", "#35c86a"), // 8.72 – 10.20

      // 지시② 카드 합성 레이어 (R3)
      sayOverlay,

      // 골 순간 강조 — 결과 컷의 정지(hold) 시작에 슬램, 컷 끝까지 유지.
      {
        from: G1,
        to: T.s2,
        text: "GOAL",
        y: 640,
        size: 120,
        color: "#fff",
        anim: "slam",
        inDur: 0.12,
        style: { fontWeight: "900", letterSpacing: ".06em" },
      },
      {
        from: G2,
        to: T.col,
        text: "GOAL",
        y: 640,
        size: 120,
        color: "#fff",
        anim: "slam",
        inDur: 0.12,
        style: { fontWeight: "900", letterSpacing: ".06em" },
      },

      // 수집 컷 — ⚠️ 카드 아트가 밝아서 그라디언트 스크림으로는 흰 글씨가 안 읽혔다(실캡처 확인).
      //           반투명 그라디언트를 키우는 대신 **불투명 플레이트**로 바꿨다.
      {
        from: T.col + 0.08,
        to: T.cta,
        y: 1560,
        w: 1000,
        size: 52,
        anim: "rise",
        inDur: 0.16,
        html:
          '<span style="display:inline-block;padding:20px 36px;border-radius:16px;background:rgba(5,8,13,.94);' +
          'border:1px solid rgba(255,255,255,.12);color:#eaf1ff;font-weight:900;letter-spacing:-.02em">' +
          "선수를 모으고, 한 명씩 말을 건다</span>",
      },

      // CTA — 컷 2.30s. 타이틀 +.10 / 서브 +.50 / 버튼 +.95 (버튼 노출 1.35s).
      {
        from: T.cta + 0.1,
        to: T.end,
        text: "HMB 온라인",
        y: 760,
        size: 126,
        anim: "pop",
        stagger: 0.036,
        charDur: 0.26,
        style: { fontWeight: "900" },
      },
      {
        from: T.cta + 0.5,
        to: T.end,
        text: "선수에게 말을 걸면, AI가 그대로 뛴다",
        y: 960,
        size: 50,
        color: "#93a9c9",
        anim: "rise",
        style: { fontWeight: "700" },
      },
      {
        from: T.cta + 0.95,
        to: T.end,
        y: 1140,
        w: 760,
        size: 46,
        anim: "slam",
        inDur: 0.2,
        html:
          '<span style="display:inline-block;padding:22px 54px;border-radius:999px;background:#2b5cff;' +
          'color:#fff;font-weight:900;box-shadow:0 18px 50px rgba(43,92,255,.45)">지금, 감독이 되어라</span>',
      },
      // CTA 배경 광선 — 다크 딥이 걷히는 타이밍에 맞춰 들어온다.
      {
        from: T.cta + 0.02,
        to: T.end,
        y: 0,
        w: 1080,
        size: 1,
        anim: "fade",
        inDur: 0.5,
        html:
          '<div style="position:absolute;left:0;top:0;width:1080px;height:1920px;' +
          'background:radial-gradient(60% 34% at 50% 44%,rgba(43,92,255,.34) 0%,rgba(43,92,255,0) 70%)"></div>',
        style: { pointerEvents: "none" },
      },
    ],

    fx,
    onTick: paintSayCard,
  };

  return new Show(opt);
}

/**
 * 이 쇼가 참조하는 소재 경로 전부(중복 제거·정렬). `splash-assets.test.ts` 가
 * `public/splash/**` 실물과 대조하는 **단일 출처**다 — 목록을 손으로 또 적지 마라.
 */
export function adShowAssetPaths(): string[] {
  const out = new Set<string>();
  for (const pane of createAdShow().panes) {
    for (const cut of pane.cuts) {
      for (const f of cut.clip?.files ?? []) out.add(f);
    }
  }
  return [...out].sort();
}
