// 카드 프레임 합성 — ref-2 실측 규격(226×425, 금테 7px, 밴드 배치).
// 한글 텍스트(이름/설명)는 파이프라인이 그리지 않는다 — 게임 UI(React)가 실제 폰트로 오버레이한다.
// 여기서는 프레임·아트·밴드·별·포지션 뱃지까지만 만든다(폰트 임베딩 없이 결정론 유지).
import { img, blit, fillRect, blendRect, setPx, hex2rgb, shade, fitCanvas } from './img.mjs';

// ref-2 원본 재실측(카드 원점 x=22, y=300 좌측 가로스캔):
//   local x0 = 어두운 금(#5f3e16) 1px / x1..x7 = 금 밴드 7px / x8 = 안쪽 베벨 / x9+ = 내부
// → 인셋 ≈ 9~10px. measurements.ref103.json 의 ref2_frame_scan_y300(x17-33)은
//   절대좌표라 카드 밖 글로우 5px 를 포함하고 있어 인셋이 17px 로 과대 측정됐다(#103 이슈 레이즈 대상).
export const CARD = {
  w: 226, h: 425,
  bevelOuter: 1, gold: 7, bevelInner: 2, // 합 10px 인셋
  get inset() { return this.bevelOuter + this.gold + this.bevelInner; },
  artBottom: 331,   // 카드 상단 ~78% (331/425 = 77.9%)
  nameY: 330, nameH: 32,
  starsY: 362, starsH: 24,
  descY: 386,       // 설명판 = 별 밴드 아래부터 하단 프레임까지 꽉 채움(ref-2)
};

export const POS_COLOR = { FW: '#f17869', MF: '#57b775', DF: '#0b90d8', GK: '#fce148' };
const GOLD_HI = hex2rgb('#ffdb4a'), GOLD = hex2rgb('#e4991c'), GOLD_DEEP = hex2rgb('#8b6227');
const PLATE = hex2rgb('#0e100f'), STAR = hex2rgb('#d9a01e'), STAR_HI = hex2rgb('#f8e8a0');

// 3×5 비트맵 폰트 — 포지션 뱃지(FW/MF/DF/GK)용 최소 글리프.
const FONT = {
  F: ['111', '100', '111', '100', '100'],
  W: ['101', '101', '101', '111', '101'],
  M: ['101', '111', '111', '101', '101'],
  D: ['110', '101', '101', '101', '110'],
  G: ['111', '100', '101', '101', '111'],
  K: ['101', '101', '110', '101', '101'],
};

function drawText(dst, text, x, y, scale, color) {
  let cx = x;
  for (const ch of text) {
    const g = FONT[ch];
    if (!g) { cx += 4 * scale; continue; }
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 3; c++)
        if (g[r][c] === '1')
          fillRect(dst, cx + c * scale, y + r * scale, scale, scale, [...color, 255]);
    cx += 4 * scale;
  }
}

const STAR9 = [
  '....X....', '...XXX...', '...XXX...', 'XXXXXXXXX', '.XXXXXXX.',
  '..XXXXX..', '..XXXXX..', '.XX...XX.', 'XX.....XX',
];

function drawStar(dst, x, y, scale) {
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      if (STAR9[r][c] === 'X')
        fillRect(dst, x + c * scale, y + r * scale, scale, scale, [...(r < 4 ? STAR_HI : STAR), 255]);
}

/**
 * @param art  전신 도트 이미지 (투명배경)
 * @param meta { position, stars, signature:[r,g,b], frame:[r,g,b] }
 */
export function composeCard(art, meta) {
  const { w, h, inset } = CARD;
  const o = img(w, h);
  const sig = meta.signature, frame = meta.frame || sig;

  // 1) 아트 배경 = 시그니처 hue 의 어두운 오라(위→아래 그라디언트)
  for (let y = 0; y < h; y++) {
    const t = y / h;
    // 어두운 캐릭터가 묻히지 않게 오라는 충분히 어둡게(파일럿 실측: 0.16+ 이면 라그나가 배경과 동화).
    const c = shade(sig, 0.09 + 0.07 * (1 - t));
    fillRect(o, 0, y, w, 1, [...c, 255]);
  }

  // 2) 아트 배치 (아트 영역 안에 맞춰 바닥 정렬)
  const aw = w - inset * 2, ah = CARD.artBottom - inset;
  blit(o, fitCanvas(art, aw, ah, { alignY: 'bottom' }), inset, inset);

  // 3) 하단 밴드: 네임플레이트 / 별 / 설명판 (텍스트는 게임 UI 가 얹는다)
  //    반투명 밴드는 blendRect 로 합성한다 — fillRect 는 덮어쓰기라 반투명 알파가 산출물에 남는다.
  blendRect(o, inset, CARD.nameY, w - inset * 2, CARD.nameH, [...PLATE, 240]);
  fillRect(o, inset, CARD.nameY, w - inset * 2, 1, [...GOLD_DEEP, 255]);
  blendRect(o, inset, CARD.descY, w - inset * 2, h - inset - CARD.descY, [...shade(PLATE, 1.4), 235]);
  fillRect(o, inset, CARD.descY - 1, w - inset * 2, 1, [...GOLD_DEEP, 255]); // 별 밴드 하단 구분선

  // 4) 별
  const n = Math.max(1, Math.min(6, meta.stars || 5));
  const sw = 9 * 2 + 3;
  let sx = Math.round((w - (n * sw - 3)) / 2);
  for (let i = 0; i < n; i++) { drawStar(o, sx, CARD.starsY + 3, 2); sx += sw; }

  // 5) 설명판 좌측 원형 아이콘 (시그니처 색) — 설명판 내부 높이에 맞춘 최대 크기.
  const panelH = h - inset - CARD.descY;
  const ic = Math.floor((panelH - 4) / 2);
  const icx = inset + ic + 4, icy = CARD.descY + Math.floor(panelH / 2);
  for (let y = -ic; y <= ic; y++)
    for (let x = -ic; x <= ic; x++) {
      const d = Math.sqrt(x * x + y * y);
      if (d <= ic - 3) setPx(o, icx + x, icy + y, [...shade(sig, 0.55), 255]);
      else if (d <= ic - 1) setPx(o, icx + x, icy + y, [...GOLD, 255]);
    }

  // 6) 프레임 (바깥→안쪽 4개 띠)
  // ref-2 는 프레임 본체가 **시그니처 hue** 이고 금색은 코너·국소 하이라이트다
  //  (다중 행 스캔 결과 y=300 에만 금색, y=200/400 은 시그니처 계열).
  //  한 카드 = 한 색 원칙(SPEC §4)을 지키려면 금색을 사방에 두르면 안 된다.
  const bands = [
    [CARD.bevelOuter, shade(frame, 0.35)],
    [CARD.gold, null], // 시그니처 금속 그라디언트
    [CARD.bevelInner, shade(frame, 0.25)],
  ];
  let off = 0;
  for (const [thick, col] of bands) {
    for (let k = 0; k < thick; k++) {
      const i = off + k;
      const c = col || signatureMetal(frame, k, thick);
      ring(o, i, [...c, 255]);
    }
    off += thick;
  }
  // 코너 금속 장식 — 금색은 여기서만(ref-2 의 코너 세공)
  const cl = 26;
  for (let k = 0; k < CARD.gold; k++) {
    const i = CARD.bevelOuter + k;
    const c = goldMetal(k, CARD.gold);
    for (let t = 0; t < cl; t++) {
      fillRect(o, i + t, i, 1, 1, [...c, 255]);
      fillRect(o, w - 1 - i - t, i, 1, 1, [...c, 255]);
      fillRect(o, i + t, h - 1 - i, 1, 1, [...c, 255]);
      fillRect(o, w - 1 - i - t, h - 1 - i, 1, 1, [...c, 255]);
      fillRect(o, i, i + t, 1, 1, [...c, 255]);
      fillRect(o, i, h - 1 - i - t, 1, 1, [...c, 255]);
      fillRect(o, w - 1 - i, i + t, 1, 1, [...c, 255]);
      fillRect(o, w - 1 - i, h - 1 - i - t, 1, 1, [...c, 255]);
    }
  }

  // 7) 포지션 뱃지 (좌상단, 프레임 위)
  const pc = hex2rgb(POS_COLOR[meta.position] || POS_COLOR.MF);
  const bw = 34, bh = 18, bx = 8, by = 8;
  fillRect(o, bx, by, bw, bh, [...shade(pc, 0.28), 255]);
  ringRect(o, bx, by, bw, bh, [...GOLD, 255]);
  drawText(o, meta.position || 'MF', bx + 6, by + 4, 2, pc);

  return o;
}

const goldMetal = (k, thick) => {
  const t = k / Math.max(1, thick - 1);
  return t < 0.35 ? GOLD_HI : t < 0.75 ? GOLD : GOLD_DEEP;
};

/** 시그니처 색의 금속 그라디언트 — 바깥이 밝고 안쪽이 어둡다. */
const signatureMetal = (frame, k, thick) => {
  const t = k / Math.max(1, thick - 1);
  return shade(frame, 1.35 - 0.75 * t);
};

function ring(s, i, c) {
  fillRect(s, i, i, s.width - i * 2, 1, c);
  fillRect(s, i, s.height - i - 1, s.width - i * 2, 1, c);
  fillRect(s, i, i, 1, s.height - i * 2, c);
  fillRect(s, s.width - i - 1, i, 1, s.height - i * 2, c);
}

function ringRect(s, x, y, w, h, c) {
  fillRect(s, x, y, w, 1, c); fillRect(s, x, y + h - 1, w, 1, c);
  fillRect(s, x, y, 1, h, c); fillRect(s, x + w - 1, y, 1, h, c);
}
