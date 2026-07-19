// RGBA 이미지 연산 — 순수 함수, 부동소수 난수 없음(결정론).
// 이미지 = { width, height, data: Uint8Array(w*h*4) }

export const img = (width, height, fill = [0, 0, 0, 0]) => {
  const data = new Uint8Array(width * height * 4);
  if (fill[3] !== 0) for (let i = 0; i < width * height; i++) data.set(fill, i * 4);
  return { width, height, data };
};

export const clone = (s) => ({ width: s.width, height: s.height, data: new Uint8Array(s.data) });

export const px = (s, x, y) => {
  const o = (y * s.width + x) * 4;
  return [s.data[o], s.data[o + 1], s.data[o + 2], s.data[o + 3]];
};

export const setPx = (s, x, y, c) => {
  if (x < 0 || y < 0 || x >= s.width || y >= s.height) return;
  s.data.set(c, (y * s.width + x) * 4);
};

export const hex2rgb = (h) => {
  const v = parseInt(h.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
export const rgb2hex = ([r, g, b]) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** 알파 위에 src 를 블렌딩(src-over). */
export function blit(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const X = dx + x, Y = dy + y;
      if (X < 0 || Y < 0 || X >= dst.width || Y >= dst.height) continue;
      const so = (y * src.width + x) * 4, a = src.data[so + 3];
      if (a === 0) continue;
      const dofs = (Y * dst.width + X) * 4;
      if (a === 255) { dst.data.set(src.data.subarray(so, so + 4), dofs); continue; }
      const da = dst.data[dofs + 3];
      const oa = a + (da * (255 - a)) / 255;
      for (let c = 0; c < 3; c++) {
        dst.data[dofs + c] = Math.round(
          (src.data[so + c] * a + dst.data[dofs + c] * da * (255 - a) / 255) / oa,
        );
      }
      dst.data[dofs + 3] = Math.round(oa);
    }
  }
}

export function fillRect(s, x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(s, x, y, c);
}

export function crop(s, x0, y0, w, h) {
  const o = img(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x0 + x, sy = y0 + y;
      if (sx < 0 || sy < 0 || sx >= s.width || sy >= s.height) continue;
      o.data.set(s.data.subarray((sy * s.width + sx) * 4, (sy * s.width + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return o;
}

/** 박스 평균 다운스케일(프리멀티플라이드). 업스케일이면 nearest 로 폴백. */
export function resize(s, w, h) {
  if (w >= s.width && h >= s.height) return nearest(s, w, h);
  const o = img(w, h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * s.height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * s.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * s.width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * s.width) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const so = (sy * s.width + sx) * 4, sa = s.data[so + 3];
          r += s.data[so] * sa; g += s.data[so + 1] * sa; b += s.data[so + 2] * sa;
          a += sa; n++;
        }
      }
      const oo = (y * w + x) * 4;
      if (a === 0) continue;
      o.data[oo] = Math.round(r / a); o.data[oo + 1] = Math.round(g / a); o.data[oo + 2] = Math.round(b / a);
      o.data[oo + 3] = Math.round(a / n);
    }
  }
  return o;
}

export function nearest(s, w, h) {
  const o = img(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(s.height - 1, Math.floor((y * s.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(s.width - 1, Math.floor((x * s.width) / w));
      o.data.set(s.data.subarray((sy * s.width + sx) * 4, (sy * s.width + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return o;
}

/** 안티에일리어싱 제거 — 픽셀아트 규격(하드 엣지). */
export function hardAlpha(s, threshold = 128) {
  const o = clone(s);
  for (let i = 3; i < o.data.length; i += 4) o.data[i] = o.data[i] >= threshold ? 255 : 0;
  return o;
}

/**
 * 배경 제거: 이미 알파가 있으면 그대로, 없으면 모서리 색에서 flood fill.
 * tol = 0~255 유클리드 거리 임계.
 */
export function removeBackground(s, tol = 40) {
  let transparent = 0;
  for (let i = 3; i < s.data.length; i += 4) if (s.data[i] < 250) transparent++;
  if (transparent > s.width * s.height * 0.05) return clone(s); // 이미 투명 배경

  const o = clone(s);
  const { width: w, height: h } = s;
  const seen = new Uint8Array(w * h);
  const stack = [];
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  const refs = corners.map(([x, y]) => px(s, x, y));
  for (const [x, y] of corners) stack.push(y * w + x);
  const near = (c) => refs.some((r) => (c[0] - r[0]) ** 2 + (c[1] - r[1]) ** 2 + (c[2] - r[2]) ** 2 <= tol * tol);

  while (stack.length) {
    const i = stack.pop();
    if (seen[i]) continue;
    seen[i] = 1;
    const x = i % w, y = (i / w) | 0;
    if (!near(px(s, x, y))) continue;
    o.data[i * 4 + 3] = 0;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  return o;
}

/** 불투명 픽셀의 바운딩 박스로 크롭 + 여백(비율) 부여. */
export function trim(s, padRatio = 0) {
  let x0 = s.width, y0 = s.height, x1 = -1, y1 = -1;
  for (let y = 0; y < s.height; y++)
    for (let x = 0; x < s.width; x++)
      if (s.data[(y * s.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  if (x1 < 0) return clone(s);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const pad = Math.round(Math.max(w, h) * padRatio);
  return crop(s, x0 - pad, y0 - pad, w + pad * 2, h + pad * 2);
}

/** 정사각 캔버스에 가운데(가로) / 지정 정렬(세로)로 넣기. */
export function fitCanvas(s, w, h, { alignY = 'center' } = {}) {
  const scale = Math.min(w / s.width, h / s.height);
  const nw = Math.max(1, Math.round(s.width * scale)), nh = Math.max(1, Math.round(s.height * scale));
  const r = resize(s, nw, nh);
  const o = img(w, h);
  const dy = alignY === 'bottom' ? h - nh : alignY === 'top' ? 0 : Math.round((h - nh) / 2);
  blit(o, r, Math.round((w - nw) / 2), dy);
  return o;
}

/** 원형 마스크 + 팀 링. d = 지름(=출력 크기). stroke 는 지름의 4.5%(ref-1 실측). */
export function circleWithRing(s, d, ringHex) {
  const stroke = Math.max(1, Math.round(d * 0.045));
  const o = img(d, d);
  const c = (d - 1) / 2;
  const rOuter = d / 2;
  const rInner = rOuter - stroke;
  const ring = ringHex ? hex2rgb(ringHex) : null;
  for (let y = 0; y < d; y++) {
    for (let x = 0; x < d; x++) {
      const dist = Math.sqrt((x - c) ** 2 + (y - c) ** 2);
      if (dist > rOuter - 0.5) continue;
      if (ring && dist > rInner - 0.5) { setPx(o, x, y, [...ring, 255]); continue; }
      const p = px(s, Math.min(s.width - 1, x), Math.min(s.height - 1, y));
      setPx(o, x, y, p[3] === 0 ? [12, 17, 23, 255] : p); // 링 안쪽 빈 곳은 서피스로 채움
    }
  }
  return o;
}

/**
 * 시그니처 색 자동 추출 — "카드 프레임/오라에 쓸 대표 강조색".
 * 단순 최빈색은 어두운 의상·그림자를 고르므로(파일럿 실측: 아우라→#675638),
 * 채도와 중간 명도에 가중치를 준 히스토그램으로 고른다. 결정론(동률 tie-break 고정).
 */
export function dominantColor(s) {
  const bins = new Map();
  for (let i = 0; i < s.data.length; i += 4) {
    if (s.data[i + 3] < 200) continue;
    const r = s.data[i], g = s.data[i + 1], b = s.data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const chroma = mx - mn;
    if (chroma < 45 || mx < 70) continue; // 무채색·너무 어두운 것 제외
    const L = (mx + mn) / 2 / 255;
    const w = (chroma / 255) * Math.max(0.05, 1 - Math.abs(L - 0.55) * 1.8);
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = bins.get(k) || [0, 0, 0, 0, 0];
    e[0] += r * w; e[1] += g * w; e[2] += b * w; e[3] += w; e[4]++;
    bins.set(k, e);
  }
  if (!bins.size) return [128, 128, 128];
  const best = [...bins.entries()].sort((a, b) => b[1][3] - a[1][3] || a[0] - b[0])[0][1];
  return normalizeAccent([
    Math.round(best[0] / best[3]), Math.round(best[1] / best[3]), Math.round(best[2] / best[3]),
  ]);
}

/** 강조색으로 쓸 수 있게 명도·채도를 정규화(hue 유지). 어두운 의상색이 뽑혀도 악센트로 쓰인다. */
export function normalizeAccent([r, g, b]) {
  const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
  const L = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return [r, g, b];
  const S = L > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  const R = r / 255, G = g / 255, B = b / 255;
  if (mx === R) h = ((G - B) / d + (G < B ? 6 : 0)) / 6;
  else if (mx === G) h = ((B - R) / d + 2) / 6;
  else h = ((R - G) / d + 4) / 6;
  const L2 = Math.min(0.62, Math.max(0.45, L));
  const S2 = Math.min(0.9, Math.max(0.5, S));
  const q = L2 < 0.5 ? L2 * (1 + S2) : L2 + S2 - L2 * S2;
  const p = 2 * L2 - q;
  const hue = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((v) => Math.round(v * 255));
}

export const shade = ([r, g, b], f) => [
  Math.max(0, Math.min(255, Math.round(r * f))),
  Math.max(0, Math.min(255, Math.round(g * f))),
  Math.max(0, Math.min(255, Math.round(b * f))),
];
