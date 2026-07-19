// 팔레트 양자화 — median cut. 결정론(난수 없음, 모든 정렬에 tie-break 키).
import { clone } from './img.mjs';

/** 불투명 픽셀에서 n색 팔레트 추출. */
export function medianCut(s, n) {
  const pixels = [];
  for (let i = 0; i < s.data.length; i += 4) {
    if (s.data[i + 3] < 128) continue;
    pixels.push([s.data[i], s.data[i + 1], s.data[i + 2]]);
  }
  if (!pixels.length) return [[0, 0, 0]];
  let boxes = [pixels];
  while (boxes.length < n) {
    // 가장 넓은 범위를 가진 박스를 쪼갠다 (동률이면 인덱스 낮은 쪽 = 결정론)
    let bi = -1, bspread = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const sp = spread(boxes[i]);
      if (sp.range > bspread) { bspread = sp.range; bi = i; }
    }
    if (bi < 0) break;
    const box = boxes[bi];
    const ch = spread(box).channel;
    box.sort((a, b) => a[ch] - b[ch] || a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes
    .filter((b) => b.length)
    .map((b) => {
      const sum = b.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
      return sum.map((v) => Math.round(v / b.length));
    })
    .sort((a, b) => lum(a) - lum(b) || a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function spread(box) {
  const mn = [255, 255, 255], mx = [0, 0, 0];
  for (const p of box)
    for (let c = 0; c < 3; c++) { if (p[c] < mn[c]) mn[c] = p[c]; if (p[c] > mx[c]) mx[c] = p[c]; }
  // 채널별 범위에 지각 가중치
  const w = [0.3, 0.59, 0.11];
  let channel = 0, range = -1;
  for (let c = 0; c < 3; c++) {
    const r = (mx[c] - mn[c]) * w[c];
    if (r > range) { range = r; channel = c; }
  }
  return { channel, range };
}

/** 팔레트로 매핑(디더링 없음 — 픽셀아트는 플랫 면이 정답). */
export function applyPalette(s, palette) {
  const o = clone(s);
  const cache = new Map();
  for (let i = 0; i < o.data.length; i += 4) {
    if (o.data[i + 3] < 128) { o.data[i + 3] = 0; continue; }
    o.data[i + 3] = 255;
    const key = (o.data[i] << 16) | (o.data[i + 1] << 8) | o.data[i + 2];
    let best = cache.get(key);
    if (best === undefined) {
      let bd = Infinity;
      for (let k = 0; k < palette.length; k++) {
        const p = palette[k];
        // 지각 가중 거리
        const d = 0.3 * (p[0] - o.data[i]) ** 2 + 0.59 * (p[1] - o.data[i + 1]) ** 2 + 0.11 * (p[2] - o.data[i + 2]) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      cache.set(key, best);
    }
    o.data.set(palette[best], i);
  }
  return o;
}

export const quantize = (s, n) => applyPalette(s, medianCut(s, n));
