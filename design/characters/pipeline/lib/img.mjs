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

/** 덮어쓰기 채우기(알파 포함 그대로 기록). 반투명 합성이 필요하면 blendRect 를 쓸 것. */
export function fillRect(s, x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(s, x, y, c);
}

/** src-over 합성 채우기 — 반투명 밴드용(fillRect 는 덮어쓰기라 반투명이 그대로 남는다). */
export function blendRect(s, x0, y0, w, h, [r, g, b, a]) {
  const A = a / 255;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= s.width || y >= s.height) continue;
      const o = (y * s.width + x) * 4;
      const da = s.data[o + 3] / 255;
      const oa = A + da * (1 - A);
      if (oa === 0) continue;
      s.data[o] = Math.round((r * A + s.data[o] * da * (1 - A)) / oa);
      s.data[o + 1] = Math.round((g * A + s.data[o + 1] * da * (1 - A)) / oa);
      s.data[o + 2] = Math.round((b * A + s.data[o + 2] * da * (1 - A)) / oa);
      s.data[o + 3] = Math.round(oa * 255);
    }
  }
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
 * 배경 제거. 이미 알파가 있으면 손대지 않는다(SPEC 권장 경로).
 *
 * 불투명 배경일 때는 **지역 기울기 영역확장(region growing)** 을 쓴다.
 * 이웃 픽셀과의 차로 전파하므로 완만한 배경 그라디언트는 따라가고 캐릭터 경계의
 * 급격한 색 점프에서 멈춘다.
 *
 * ⚠️ `localTol` 은 **절벽 파라미터**다. 어두운 배경 위 어두운 캐릭터에서
 * 8 이하는 캐릭터를 100% 보존하지만 10 이상은 급격히 잠식한다(라그나 portrait:
 * tol 8 → 최대덩어리 100%, tol 10 → 74%, tol 14 → 40%). 기본값은 절벽 이전으로 둔다.
 * 올리려면 반드시 `cutoutQuality` 로 손상을 확인할 것.
 *
 * @returns { image, stats } — stats 로 손상 여부를 상위(clean)에서 게이트한다.
 */
export function removeBackground(s, { localTol = 8, globalTol = 90 } = {}) {
  let transparent = 0;
  for (let i = 3; i < s.data.length; i += 4) if (s.data[i] < 250) transparent++;
  const hadAlpha = transparent > s.width * s.height * 0.02;
  if (hadAlpha) {
    return { image: clone(s), stats: { hadAlpha: true, removedPct: (100 * transparent) / (s.width * s.height) } };
  }

  const o = clone(s);
  const { width: w, height: h } = s;
  const seen = new Uint8Array(w * h);
  const stack = [];
  const seedAt = new Int32Array(w * h).fill(-1);
  const seeds = [];
  const pushSeed = (x, y) => {
    const i = y * w + x;
    seeds.push(px(s, x, y));
    seedAt[i] = seeds.length - 1;
    stack.push(i);
  };
  for (let x = 0; x < w; x++) { pushSeed(x, 0); pushSeed(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { pushSeed(0, y); pushSeed(w - 1, y); }

  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  let removed = 0;
  while (stack.length) {
    const i = stack.pop();
    if (seen[i]) continue;
    seen[i] = 1;
    const x = i % w, y = (i / w) | 0;
    const c = px(s, x, y);
    // 시드(이미지 테두리) 색에서 너무 멀어지면 중단 — 그라디언트를 타고 캐릭터로 새는 것 방지
    if (d2(c, seeds[seedAt[i]]) > globalTol * globalTol) continue;
    o.data[i * 4 + 3] = 0;
    removed++;
    const nb = [];
    if (x > 0) nb.push(i - 1);
    if (x < w - 1) nb.push(i + 1);
    if (y > 0) nb.push(i - w);
    if (y < h - 1) nb.push(i + w);
    for (const j of nb) {
      if (seen[j]) continue;
      const nx = j % w, ny = (j / w) | 0;
      if (d2(c, px(s, nx, ny)) > localTol * localTol) continue; // 급격한 색 점프 = 캐릭터 경계
      if (seedAt[j] < 0) seedAt[j] = seedAt[i];
      stack.push(j);
    }
  }
  return { image: o, stats: { hadAlpha: false, removedPct: (100 * removed) / (w * h) } };
}

/**
 * 컷아웃 품질 측정 — 배경 제거가 캐릭터를 먹었는지 자동 판별한다.
 * 정상 컷아웃은 큰 덩어리 1~2개. 캐릭터가 잠식되면 파편이 수십 개로 흩어지고
 * 몸통 내부에 구멍이 생긴다. (검증 실측: 라그나는 어떤 tolerance 에서도 파편화)
 * @returns { opaquePct, components, largestShare, holes }
 */
export function cutoutQuality(s) {
  const { width: w, height: h } = s;
  const n = w * h;
  const op = (i) => s.data[i * 4 + 3] > 8;
  const label = new Int32Array(n).fill(-1);
  let components = 0, largest = 0, opaque = 0;
  for (let i = 0; i < n; i++) if (op(i)) opaque++;
  for (let start = 0; start < n; start++) {
    if (label[start] >= 0 || !op(start)) continue;
    let size = 0;
    const stack = [start];
    label[start] = components;
    while (stack.length) {
      const i = stack.pop();
      size++;
      const x = i % w, y = (i / w) | 0;
      const nb = [];
      if (x > 0) nb.push(i - 1);
      if (x < w - 1) nb.push(i + 1);
      if (y > 0) nb.push(i - w);
      if (y < h - 1) nb.push(i + w);
      for (const j of nb) if (label[j] < 0 && op(j)) { label[j] = components; stack.push(j); }
    }
    if (size > largest) largest = size;
    components++;
  }
  // 구멍 = 테두리와 연결되지 않은 투명 영역
  const seenT = new Uint8Array(n);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x); stack.push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { stack.push(y * w); stack.push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    if (seenT[i] || op(i)) continue;
    seenT[i] = 1;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  let holes = 0;
  for (let i = 0; i < n; i++) if (!op(i) && !seenT[i]) holes++;
  return {
    opaquePct: (100 * opaque) / n,
    components,
    largestShare: opaque ? largest / opaque : 0,
    holes,
  };
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
  if (s.width !== d || s.height !== d) s = resize(s, d, d); // 소스 크기 가정 방지(조용한 크롭 금지)
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
      setPx(o, x, y, p[3] === 0 ? [11, 17, 23, 255] : p); // 링 안쪽 빈 곳 = 배경 root #0b1117
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
